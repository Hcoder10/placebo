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
npm test                                          # 94 unit tests, no Studio
npm run verify                                    # 7 candidates vs live Studio
npm run build:game                                # accrete verified mechanics into a game
npm run playable                                  # attach the input device, then press F5
npx tsx scripts/kit-demo.ts                       # build a styled level and check how it looks
npx tsx src/verifier/taskCli.ts tasks/build_coin.yaml    # build from scratch
npx tsx src/verifier/taskCli.ts tasks/extend_door.yaml   # extend without regressing
npx tsx src/verifier/taskCli.ts tasks/repair_key.yaml    # repair a bug that hides from one contract
npx tsx src/bright/cli.ts --break --repair        # scraper recovers from a redesign
npx tsx src/bright/cli.ts --break --adjudicate    # engine rules on scraped claims
npm run flywheel                                  # sample, adjudicate, grow the corpus
npm run spec:measure                              # accepted length of the current drafter
npm run make:game "<what the game should do>"     # agent authors the world and the mechanics
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
| Appearance verified, live Studio | 11 parts, 11 from the kit, 8/8 design checks pass |
| Playable | the verified mechanic and a physical trigger installed as Scripts; three collects score 1/2/3, the coin respawns, the door opens on the third |
| Flywheel, turn 3 | corpus 18 -> 60, preference pairs 25 -> 76, 30/30 samples usable, one model-authored patch accepted |
| Speculation cost, decomposed | flags cost nothing measurable (1.010x); speculation costs 22%; 1.010 x 0.782 = 0.790 against a measured combined 0.788 |
| Draft adaptation | accepted length 2.17 -> 2.44, acceptance 14.6% -> 18.0%, against a +/-0.06 noise floor |
| Independent review | Qodo found 8 bugs across the kit and sampler; all 8 real, all 8 fixed |

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
- **We did not invent DFlash and we did not train a draft model from scratch.**
  We use the released checkpoint and *adapted* it to this workload. z-lab ship
  inference code only, so the training objective was reconstructed from the
  checkpoint's own `spec_generate` loop; the check that the reconstruction is
  right is that the offline instrument scores the *released* checkpoint at
  2.120 against a live 2.17–2.23, where a wrong mask or offset would sit near
  1.0.
- **Adaptation moved acceptance, not wall-clock.** Accepted length 2.17 -> 2.44
  and acceptance 14.6% -> 18.0%, measured online through the repo's own
  instrument, same GPU and flags with only `--spec-model` differing. Throughput
  209.2 -> 212.1 is *inside* the noise. Both facts belong together: the drafter
  got 12% better at predicting the target and the generation did not get faster,
  which supports rather than overturns the argument in [DFLASH.md](DFLASH.md)
  that on a GPU which is not bandwidth-starved, verification is not the
  bottleneck.
- **The number is acceptance over reasoning tokens, not over Luau.** 1641 of
  1644 collected traces finish on `length` rather than `stop`, and 1644 of 1644
  open on gpt-oss's `analysis` channel, so the corpus is essentially reasoning
  text. The evaluation has the same composition, which is very likely why the
  gain transferred — but nobody should read this as "Luau source became 12% more
  predictable."
- **The noise floor is stated because it has to be.** The same released drafter
  measured 2.23 and 2.17 on consecutive runs, at 139.6 and 209.2 tok/s, on a box
  shared with three other model servers. The +0.27 gain is about 4x that; the
  throughput non-result is inside it.
- **The original 18% was never "flags plus speculation".** Loading a drafter
  requires two vLLM flags that remove optimisations, so the first measurement
  conflated the two. Measured as three arms with every reading gated on an idle
  server: the flags cost nothing resolvable (1.010x, inside a 3.6% noise floor)
  and the drafter owns essentially the whole regression. The decomposition
  multiplies back to the whole, which is the check that it is one measurement
  rather than three unrelated ones.
- **Two speculation bugs we found and did not fix.** The speculative server
  returns HTTP 500 on one workload prompt reproducibly, and it is not
  deterministic at temperature 0 while the control is perfectly stable across
  repeats. Speculative decoding is supposed to be output-preserving, so that
  second one is a correctness observation, not a performance one.
- **The design checks measure properties, not taste.** Palette adherence,
  interpenetration, alignment, proportion, variety and lighting are checkable.
  Whether a level is *fun* is not, and nothing here claims to score it.
- **Matched controls in game-code training are not new.** [RELATED.md](RELATED.md)
  cites the prior work and states the actual difference: it varies the *verifier
  in the training loop*; we vary the *interaction inside a single evaluation*.
- **The DGX Spark numbers are arithmetic, not measurement.** We do not have one.
  [DGX_SPARK.md](DGX_SPARK.md) shows the working so it is falsifiable.

## The live fan-out runs

`gpt-oss-20b`, served by us, spawns subagents through TrueForge, writes Luau, and
has every patch scored by what it caused in a live Roblox Studio.

```
session ... model selfhosted/gpt-oss-20b  branches 3
  branch opened   branch_a
  branch finished branch_a
  branch opened   branch_b
  branch finished branch_b
```

Model-authored branches and their engine verdicts:

| branch | patch | verdict |
| --- | --- | --- |
| `coin_awards_once` | 518 B | ACCEPT |
| `branch-coin` | 549 B | ACCEPT |
| `branch1` | 13 B — `print("test")` | REJECT |

That last row is the point of the entire project. The model probed with
`print("test")`, and the verifier rejected it for causing nothing — the exact
failure mode a final-state test waves through, caught on a model's real output
rather than on a fixture we wrote.

**What unblocked it.** gpt-oss speaks Harmony, and vLLM returns `tool_calls:
null` without a parser while the model's own reasoning says it intended to call
the tool. The fix is `--tool-call-parser openai --enable-auto-tool-choice`;
`openai` is the registered name for `vllm.tool_parsers.gptoss_tool_parser`. We
lost hours to a wrong conclusion here: an earlier probe for the flag timed out
before argparse printed, and silence was read as "the flag does not exist."
Passing a deliberately invalid parser name and reading the resulting `KeyError`
lists every valid choice in one line, and is the fastest way to answer that
question.

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
