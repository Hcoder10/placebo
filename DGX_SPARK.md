# Running the whole loop on one DGX Spark

Placebo is designed to fit, end to end, on a single [DGX
Spark](https://www.nvidia.com/en-us/products/workstations/dgx-spark/): serve the
model, draft for it, and post-train it on the experiments it just ran — with no
second machine and no copying weights across a bus.

**Everything below is an engineering estimate with stated assumptions, not a
measurement.** We do not have a Spark. The numbers are arithmetic you can check,
and the point of writing them down is that they are falsifiable when we get one.

## Why this hardware, specifically

The GB10 has an unusual shape:

| | GB10 (DGX Spark) |
| --- | --- |
| Unified memory | 128 GB LPDDR5X, coherent across CPU and GPU |
| Memory bandwidth | ~273 GB/s |
| Dense FP4 | ~500 TFLOPS (~1 PFLOP sparse) |
| Architecture | Blackwell, sm_121 |

Enormous compute, comparatively narrow bandwidth. For autoregressive decode that
ratio is the whole story: generating one token requires reading the active
weights from memory, so single-stream decode is **bandwidth-bound long before it
is compute-bound**. A discrete datacenter GPU hides this with HBM. The Spark
cannot.

That is precisely the regime where speculative decoding stops being an
optimisation and becomes the enabling technique. DFlash drafts a whole block in
one forward pass, and the target model then *verifies* several tokens in a single
weight read instead of one read per token. It converts a bandwidth problem into
a compute problem — and compute is the thing this box has in surplus.

**So the stack was not chosen and then pointed at a Spark. The Spark's
compute-to-bandwidth ratio is the argument for the stack.**

## Memory budget

gpt-oss-20b ships natively in MXFP4 (~4.25 bits/param), which is what makes the
budget comfortable rather than tight.

| Component | Estimate | Note |
| --- | ---: | --- |
| gpt-oss-20b weights (MXFP4) | ~12 GB | 21B params at ~4.25 bits |
| KV cache @ 32k context | ~2–4 GB | GQA; grows with concurrency |
| DFlash draft model | ~1.5 GB | measured from the released checkpoint |
| Serving runtime + activations | ~3 GB | |
| **Serving subtotal** | **~19 GB** | |
| LoRA adapters (r=32) | <1 GB | trained params only |
| Optimizer state (Adam, adapters only) | ~2 GB | |
| Training activations (checkpointed) | ~8–16 GB | batch- and sequence-dependent |
| **Training subtotal** | **~11–19 GB** | |
| **Both, co-resident** | **~30–38 GB** | leaves ~90 GB headroom |

The headroom is the interesting part. On a discrete GPU you serve *or* you train,
and moving between them means evicting weights across PCIe. With 128 GB of
coherent unified memory the serving model and the training job are neighbours in
the same address space — which is what lets the flywheel run continuously instead
of in shifts:

```
  serve  ──▶  agent runs experiments in Roblox  ──▶  verified traces
    ▲                                                     │
    └──────────  swap adapter  ◀──  LoRA train  ◀─────────┘
```

## Decode arithmetic

Single-stream decode throughput is roughly `bandwidth / bytes read per token`.

gpt-oss-20b is a mixture of experts: ~21B total parameters, ~3.6B active per
token. Only the active experts and the attention weights are read.

```
active weights per token   ~3.6B params x 4.25 bits  ~= 1.9 GB
plus attention + KV traffic                          ~= 0.4 GB
                                                     ------------
                                                     ~= 2.3 GB/token

ceiling  =  273 GB/s  /  2.3 GB  ~= 118 tokens/s
```

Real throughput lands below a bandwidth ceiling, so treat ~118 tok/s as an upper
bound rather than a forecast. The number that matters for us is what speculation
does to it: with an accepted block length of *k*, the target performs one weight
read per *k* tokens rather than per token. DFlash's paper reports acceptance well
above 1 on general text; on a **narrow, highly patterned domain like Luau
mechanics** — which is exactly what we generate — a drafter should do better than
it does on open prose.

That is a claim we would test, not one we are making. The experiment is:
measure accepted block length on our own traces, before and after adapting the
draft model to them.

## What we would do with a Spark

In order, because each step depends on the last:

1. **Serve gpt-oss-20b + the released DFlash draft.** Establish the baseline:
   tokens/s, accepted block length, and cost per completed task.
2. **Run the agent against it.** Every branch that passes causal verification
   becomes a training example; every branch that fails becomes a rejected pair.
   The harness is the data engine.
3. **LoRA post-train on those traces**, co-resident with serving. Re-run the
   identical task set and report the delta on the same axis.
4. **Adapt the DFlash draft to the post-trained target — in that order.** The
   drafter conditions on the target's hidden states, so changing the target
   shifts the features the draft was aligned to. Adapting first and fine-tuning
   after would measure the wrong thing.
5. **Report accepted block length before and after domain adaptation.** This is
   the genuinely novel measurement in the stack, and the one we cannot make
   without hardware that runs all three workloads at once.

## What we already learned about Blackwell that transfers

We developed on workstation Blackwell (sm_120) and lost real time to kernel
availability, which is the same class of problem a Spark (sm_121) presents:

- vLLM auto-selected the FlashInfer attention backend for gpt-oss and died during
  cudagraph capture with `FlashInfer backend is not available` — despite
  flashinfer being installed and importable. The missing piece was the sm_120
  `xqa` decode kernel.
- `VLLM_ATTENTION_BACKEND` no longer exists in vLLM 0.28, so the obvious
  override is a silent no-op. Confirmed by inspecting the package's own env list
  rather than trusting documentation.
- The root cause was `nvcc` absent from the PATH the server launched with, so
  flashinfer could not JIT-compile the kernel at runtime. An install that
  imports fine is not an install that can compile.

None of that is exotic. It is the ordinary state of a new architecture, and it is
why "it fits in the memory budget" and "it runs" are different claims. We have
made the first one here; the second needs the box.
