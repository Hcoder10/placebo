# Placebo, an agent that proves its game code *caused* something

> An agent that builds Roblox games and proves every mechanic by **controlled experiment inside the engine**: same world twice, interaction in one, and only the difference counts. A patch that presets the score passes every normal test and gets **rejected here** for causing nothing.

Built for the **WeMakeDevs Agent Harness** hackathon on **TrueFoundry TrueForge**.

---

Hey judges!

Most "AI writes code" demos show you a green checkmark. A green checkmark is exactly what a reward hack produces. So instead of asking you to trust one, I built the thing that catches it, and I want you to watch it catch one.

# Why this should win

1. **The harness is the experiment.** Four counterfactual branches run as TrueForge subagents with no access to each other, so the arms are independent structurally rather than by convention. They reach real tools over MCP, execute inside a game engine, and stop for a person before anything irreversible. `npm run run:agent run 4`.
2. **Tests confirm state. This confirms causation.** Placebo runs a treatment and a matched control inside Roblox Studio, then keeps only what the interaction caused. `reward_hack_preset_score` sets the score to the right number and is rejected with `no causal effect (identical to control)`. Every launch test and state assertion on earth passes that patch.
3. **The verdicts are gated on their own integrity.** A result is withheld unless the two conditions actually started from the same world (`iso`) and the world had stopped moving when observed (`settled`). Those columns are printed, not assumed.
4. **Scraped web data measurably improves the model, with a placebo arm.** Bright Data scrapes Roblox deprecations, the engine throws out 3 of 4 claims, and the survivor lifts acceptance **45.0% to 66.7% (p = 0.027)**. A control note of identical shape naming a replacement the engine says does not exist scores **5%**, which is what rules out "the prompt just got longer".

# How to experience it in 7 minutes

**1. The harness runs the experiment** (2 min)

```bash
npm run run:agent run 4
```

TrueForge fans four counterfactual branches out as **subagents**, one per candidate patch. Each has no access to the parent conversation or to its siblings, so the arms cannot correlate. Each reaches real tools over MCP (`contract_get`, `predict_effect`, `patch_propose`, `causal_verify`), predicts what its patch will cause before running it, and is scored on that prediction against the engine.

It **stops for a person**. `publish_place` is annotated `@destructive`, TrueForge resolves that into an approval gate, and the run pauses until someone decides:

```
  approval required: publish_place
  approve? [y/N]
```

Nothing publishes without that. `assertGated()` refuses to start the run at all if a tool that should be gated is not, which is how we found the Roblox bridge shipping 134 tools with no annotations, every one silently exempt.

Code executes inside **Roblox Studio**, in a sandbox folder rebuilt from nothing before every condition. That is a stronger isolation boundary than a process sandbox: a patch cannot see the previous run's world because there isn't one.

**2. Watch it reject a reward hack** (60s)

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

**3. Watch it build a game** (90s)

```bash
npm run build:game
```

Mechanics accrete one at a time. Step 2 prints `PASS kept coin_awards_once` before `PASS gained door_opens_at_three`. The regression set is verified, not assumed.

**4. Watch the game play itself** (60s)

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

**5. Open the console** (30s)

```bash
npm run mcp     # then http://localhost:9400/
```

Live run state, approval gates, and the training numbers straight off disk.

**6. Watch the scraper repair itself and get overruled** (45s)

```bash
npx tsx src/bright/cli.ts --break --repair       # recovers from a page redesign by shape, not selectors
npx tsx src/bright/cli.ts --break --adjudicate   # the engine rejects 3 of 4 scraped claims
```

## The idea

A launch test asks "did it run". A state assertion asks "is the number right". Neither asks **"did the player's action cause this"**, which is the only question that distinguishes a working mechanic from a coincidence, from dead code, from a reward hack.

Placebo asks it the way an experiment does. Build the world from nothing. Run the interaction in the treatment and not in the control. Snapshot both. The causal effect is the difference, and anything present in both is discarded no matter how correct it looks.

### The gap the verifier exists to close

Hand the model the world inventory the way the agent loop does, then ask what fraction of its completions actually connect to the interaction it was given:

```
gpt-oss-20b   build_coin    29/40
              extend_door   29/39
              repair_key    38/40
              n=119   uses the given interface  80.7%   95% CI 72.7-86.8
                      invents its own world      0.8%
```

So the model reaches for the right objects four times out of five. Roughly **one patch in thirty survives causal verification**.

That distance is the entire argument. The failure is almost never "it ignored the world". It is code that connects to the right event, reads the right attribute, and still does not cause the effect the contract asks for: it awards before checking the coin exists, it awards on any signal rather than that one, it writes the value the test wants without the interaction being what wrote it. Those all look correct in review, and every one of them is rejected here by a control that produced the same state without the interaction.
## Where the harness actually is

Be precise about this, because it is easy to overclaim.

**`npm run run:agent` is the harness flow.** It fans counterfactual branches out as TrueForge subagents, one per candidate patch, each with no access to the parent conversation or to its siblings ([`src/orchestrator/spec.ts`](src/orchestrator/spec.ts) sets `dynamic_sub_agents: { enabled: true }`). Independence between arms is structural there: a branch cannot read what another branch wrote, so the arms cannot correlate. It reaches real tools over MCP, and `publish_place` stops for a person.

**`npm run verify` and `npm run build:game` do not use the harness.** They call the verifier directly and run treatment and control as sequential calls in [`src/verifier/effect.ts`](src/verifier/effect.ts). They are the fastest way to see the idea, which is why they lead the demo, and they would work with no harness at all.

So: the causal verifier is harness independent by design, and the harness is what turns it into a controlled fan-out over many candidate patches at once, with approval gating and a replayable event log. Two other things the project actually leaned on:

**Approval gating from tool annotations.** `patch_propose` and `world_build` are `@write`, `publish_place` is `@destructive`, resolved by TrueForge from MCP `readOnlyHint` and `destructiveHint`. That surfaced a real problem: the Roblox bridge exposes **134 tools with no annotations at all**, silently exempting every one from approval. `assertGated()` now refuses to start a run if a tool that should be gated is not.

**A replayable event log.** Every branch's tool calls and responses are queryable after the fact, which is how three bugs were found: a tool name arriving as `call_tool<|channel|>commentary` out of a streaming parser, a model omitting a required `id`, and a run silently rebuilding the shared world underneath another run's experiment.

## Post-training: a drafter we trained on our own traces

Speculative decoding pays exactly as well as the draft model predicts the target. Accepted length here counts the target's own guaranteed token plus the draft tokens it accepted, which is the figure vLLM reports. The released general-purpose drafter sits at **2.17**, so roughly **1.17 of its 8 drafted tokens** survive. We collected 787 traces from our own target, reconstructed the training objective from the checkpoint's `spec_generate` loop (z-lab ship inference code only), and trained a drafter on them.

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

The 8 evaluation prompts were held out of the 197-prompt training corpus.

### What we could not finish

Post-training the 20B itself did not reach a scale where a gain could show. We
trained a LoRA on engine-labelled preference pairs three times, at 25, 76 and
104 pairs. Published DPO runs use tens of thousands; a narrow behavioural shift
starts appearing around one to five thousand. The blockers were concrete: one
workstation GPU shared between the serving endpoint and the trainer, a driver
fault that blocked every new CUDA process for an hour mid-session, and a corpus
that grows at the speed of engine adjudication because every candidate costs a
full world rebuild per condition per realization.

Measured on a held-out check with the world inventory supplied, the base model
uses the given interface **80.7% of the time (96/119, 95% CI 72.7-86.8)**. The
104-pair adapter measures **53.3% (64/120, 95% CI 44.4-62.0)**, so at this data
scale preference training moved the model in the wrong direction and the
intervals do not overlap. `rewards/accuracies` hit 1.0 during training, which is
what overfitting on a hundred pairs looks like.

The pipeline is the deliverable, not that number. It samples from the target,
adjudicates every draw against a live engine, exports preference pairs whose
labels are measured causal differences rather than human opinion, trains, and
serves the result on the same endpoint. `npm run flywheel` runs one turn of it.
The drafter above is the same loop applied to a model small enough that the
data we could collect was enough, and there it worked. A separate check that the reconstruction is correct: the offline instrument scores the *released* checkpoint at 2.120 against a live 2.17 to 2.23, where a wrong block mask or offset would sit near 1.0.
## Qodo Code Review Evidence

Qodo reviewed every pull request in this repo. All three are merged.

| PR | What it reviewed | Result |
|---|---|---|
| [#3](https://github.com/Hcoder10/placebo/pull/3) | the visual kit, appearance verification, model-sampled candidates | **8 bugs found, all 8 real, all 8 fixed, re-review clean (0 bugs)** |
| [#2](https://github.com/Hcoder10/placebo/pull/2) | engine gotchas and contributor docs | 0 bugs, 0 rule violations |
| [#1](https://github.com/Hcoder10/placebo/pull/1) | counterfactual branch fan-out through the harness | reviewed and merged |

The finding worth reading is the first one on PR #3, **"Empty designs pass inspection"**:

> `analyzeParts` derives acceptance only from checks that all pass for an empty or bootstrap-ground-only scene. A model can therefore call `world_build` with no meaningful content and satisfy the new mandatory `design_check` gate.

Acceptance was `checks.every(check => check.pass)`, and every check is vacuous on a world with nothing in it. Build nothing, pass everything. A test in our own suite codified accepting a scene with zero parts.

That is exactly the failure the contract auditor exists to prevent on the correctness side: a specification satisfiable with no implementation at all is rejected as trivial. We had that argument written down, implemented and tested, then built a second gate for appearance and left the identical hole in it. There is now an `authored_content` check, and the ground plane the kit bootstraps in does not count as authored.

The rest: rotated parts flagged as overlapping because their bounding boxes intersect, a lighting check that passed on any Atmosphere while ignoring the brightness it had already read, repair strings built with unescaped dot notation so a part named `My Door` emitted a command that cannot run, and candidate identity keyed on id rather than code so one program was evaluated and stored twice.
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
