# Adapting the DFlash draft to this domain

`DFLASH.md` ends with the honest admission that draft adaptation was **not run**,
and states the hypothesis it was waiting on:

> A drafter adapted to Luau game mechanics should achieve a higher accepted block
> length on that domain than the general-purpose released drafter, because the
> domain is narrow and highly patterned.

This is that experiment. It was run, and the hypothesis **holds**: adapting the
drafter on 787 of this system's own generations raised accepted length from 2.17
to 2.44 and acceptance from 14.6% to 18.0%. It did **not** make generation
faster, which is the more interesting half of the result.

## Result

Held-out traces the drafter never trained on, scored offline (see *The offline
instrument* below):

| | accepted length | per-position top-1 match |
| --- | --- | --- |
| released `z-lab/gpt-oss-20b-DFlash` | **2.120** | .653 .477 .364 .296 .233 .181 .144 |
| adapted, 6 epochs on 728 traces | **2.244** | .688 .517 .395 .321 .268 .217 .181 |

Live, through the repo's own instrument (`npx tsx src/train/speculation.ts`,
appended to `data/speculation.jsonl`):

| | accepted length | acceptance | tok/s |
| --- | --- | --- | --- |
| released draft (first run, recorded earlier) | 2.23 | 15.4% | 139.6 |
| released draft (re-measured today) | 2.17 | 14.6% | 209.2 |
| **adapted draft** | **2.44** | **18.0%** | **212.1** |

Per-position accepted counts, released → adapted:

```
  released  518 -> 276 -> 134 -> 72 -> 48 -> 32 -> 15 -> 8
  adapted   506 -> 300 -> 169 -> 79 -> 57 -> 41 -> 33 -> 20
```

The adapted drafter is slightly *worse* at position 1 and better everywhere
after it, and the tail is where it gains most — 15→33 and 8→20 at positions 7
and 8. That is the shape you want: the drafter is staying on the target's
trajectory for longer rather than getting the easy first token right more often.

The last two rows were measured on the **same endpoint, same GPU, same
`--gpu-memory-utilization 0.80`, same flags**, differing only in
`--spec-model`. That symmetry cost the 8002 server about twelve minutes of
downtime and is the reason the comparison is worth anything.

**Throughput did not follow.** 209.2 → 212.1 tok/s is inside the noise, while
accepted length moved 12%. This is the clearest confirmation yet of the argument
in `DFLASH.md`: on a GPU that is not starved for bandwidth, the verification
step is not the bottleneck, so buying more accepted tokens per verify does not
buy time. The adaptation worked and the speedup still did not materialise.

**Read the gain against the noise, not against zero.** The same released drafter,
same server, same eight prompts, measured twice: 2.23 and 2.17 accepted, at
139.6 and 209.2 tok/s. So accepted length carries roughly ±0.06 of run-to-run
noise and throughput swings ~50%, because the box is shared with three other
model servers. The adapted drafter's +0.27 over the same-day released
measurement is about four times that noise, and the offline held-out gain points
the same way, so the effect is real. The throughput non-result is *within* the
noise and should be read as "no change", not as a small gain.

## What was actually done

**Training data.** 787 traces from the target itself at `100.79.153.43:8000`,
temperature 0.7, 512 max tokens, from 197 generated Luau game-mechanic prompts
(≈403k target tokens, 3840 held-out blocks). `data/draft-traces.jsonl` now holds
1650 rows because a second 856-prompt batch finished after extraction had already
run; **only the first 788 were used**, and that second batch is unused data that
cost the shared target server real time. Two properties matter:

- vLLM's `return_token_ids: true` gives back the exact `prompt_token_ids` and
  `token_ids` it emitted. Those exact ids are what get replayed for hidden-state
  extraction, so the harmony channel markers, the chat template and the reasoning
  block are byte-identical between generation and training. Re-tokenising the
  text instead would have trained the drafter on a sequence the server never
  produces.
- **The eight prompts `speculation.ts` measures on are held out of the prompt
  generator entirely.** Training on the benchmark's own prompts would have
  produced a larger and meaningless number.

**Hidden states.** DFlash's drafter reads the target's internals: the checkpoint
conditions on `target_layer_ids: [1, 6, 11, 16, 21]`, concatenated to 14400 and
projected to 2880 by `fc`. All 788 traces were replayed through `gpt-oss-20b`
with `output_hidden_states=True` — 496k tokens, 14.3 GB of bf16 features, 216 s.
The layer indexing is `hidden_states[layer_id + 1]`, because HF puts the
embedding output at index 0; vLLM's own DFlash path agrees, building its aux
layer list as `[i + 1 for i in dflash_config["target_layer_ids"]]`.

**Training objective.** z-lab publish the drafter but **not** the code that
trained it — the GitHub repo is inference only (`model.py`, `model_mlx.py`,
`benchmark.py`, `cli.py`). The objective was reconstructed from the checkpoint's
own `spec_generate` loop, which is the specification:

- context = target hidden states for positions `0 .. S-1`, through `fc` and
  `hidden_norm`, read as K/V by every draft layer
- queries = `embed([tok[S], MASK, MASK, ...])` at positions `S .. S+7`,
  attending to the whole context and **bidirectionally within their own block**
  (`is_causal = False` — this is the block-diffusion part)
- prediction = the last 7 query outputs through the **target's** `lm_head`
- loss = cross-entropy against the tokens the target actually emitted

Only the drafter trains. `lm_head` and `embed_tokens` belong to the target and
stay frozen, because at serving time the drafter does not own them.

The one liberty over the inference loop is packing: inference does one block per
forward, training puts every block of a sequence through in a single forward,
separated by an attention mask that gives block *b* the context `0 .. S_b - 1`
and no other block's queries. Same computation, ~60x fewer forwards.

## The offline instrument, and why it is trustworthy here

Serving a drafter to find out whether it improved costs a model load. So the
trainer scores the held-out split directly: per-position top-1 match against the
token the target actually produced, and `1 + Σ` of the cumulative products of
those rates — which is what acceptance *means*, since a block is accepted up to
its first mistake.

The reason to believe it: run on the **released** checkpoint it predicts an
accepted length of **2.120**, against a live measured **2.17–2.23**. A
reconstruction with the mask, the offset or the block layout wrong would not land
within noise of the real system — it would sit near 1.0. That agreement is the
main evidence that the objective above is the right objective.

It is a predictor, not the measurement. It scores against tokens the target
*sampled* at temperature 0.7, while `speculation.ts` decodes greedily.

## Truncation, and what the drafter is actually being trained on

**1641 of 1644 traces finish on `length`, not `stop`.** gpt-oss-20b reasons at
length before answering, and at a 512-token budget essentially every generation
is cut off mid-thought. Measured over the corpus by counting Harmony channel
markers: 1644/1644 traces open in the `analysis` channel, and only **56 of 1644
(3.4%) ever emit a second channel marker** at all. The corpus is, to a first
approximation, pure reasoning tokens.

That sounds like a defect and mostly is not, for one specific reason: **the
benchmark measures the same thing.** `speculation.ts` decodes at
`max_tokens: 256`, which on this model does not reach the answer channel either.
So the drafter is trained on reasoning-channel tokens and measured on
reasoning-channel tokens, and the composition matches. That is very likely why a
+0.12 offline gain transferred to +0.27 live rather than vanishing.

Two things follow, and both limit what this result claims:

- **The number on this page is acceptance over gpt-oss's reasoning stream**, not
  over Luau source. It is a legitimate workload measurement — reasoning tokens
  are what the model really emits and really has to be drafted — but a reader
  who assumes "Luau code completion got 12% more predictable" would be wrong.
- **Truncation itself is not corrupting.** Every token in a cut-off trace is
  still a genuine sample from the target given its own prefix, so the
  cross-entropy targets are valid; the corpus is missing answer-channel
  behaviour rather than containing wrong behaviour. If the serving path ever
  runs long enough to reach the answer channel, this drafter has never seen it
  and the traces should be regenerated at a budget near 1600.

## Why the gain is not larger, and what would move it

The per-epoch held-out curve flattens almost immediately:

```
  epoch    0      1      2      3      4      5
  accepted 2.194  2.221  2.227  2.238  2.243  2.244
```

Epochs 3→5 buy +0.006 in total. This is **data-limited, not compute-limited**.
403k tokens from 197 unique prompts is roughly a 2000th of the 800k samples the
released checkpoint was trained on, and by epoch 3 the drafter has extracted
what is in it. More epochs would only overfit; the trainer keeps the best
held-out epoch rather than the last for exactly that reason.

The three things that would plausibly matter more than anything tried here,
in order:

1. **More unique prompts.** Not more samples per prompt — the curve above is
   prompt-diversity-bound. An expanded 856-prompt corpus exists in
   `data/draft-traces.jsonl` but was never extracted or trained on; it landed
   after extraction and generating it loaded the shared target server enough to
   stall another agent's demo run. Cheap in GPU time, expensive in shared
   capacity — worth doing next, off-peak.
2. **Train at the temperature you serve at.** The traces are temperature 0.7,
   on the principle that a draft must predict the serving *distribution*. But
   `speculation.ts` decodes at `temperature: 0`. A drafter trained on greedy
   continuations is fitting a single deterministic sequence per prompt instead
   of a distribution, which is a far easier target and directly matches what is
   measured. This is not tuning the benchmark — it is aligning training with how
   the system actually decodes — and it is the single change most likely to
   produce a large gain.
3. **Accept that the hardware is wrong for this.** Speculation pays when the
   device is starved for bandwidth. An RTX PRO 6000 is not, which is why the
   released drafter made generation *slower*. Even a drafter at accepted length
   3 would be a marginal win here while being a large one on a GB10.

## Reproducing

On the rig (`ssh squaredcube1`, GPUs inside WSL). `$CUDA_HOME/bin` must be on
PATH — a missing `nvcc` silently breaks the Triton JIT that compiles the MXFP4
expert matmul.

```bash
# 1. traces from the target, at serving temperature, with exact token ids
#    (writes data/draft-traces.jsonl)

# 2+3. hidden states, then adaptation -- both as a Windows Scheduled Task,
#      because a job launched over SSH dies when the session ends and WSL
#      shuts down with it
schtasks /create /tn DFlashExtract /tr 'C:\Users\sarta\rig-dflash-extract.cmd' /sc once /st 00:00 /f
schtasks /run /tn DFlashExtract
schtasks /create /tn DFlashTrain /tr 'C:\Users\sarta\rig-dflash-traintask.cmd' /sc once /st 00:00 /f
schtasks /run /tn DFlashTrain
# both log to ~/robloxagent/dflash-train.log

# 4. serve the adapted drafter and measure with the repo's own instrument
schtasks /run /tn DFlashServeAdapted
PLACEBO_SPEC_URL=http://100.79.153.43:8004 \
PLACEBO_SPEC_MODEL=gpt-oss-spec-adapted npx tsx src/train/speculation.ts
```

Three things that cost real time and are not obvious:

- **`device_map=`, never `.to(device)`** when loading gpt-oss in MXFP4. A
  post-hoc `.to()` leaves packed weights and scale tensors on the CPU, and it
  surfaces much later as `Pointer argument cannot be accessed from Triton (cpu
  tensor?)` from inside the expert matmul.
- **`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` breaks vLLM under WSL**
  with `CUDA driver error: unknown error`. WDDM does not support the virtual
  memory API it relies on.
- **`nvidia-smi` inside WSL reports memory that is not real.** It showed all
  three GPUs at ~80/98 GB used; 60 GiB was allocatable on each at full
  300 TFLOP/s. Size jobs by trying, not by reading that number. It is still real
  enough to matter for vLLM, which refuses to start a fourth 20B instance with
  `No available memory for the cache blocks` at any `--gpu-memory-utilization`.
- **Only 8000/8002/8003 are reachable over Tailscale.** A server on 8004 comes up
  fine and is invisible from outside WSL, and `speculation.ts` reports it as
  `no speculative endpoint` rather than as a connection error. Measure on a port
  that already has a forwarding rule.

## Status

Adaptation is **run and measured**. The drafter improves on its own domain —
2.17 → 2.44 accepted length live, 14.6% → 18.0% acceptance, +0.12 offline on a
held-out split — on 787 traces and about 25 minutes of GPU time. The gain is
data-limited rather than compute-limited, and it does **not** change the
conclusion in `DFLASH.md` that speculation is the wrong trade on this GPU:
accepted length rose 12% and throughput did not move.

That combination is the honest summary. The hypothesis this repo wrote down was
right about the drafter and still wrong about the speedup, and the only reason
we can tell those two apart is that accepted length and throughput were recorded
as separate numbers in a series rather than collapsed into one claim.

The trained checkpoint is at `~/dflash-adapted` on the rig; the 8002 server was
restored to the released drafter afterwards.
