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

## Status

Not run. We have the checkpoint, the serving stack, and the target model
post-training on engine-labelled data. The adaptation and the measurement need
hardware that can hold the target, the drafter, and a training job at once —
which is the case [DGX_SPARK.md](DGX_SPARK.md) makes for 128 GB of unified
memory, and the reason that box is the right home for this stack rather than an
incidental prize.

Reporting a number here that we had not measured would be worth less than
saying plainly that we have not measured it.
