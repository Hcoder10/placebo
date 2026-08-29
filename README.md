# Placebo

**An agent that has to prove its fix caused the fix.**

Placebo repairs Roblox game logic and scores each candidate patch by what it
*caused* — not by whether a final-state test passes. Every patch is run twice
against a live Roblox Studio: once with the interaction under test, and once
with a **matched control** where the player does everything except that
interaction. The difference between those two worlds is the patch's causal
effect. Anything that moves the world the same amount with and without the
interaction has caused nothing, whatever the final state says.

Built on the [TrueForge](https://trueforge.dev) agent harness, which runs the
experiment: each candidate patch is an independent subagent branching from one
identical checkpoint, which is exactly what a counterfactual patch group is.

---

## The problem, in one table

A coin mechanic. The requirement: *"collecting the coin awards exactly one point
and removes the coin."* Here are two patches and two verdicts.

| Patch | Naive final-state test | Placebo |
| --- | --- | --- |
| Awards on collect, removes coin | PASS | **ACCEPT** |
| Sets the score to 1 at startup, never handles the signal | **PASS** | **REJECT — no causal effect** |

The second patch produces a world where the score reads 1 and the coin is gone.
A test that asserts the final state cannot tell it apart from a correct one. The
control can: with no collect signal, that world looks *identical*, so the
interaction caused nothing.

## Results

Seven candidate patches — one reference implementation and six semantic defects
that still parse and still run — scored against a live Studio:

```
  case                       want    got     stable  iso    settled  why
  reference                  ACCEPT  ACCEPT  true    true   true     caused [Scoreboard.@Coins, exists:Coin, ...]
  reward_hack_preset_score   REJECT  REJECT  true    true   true     no causal effect (identical to control)
  missing_debounce           REJECT  REJECT  false   true   true     missing [Scoreboard.@Coins]
  duplicate_listener         REJECT  REJECT  false   true   true     missing [Scoreboard.@Coins]
  missing_destroy            REJECT  REJECT  true    true   true     missing [exists:Coin]
  awards_everyone            REJECT  REJECT  true    true   true     collateral [OtherScoreboard.@Coins]
  stale_reference_guard      REJECT  REJECT  true    true   true     missing [Scoreboard.@Coins]

  7/7 cases scored as expected
```

Three columns carry the integrity of the result, and a verdict is withheld
unless the last two hold:

- **`stable`** — did every realization of the interaction agree? `false` marks a
  patch whose behaviour changes when the interaction repeats.
- **`iso`** — did treatment and control actually start from the same world?
  Rebuilding the sandbox does not reset a connection to a service, a spawned
  task, or a global. Rather than assert isolation, each condition is snapshotted
  *before* its interaction and the snapshots must match.
- **`settled`** — had the world stopped changing when it was observed? Handlers
  do not run synchronously, so observation waits for quiescence rather than a
  fixed number of frames. A fixed guess silently reports a correct-but-slow
  patch as having caused nothing.

### What the realizations do and do not show

`realizations: [1, 2, 3]` fires the interaction a different number of times.
These are **deterministic variations of the interaction** — they probe
repetition and idempotence, which is what catches a missing debounce or a
duplicated listener. They are **not** scheduler nondeterminism, and a result
here is not evidence of robustness to event ordering or replication timing.

## Quick start

Requires Node >= 22.14, Roblox Studio with the
[roblox-studio-mcp](https://github.com/) bridge plugin connected, and a
TrueForge server for the agent loop.

```bash
npm install

# 1. Connect Studio: toolbar -> "Studio Bridge MCP" -> Connect
npm run probe:studio          # confirms the bridge answers

# 2. Score every candidate patch against the contract, in real Studio
npm run verify

# 3. Serve the tools + operator console
npm run mcp                   # http://localhost:9400/

# 4. Drive the full loop with no model in it (pipeline rehearsal)
npx tsx scripts/seed-branches.ts
```

## How it works

```
contract (treatment + matched controls + expected effect signature)
   +  a project with one injected semantic defect
                    |
        TrueForge parent agent
                    |  create_sub_agent x N   (clean context = independent arms)
   +------------+------------+------------+
   |  branch A  |  branch B  |  branch C  |   each: predict_effect -> patch -> verify
   +------------+------------+------------+
                    |
   live Roblox Studio: treatment + every control, across realizations
                    |
   rank: contract satisfied > no collateral > stable > smaller > fewer engine runs
                    |
   human approval  ->  publish
```

### Contracts are data

A contract names an intervention and the effects it must cause
(`contracts/coin_awards_once.yaml`):

```yaml
treatment: |
  for _ = 1, REALIZATION do sandbox.Collect:Fire("P1") end

controls:
  - name: no_collect
    steps: |
      -- same world, same setup, no interaction
  - name: unrelated_signal
    steps: |
      for _ = 1, REALIZATION do sandbox.Decoy:Fire("P1") end

effects:
  - { key: "Scoreboard.@Coins", change: "+1" }
  - { key: "exists:Coin",       change: "true->false" }

non_effects: ["OtherScoreboard.@Coins"]
realizations: [1, 2, 3]
```

A contract with no control is refused at load: without one it can only assert
final state, which is the thing this project exists to stop trusting.

### Prediction is scored against the engine, not the requirement

Before a branch may verify, it must call `predict_effect` and state what **its
own patch** will do. `contract_get` deliberately withholds the expected effects
— a branch that could read them would echo them back and score perfectly while
understanding nothing. The measurement only has content when the patch is wrong,
which is exactly when echoing gives the wrong answer.

Predictions must hold under **every** realization, the same rule required
effects obey.

## Design notes

Three findings that shaped the implementation, each discovered by the system
rather than designed in:

**Intervention fidelity decides which bugs exist.** Firing one clean event makes
a missing debounce *unobservable* — the reference and the buggy build score
identically. Only a repeated or bursty interaction reveals it. A verifier is
only as good as how faithfully it pokes the world.

**`Destroy()` is an implicit debounce.** The first debounce mutation was a no-op,
because destroying the object inside the handler guards the second event. The
real bug needs deferred cleanup — which is also how people actually write it.

**Isolation is measured, not promised.** An earlier version of this README would
have claimed each condition starts "from nothing". It does not, strictly: a
patch can leave a service connection or a spawned task alive that outlives the
sandbox folder. The honest version is the `iso` column — capture the world
before each interaction and require the conditions to match.

**Do not trust `place_restore`.** The bridge exposes `place_snapshot` /
`place_restore`, and its description claims it "reverses any changes since the
snapshot". Measured (`scripts/probe-restore-fidelity.ts`):

| change | reverted? |
| --- | --- |
| attribute on an instance | no |
| attribute on a service | no |
| property on an instance | no |
| instance created after the snapshot | no |
| instance deleted after the snapshot | yes |

It returns `ok: true` regardless. A verifier built on it would silently compare a
treatment against a control that started from a different world. Placebo rebuilds
each condition's world from nothing instead — determinism by construction rather
than by promise.

## What is and is not novel

Execution-gated training for game code already exists, and so does using a
matched control to show a verifier is doing the work — see
[RELATED.md](RELATED.md), written after checking rather than before.

The difference is **what the control varies**. Prior work varies the *verifier*
in the training loop, to ask whether the gain came from filter precision or from
more data. Placebo varies the *interaction* inside a single evaluation, to ask
whether a specific state change was caused by the player's action or was going to
happen regardless. A launch gate accepts the reward hack in this repo; only a
no-collect control rejects it.

## Layout

```
contracts/           behavioural contracts (data, not code)
src/verifier/        studio session, effect scoring, candidate patches
src/mcp/             the tool surface TrueForge drives, plus run state
src/orchestrator/    agent specs for the parent and its branches
console/             operator console (served at /)
scripts/             studio probes and the model-free pipeline rehearsal
tests/               unit coverage over the pure logic
```

## Tests

```bash
npm test          # 16 unit tests, no Studio required
npm run verify    # 7 candidate patches against live Studio
```

## License

MIT
