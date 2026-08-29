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

It runs, and it is currently a **regression**. That is the useful finding.

```
                        tok/s     accepted length   acceptance
  no speculation        252.7           —                —
  released DFlash       206.7          1.99            12.3%
```

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

Two confounds worth stating rather than burying: those flags remove
optimisations the unspeculated baseline still enjoys, so part of the 18% is the
flags rather than the speculation; and this GPU has far more bandwidth than the
GB10 the design targets, which is exactly the regime where speculation pays
least. The clean comparison is the same flags without a speculator, and it has
not been run.

## Why this is a starting point, not a verdict

A general-purpose drafter scoring 12.3% on Luau is what you would expect. The
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

