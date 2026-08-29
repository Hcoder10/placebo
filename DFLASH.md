# The draft model, and why adapting it comes last

Placebo serves gpt-oss-20b with [DFlash](https://arxiv.org/abs/2602.06036), a
block-diffusion speculative decoder. We use the released
[`z-lab/gpt-oss-20b-DFlash`](https://huggingface.co/z-lab/gpt-oss-20b-DFlash)
checkpoint. **We did not invent DFlash and we did not train a draft model from
scratch** — that is a multi-day job and claiming otherwise would not survive a
question from anyone who has done it.

What we *can* do, and what is genuinely worth measuring, is adapting that draft
to our post-trained target.

## What the checkpoint actually contains

From the released config:

```json
{
  "architectures": ["DFlashDraftModel"],
  "block_size": 8,
  "dflash_config": {
    "mask_token_id": 200000,
    "target_layer_ids": [1, 6, 11, 16, 21, ...]
  }
}
```

Two facts in there decide everything about the ordering of our work:

**`block_size: 8`** — the drafter proposes eight tokens in one forward pass, and
the target verifies them in a single weight read rather than eight. That is the
entire reason speculation helps on a bandwidth-bound device.

**`target_layer_ids`** — the drafter is *conditioned on hidden states pulled from
specific layers of the target model*. It is not a small independent language
model that happens to be fast. It is a model trained against a particular
target's internal representations.

## Which is why the order is not negotiable

Post-training the target shifts the very hidden states the drafter was aligned
to. A drafter adapted before that shift is aligned to a model that no longer
exists.

```
  1. post-train gpt-oss-20b on engine-labelled pairs   (LoRA adapters)
  2. freeze or merge the adapter
  3. regenerate target outputs AND hidden-state features from the new target
  4. adapt the DFlash drafter to those features
  5. measure accepted block length, before and after
```

Doing 4 before 1 measures the wrong thing. This ordering is the one piece of the
DFlash work we are confident about without having run it.

## The measurement worth making

Accepted block length is the number that matters — how many of the eight drafted
tokens survive verification on average. Throughput scales with it almost
directly, because it sets how many tokens come out per weight read.

Our hypothesis, stated so it can be wrong:

> A drafter adapted to Luau game mechanics should achieve a **higher accepted
> block length on that domain** than the general-purpose released drafter,
> because the domain is narrow and highly patterned — `Connect(function()`,
> `FindFirstChild`, `SetAttribute`, the same guard shapes over and over. Draft
> models do better where the next eight tokens are predictable, and this domain
> is far more predictable than open prose.

The experiment is one table:

| | accepted block length | tokens/s |
| --- | --- | --- |
| released drafter, general text | *baseline* | |
| released drafter, our Luau traces | | |
| adapted drafter, our Luau traces | | |

Row two is the interesting control: if the released drafter *already* does
better on Luau than on prose, then domain predictability explains the gain and
adaptation adds less than it appears to. Without that row, any improvement in
row three could be the domain rather than the adaptation — which is the same
mistake this project exists to avoid making about game code.

## Measured

It runs, and it is a **regression**. Three arms, because two cannot say what
caused it.

The first version of this measurement compared the plain server against the
speculative one, found 18%, and charged all of it to speculation. That was not
supported. Loading the drafter requires two vLLM flags the plain server does not
run with, and both remove optimisations, so what got measured was `flag cost +
speculation cost`. The third arm separates them: same weights, same two flags,
no speculator.

```
                                          tok/s          accepted   acceptance
                                      best   median        length
  baseline  no flags, no drafter     255.0   247.5           —          —
  control   both flags, no drafter   257.2   254.0           —          —
  dflash    both flags + drafter     219.0   193.8          1.93      11.6%
```

Eight prompts, eight repeats, arms interleaved, every reading gated on an idle
server: 41 clean readings for the baseline, 64 for the control, 56 for the
speculative arm.

**Speculation costs 22%. The flags cost nothing we can measure.** Paired prompt
by prompt, each prompt against itself across arms:

```
  flags        control / baseline   1.010x best, 1.027x median   range 0.971 - 1.017
  speculation  dflash  / control    0.782x best, 0.780x median   range 0.723 - 0.893
  combined     dflash  / baseline   0.788x best, 0.791x median   range 0.732 - 0.868
```

The three multiply back to each other — `1.010 x 0.782 = 0.790` against a
measured combined `0.788`. That check is worth doing on any decomposition,
because a split that does not reconstruct the whole is arithmetic rather than
measurement.

So the original 18% was never `flags + speculation`. End to end the regression is
21%, and the drafter accounts for all of it. The flags — the thing this control
was built to rule out — do not show up at all.

**The flag arm reads 1-2.7% *faster* with the optimisations disabled**, which is
the wrong direction, and it is not being written down as "the flags help". Two
explanations cover it and nothing here separates them:

- It is inside the noise. Repeated readings of one prompt on one arm spread 3.6%
  at the median, and the per-prompt range straddles one at `0.971 - 1.017`.
- The baseline is not a perfectly matched arm. Port 8000 serves
  `['gpt-oss-20b', 'placebo']` — a LoRA adapter is loaded that neither other
  server carries. Requests naming the base model should reach the base weights,
  but adapter loading changes the server's memory and scheduling profile, and
  that is an unquantified difference pointing in exactly the observed direction.

The supportable statement is that the flags cost less than this setup can
resolve. Below a couple of percent, this rig cannot tell you.

Two flags are required, and neither is optional:

- `--disable-hybrid-kv-cache-manager` — gpt-oss alternates sliding-window and
  full-attention layers, so its KV cache has several groups, while the drafter
  reads hidden states from layers `[1,6,11,16,21]` that span them. Without it:
  *"All drafting layers should belong to the same kv cache group."*
- `--disable-sliding-window` — the second half of the same problem, and it only
  appears at generation time. The server starts, then dies on the first request
  with *"Window left is not the same for all layers."*

**Why it is slower.** Of eight drafted tokens, about two survive. The
per-position acceptance halves each step — `519 → 286 → 148 → 70 → 48 → 33 → 15
→ 8`. Paying for eight draft tokens plus a verification to gain two is a bad
trade on a GPU that is not starved for bandwidth, and an RTX PRO 6000 is not.

Two things turned up that are not about speed at all.

**The speculative server is wrong on one prompt in eight.** `A button toggles a
light on and off each time it is pressed.` returns HTTP 500 on every attempt,
8/8 rounds — *"channel marker present but no channel value found in header"*.
The drafter is producing a malformed harmony channel header. Baseline and control
both serve that prompt normally, so this is the speculation and not the flags. A
decoder that is output-preserving in theory is returning a 500 in practice, and
that deserves more attention than the 22%.

**And no arm's output survives the comparison.** On the prompts where both arms
answer stably, the speculative server matches the control on 0/2, and the control
matches the baseline on 0/4. Neither is producing unrelated text: speculation
agrees with the control for the first 37% of a generation before diverging, and
the control agrees with the baseline for the first 20%. That is what a single
flipped token looks like under greedy decoding, not a model ignoring its target
— numeric drift rather than a broken path.

The two cases mean different things, though. The flags are *expected* to change
the output, because `--disable-sliding-window` genuinely changes what the
attention layers can see; the surprise there is that it changes the text without
costing any speed. Speculation is *supposed* to preserve the target's output
exactly, and it does not. Either way, a generation from one endpoint is not
interchangeable with a generation from another, which matters for anything that
caches or compares across them.

One confound survives and is worth keeping: this GPU has far more bandwidth than
the GB10 the design targets, which is exactly the regime where speculation pays
least. Losing 22% here is not evidence it loses on the hardware it was built for.

**How the numbers were taken.** `npx tsx scripts/bench-control.ts` runs all three
arms against the same eight prompts at temperature 0, eight repeats each. The
repeats are not ceremony: the same script cut to two reports the speculation cost
as 7% rather than 22%, because best-of-two is a bad estimate of an arm's clean
speed. It gates every reading on vLLM's
own counters and throws away any sample another request overlapped, because these
servers are shared. It takes each arm's prompts back to back rather than
alternating one at a time — an idle RTX PRO 6000 drops to 180MHz, so a gap
between readings measures the clock ramp instead of the server, and an earlier
version of this script that waited on the busy arm between readings drove the
other two down to 25 tok/s doing it. It scores each prompt on its fastest
reading, since a shared rig can only ever subtract throughput, and prints the
median beside it so a conclusion that depends on the estimator shows up as one.

## Why this is a starting point, not a verdict

A general-purpose drafter scoring 11.6% on Luau is what you would expect. The
question the project cares about is whether a drafter trained on *this system's
own traces* does better, and accepted length is the number that answers it.

`npm run spec:measure` records acceptance, accepted length and throughput to
`data/speculation.jsonl` on every run, and every flywheel turn appends target
generations to `data/draft-traces.jsonl` — which is what a domain-adapted draft
would train on. Note that a draft learns to predict the target's *output
distribution*, not the verified patches, so the traces are sampled at serving
temperature and include generations that were wrong.

"It keeps getting faster" is a claim about a trend, so it is stored as a series.
One reading proves nothing, and a regression after a training turn is precisely
what a series is for.

## Status

Draft adaptation itself is **not run**. The instrument, the baseline, and the
trace collection exist; the training does not. Reporting an accepted length we
had not measured would be worth less than saying that plainly.

