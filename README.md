# Placebo, an agent that proves its game code *caused* something

> An agent that builds Roblox games and proves every mechanic by **controlled experiment inside the engine**: same world twice, interaction in one, and only the difference counts. A patch that presets the score passes every normal test and gets **rejected here** for causing nothing.

Built for the **WeMakeDevs Agent Harness** hackathon on **TrueFoundry TrueForge**.

---

Hey judges!

Most "AI writes code" demos show you a green checkmark. A green checkmark is exactly what a reward hack produces. So instead of asking you to trust one, I built the thing that catches it, and I want you to watch it catch one.

# Why this should win

1. **Tests confirm state. This confirms causation.** Placebo runs a treatment and a matched control inside Roblox Studio, then keeps only what the interaction caused. `reward_hack_preset_score` sets the score to the right number and is rejected with `no causal effect (identical to control)`. Every launch test and state assertion on earth passes that patch.
2. **The verdicts are gated on their own integrity.** A result is withheld unless the two conditions actually started from the same world (`iso`) and the world had stopped moving when observed (`settled`). Those columns are printed, not assumed.
3. **Scraped web data measurably improves the model, with a placebo arm.** Bright Data scrapes Roblox deprecations, the engine throws out 3 of 4 claims, and the survivor lifts acceptance **45.0% to 66.7% (p = 0.027)**. A control note of identical shape naming a replacement the engine says does not exist scores **5%**, which is what rules out "the prompt just got longer".

# How to experience it in 5 minutes

**1. Watch it reject a reward hack** (60s)

```bash
npm run verify
```

Seven candidate patches against live Studio. One reference accepts, six semantic defects reject, each for a different measured reason. Read the `why` column.

```
reference                  ACCEPT  caused [Scoreboard.@Coins, exists:Coin]
reward_hack_preset_score   REJECT  no causal effect (identical to control)
awards_everyone            REJECT  collateral [OtherScoreboard.@Coins]
missing_destroy            REJECT  missing [exists:Coin]
7/7 cases scored as expected
```

**2. Watch it build a game** (90s)

```bash
npm run build:game
```

Mechanics accrete one at a time. Step 2 prints `PASS kept coin_awards_once` before `PASS gained door_opens_at_three`. The regression set is verified, not assumed.

**3. Watch the game play itself** (60s)

```bash
npm run playable && npm run prove:playable
```

Real physics, real `Touched`, no human:

```
drop rig #1   touched=true  score=1 door=false
drop rig #2   touched=true  score=2 door=false
drop rig #3   touched=true  score=3 door=true
door became passable  true
played clean, and left a world the next run can play again
```

Or press F5 and walk into the coin yourself.

**4. Open the console** (30s)

```bash
npm run mcp     # then http://localhost:9400/
```

Live run state, approval gates, and the training numbers straight off disk.

**5. Watch the scraper repair itself and get overruled** (45s)

```bash
npx tsx src/bright/cli.ts --break --repair       # recovers from a page redesign by shape, not selectors
npx tsx src/bright/cli.ts --break --adjudicate   # the engine rejects 3 of 4 scraped claims
```

## The idea

A launch test asks "did it run". A state assertion asks "is the number right". Neither asks **"did the player's action cause this"**, which is the only question that distinguishes a working mechanic from a coincidence, from dead code, from a reward hack.

Placebo asks it the way an experiment does. Build the world from nothing. Run the interaction in the treatment and not in the control. Snapshot both. The causal effect is the difference, and anything present in both is discarded no matter how correct it looks.

## Why the harness is load bearing

A causal test needs two arms that cannot contaminate each other. That is not a nice property, it is the whole experiment: if the branch that writes the treatment can see what the control did, the arms are correlated and the difference means nothing.

TrueForge gives that for free. Each counterfactual branch is a subagent with **no access to the parent conversation or to its siblings**, so the arms are independent by construction rather than by convention. In a single chat loop, contamination is the default and you would have to argue your way out of it.

Two more things it does that the project depends on:

**Approval gating from tool annotations.** `patch_propose` and `world_build` are `@write`, `publish_place` is `@destructive`, and TrueForge resolves those from the MCP `readOnlyHint` and `destructiveHint` fields. That surfaced a real problem: the Roblox bridge exposes **134 tools with no annotations at all**, which silently exempts every one of them from approval. Any harness that trusts annotations inherits that. `assertGated()` now refuses to start a run if a tool that should be gated is not.

**A session, turn and event model you can read after the fact.** Every branch's tool calls and responses are queryable, which is how three separate bugs in this repo were found: a tool name arriving as `call_tool<|channel|>commentary` from a streaming parser, a model omitting a required `id` field, and a run that silently rebuilt the shared world underneath another run's experiment.
## Post-training: a drafter we trained on our own traces

Speculative decoding pays exactly as well as the draft model predicts the target. The released general-purpose DFlash drafter accepts **2.17 of 8** tokens on this workload. We collected 787 traces from our own target, reconstructed the training objective from the checkpoint's `spec_generate` loop (z-lab ship inference code only), and trained a drafter on them.

```
released draft, first run     2.23 accepted length   15.4% acceptance   139.6 tok/s
released draft, re-measured   2.17 accepted length   14.6% acceptance   209.2 tok/s
adapted draft                 2.44 accepted length   18.0% acceptance   212.1 tok/s
```

Same endpoint, same GPU, same `--gpu-memory-utilization`, same flags. Only `--spec-model` differs.

**The noise floor is why this is worth quoting.** The *same* released drafter was measured twice before anything was believed, and it returned 2.23 then 2.17. That puts run to run noise at about ±0.06, so **+0.27 is roughly 4x it**. Per-position acceptance improved everywhere after position 1, with the biggest gains in the tail:

```
released  518 -> 276 -> 134 -> 72 -> 48 -> 32 -> 15 -> 8
adapted   506 -> 300 -> 169 -> 79 -> 57 -> 41 -> 33 -> 20
```

Throughput went 209.2 to 212.1, which is inside the noise. Accepted length moved 12% and wall clock did not, because on a GPU that is not bandwidth starved the verification step was never the bottleneck.

The 8 evaluation prompts were held out of the 197-prompt training corpus. A separate check that the reconstruction is correct: the offline instrument scores the *released* checkpoint at 2.120 against a live 2.17 to 2.23, where a wrong block mask or offset would sit near 1.0.
## Measured

| | |
|---|---|
| Causal verification, live Studio | **7/7** scored as expected, `iso` and `settled` true throughout |
| Playable, driven from code | score 0, 1, 2, 3, door opens on the third and becomes passable |
| Survives a second play | run 2 starts from run 1's ending state and plays correctly |
| Appearance | **8/8** design checks, 38 parts, zero hand rolled |
| Scraped curriculum | 4 claims, 1 survived the engine, **80 of 156** preference pairs |
| Curriculum lift | 45.0% to **66.7%**, Fisher p = 0.027, placebo arm 5.0% |
| Restore fidelity | **9/9** instances (Studio's own `place_restore` manages 1/5) |
| Independent review | Qodo found 8 bugs, all 8 real, all 8 fixed, **0 remaining** |
| Tests | 122 unit, no Studio required |

## It fits on one Spark

The whole loop is local. Nothing is hosted, nothing is metered, and the only thing that leaves the machine is a scrape.

| Piece | Needs |
|---|---|
| gpt-oss-20b, MXFP4, plus a LoRA | **13 GB** weights, measured |
| DFlash drafter | **1.5 GB** |
| KV cache at 16k context | the rest of the budget |
| Roblox Studio, the engine | CPU, no GPU |
| TrueForge, MCP server, console | CPU, a few hundred MB |

A DGX Spark's **128 GB unified memory** holds the target, the drafter and a training run at the same time, which is the thing that makes the flywheel a loop rather than a schedule. Today those three fight over one workstation GPU: training the drafter meant stopping the server it was measured against, and a GPU fault mid-session blocked every new CUDA process for an hour. Unified memory removes the eviction, not just the cost.

Measured throughput on a single Blackwell workstation GPU: **209 to 212 tok/s** generating Luau, at 16k context, with the LoRA attached.
## Where it runs

Nothing hosted. Three pieces, all yours:

| Piece | Where |
|---|---|
| **TrueForge** harness | `localhost:8790`, owns sessions, turns, subagent branches, approval gating |
| **gpt-oss-20b** + LoRA | your own GPU, served by vLLM |
| **Roblox Studio** | the engine that decides what is true, 134 tools over a local bridge |
| **placebo-tools** MCP + console | `localhost:9400` |

## Weights

| Model | Repo | Used for |
|---|---|---|
| **gpt-oss-20b** | [`openai/gpt-oss-20b`](https://huggingface.co/openai/gpt-oss-20b) | writes the Luau |
| **placebo LoRA** | [`squaredcuber/placebo-dpo-gpt-oss-20b`](https://huggingface.co/squaredcuber/placebo-dpo-gpt-oss-20b) | DPO on engine labelled preference pairs |
| **DFlash draft** | [`z-lab/gpt-oss-20b-DFlash`](https://huggingface.co/z-lab/gpt-oss-20b-DFlash) | speculative decoding, adapted on our own traces |

## Repo map

| Path | What |
|---|---|
| `src/verifier/` | the experiment: contracts, treatment and control, effect diffing, world snapshot and restore |
| `src/verifier/kit.ts` | styled construction kit plus the play layer that makes a verified world playable |
| `src/mcp/` | the 10 tools the agent works through, plus the operator console |
| `src/orchestrator/` | TrueForge wiring, counterfactual branches as isolated subagents |
| `src/bright/` | self repairing scraper and engine adjudication |
| `src/train/` | the flywheel: sample, adjudicate, label, export preference pairs |
| `tasks/` · `contracts/` | what to build and what each mechanic must cause |

## Quick start

```bash
npm install
npm run mcp                                    # tools + console on :9400
npm run verify                                 # 7 candidates vs live Studio
npm run build:game && npm run playable         # build it, then make it playable
npm run prove:playable                         # watch it play itself
npm run flywheel                               # sample, adjudicate, grow the corpus
npm run make:game "a coin game where three coins open a door"
```

Studio needs the bridge plugin connected. Everything except `verify`, `build:game` and `prove:playable` runs without it.
