# Placebo — submission

**An agent that has to prove its fix caused the fix.**

Repo: https://github.com/Hcoder10/placebo
Built on the [TrueForge](https://trueforge.dev) agent harness, verified against a
live Roblox Studio.

## The one-sentence version

Every candidate patch is run twice — once with the interaction under test, once
with a **matched control** where the player does everything except that
interaction — and scored on the difference. A patch whose end state is right but
which would look identical had the interaction never happened has caused nothing,
and is rejected.

A launch gate, a unit test, and a build-health check all accept that patch.

## What runs

```bash
npm test                                          # 16 unit tests, no Studio
npm run verify                                    # 7 candidates vs live Studio
npx tsx src/verifier/taskCli.ts tasks/build_coin.yaml    # build from scratch
npx tsx src/verifier/taskCli.ts tasks/extend_door.yaml   # extend without regressing
npx tsx src/bright/cli.ts --break --repair        # scraper recovers from a redesign
npx tsx src/bright/cli.ts --break --adjudicate    # engine rules on scraped claims
npx tsx src/train/export.ts tasks/*.yaml          # export preference pairs
npm run mcp                                       # tools + console at :9400
```

## Measured

| | |
| --- | --- |
| Causal verification, live Studio | 7/7 scored as expected; `iso` and `settled` true throughout |
| Build from scratch | correct accepted, 11 defects rejected |
| Extend without regressing | a candidate that added the door and dropped the coin reported `BROKE coin_awards_once` |
| Scraper self-repair | 4/4 fields recovered after a redesign; spec rewritten at revision 2 |
| Engine adjudication | 3 of 4 scraped claims rejected, each for a distinct reason |
| Preference export | 25 pairs, 3 supervised examples, every label a measured causal difference |
| LoRA DPO on gpt-oss-20b | train loss 0.39, 31.8 MB adapter |
| Loop closed | one endpoint serves `gpt-oss-20b` and `placebo` (the post-trained adapter) |

## Track by track

**Best Use of the Agent Harness.** The harness is the experiment substrate, not a
wrapper. A counterfactual patch group requires branches that cannot see each
other — TrueForge's subagents have no access to the parent conversation or to
siblings, which makes the arms independent *by construction*. Approval gating is
resolved from MCP annotations (`@destructive` only, so the irreversible publish
stops and sandboxed writes do not), and `assertGated` refuses to start if a
mutating tool would be exempt. The model the harness runs on is one we serve
ourselves, so the model trained on the harness's own output swaps in behind the
same URL.

**Best UI.** An experiment dashboard, not a chat window: counterfactual branches
as live cards, predicted-vs-observed effects, treatment-vs-control state, and an
approval gate that asks before the irreversible step. `http://localhost:9400/`

**Best Code Quality.** 16 unit tests over the pure logic plus 7 integration cases
against a live engine, strict TypeScript throughout, PR #1 for review. An
adversarial pass by OpenAI's Codex found four valid issues, two of which would
have invalidated results; both are fixed and are now measured columns rather than
assumptions.

**Best Bright Data.** The scraper spec is a versioned file. When the page moves,
fields are recovered by *shape* — each declares what a valid value looks like —
with document order separating fields that share a shape. The repair is written
back with a bumped revision as a reviewable diff. Then the live engine adjudicates
every claim, and most of them fail: **the web proposes, the engine decides.**

**Best blog post.** [BLOG.md](BLOG.md) — six things harder than the idea, what an
adversarial model found, and what we are not claiming.

## What we are not claiming

Recorded in the repo so it cannot drift under pressure:

- **The realizations vary repetition, not scheduling.** They catch debounce and
  duplicate-listener bugs. They are not evidence about event ordering or
  replication timing.
- **The training run is a working pipeline, not a capability claim.** 25 pairs,
  30 seconds. `rewards/accuracies: 1.0` at that size means the training set was
  separated, which is trivial.
- **We did not invent DFlash and did not train a draft model.** We use the
  released checkpoint. [DFLASH.md](DFLASH.md) states the adaptation experiment,
  its required ordering, and the control that would make the result meaningful —
  and says plainly that it has not been run.
- **Matched controls in game-code training are not new.** [RELATED.md](RELATED.md)
  cites the prior work and states the actual difference: it varies the *verifier
  in the training loop*; we vary the *interaction inside a single evaluation*.
- **The DGX Spark numbers are arithmetic, not measurement.** We do not have one.
  [DGX_SPARK.md](DGX_SPARK.md) shows the working so it is falsifiable.

## Known limitation: the live fan-out does not run

The orchestrator that fans branches out through `create_sub_agent` is written,
typechecked, and registered with the harness — `assertGated` passes and all six
tools resolve to their intended selectors. It has not been demonstrated
end to end with a live model, for a specific reason:

gpt-oss-20b emits tool calls in Harmony format, and vLLM 0.28 does not surface
them as `tool_calls`. The model's own reasoning trace says it intends to call the
tool; the field comes back `null`. The obvious override
(`VLLM_ATTENTION_BACKEND`-style env config for the tool parser) no longer exists
in that version. Serving a second model with better-supported tool calling was
attempted and did not come up in the time available.

So the counterfactual branching is demonstrated by `scripts/seed-branches.ts`,
which drives the identical MCP surface against the identical live Studio with
fixed candidates instead of model-generated ones. Every part downstream of the
model — prediction scoring, causal verification, ranking, the console — is
exercised. What is unproven is that a model drives it well, not that the
mechanism works.

Building the pipeline so this was survivable was deliberate: the dataset, the
verifier, and the console were all made to work without a model precisely so a
serving problem could not take the submission down with it.

## Why a DGX Spark is the right home for this

Not incidental to the prize — the hardware's shape is the argument for the stack.
The GB10 pairs ~500 TFLOPS dense FP4 with ~273 GB/s of memory bandwidth, so
single-stream decode is bandwidth-bound long before it is compute-bound. That is
exactly the regime where speculative decoding stops being an optimisation and
becomes the enabling technique, and it is why DFlash is in the design at all.

Serving, drafting and training come to ~30–38 GB co-resident, leaving ~90 GB
headroom in 128 GB of unified memory. On a discrete GPU you serve *or* you train.
Coherent unified memory is what lets this flywheel run continuously instead of in
shifts — which is the whole point of a loop whose training data comes from its
own inference.
