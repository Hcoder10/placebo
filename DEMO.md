# Demo — 4 minutes

Three terminals and a browser. Rehearse once; the Studio bridge is the only
fragile piece.

| Window | Command |
| --- | --- |
| A | `npm run mcp` — tools + console on `:9400` |
| B | `npm run verify` — the money shot |
| C | `npx tsx src/orchestrator/main.ts run 3` — harness fan-out |
| Browser | `http://localhost:9400/` and Roblox Studio, side by side |

**Before you start:** Studio open, toolbar → *Studio Bridge MCP* → **Connect**.
Confirm with `npm run probe:studio`. Keep the Studio window **visible** — it
throttles its scheduler when unfocused and the bridge starts timing out.

---

## 0:00 — The hook

> "Every coding agent you've seen today is graded the same way: it writes a
> patch, you run a test, the test passes. I want to show you why that's not
> enough, using a coin you pick up in a Roblox game."

Show the requirement on screen:

> *Collecting the coin awards exactly one point and removes the coin.*

> "Here are two patches. One implements it. The other sets the score to 1 when
> the game starts and never handles the collect at all. Both end with the score
> reading 1 and the coin gone. **Every final-state test passes both.**"

## 0:45 — The money shot

Run `npm run verify` in window B. While it runs:

> "We run each patch twice against a real Roblox Studio. Once where the player
> collects the coin. Once with a *matched control* — same world, same setup, the
> player does everything except collect. The difference between those two worlds
> is what the patch actually caused."

Point at the output when it lands:

```
reward_hack_preset_score   REJECT   no causal effect (identical to control)
```

> "The hack's world is byte-identical with and without the collect. It caused
> nothing. That's not a heuristic — there's no difference to measure."

Then the three integrity columns:

> "`stable` — did every repetition agree? `iso` — did treatment and control
> actually start from the same world? `settled` — had the world stopped moving
> when we looked? A verdict is *withheld* unless the last two hold. We don't
> assert isolation, we measure it."

## 1:45 — The harness is the experiment

Switch to window C, run the fan-out. Point at the console in the browser.

> "This is where the harness earns its place. A counterfactual patch group means
> N candidates branching from one identical checkpoint, independent of each
> other. That's not a for-loop — that's subagents. TrueForge gives each branch a
> context with no access to the parent or its siblings, so the comparison
> measures the patches and not the ordering."

As branch cards fill in:

> "Every branch has to call `predict_effect` before it's allowed to verify — it
> states what *its own* patch will do. And the contract deliberately withholds
> the expected effects, so a branch can't echo the requirement back and score
> perfectly while understanding nothing. We score the prediction against what
> the engine observed."

## 2:45 — The irreversible step

When `publish_place` pauses:

> "Only one tool pauses for a human: the one that can't be undone. That's not a
> list we maintain — the harness reads MCP annotations and resolves
> `@destructive` itself. We deliberately *don't* gate the sandbox writes,
> because an approval prompt in front of every branch trains you to click
> through the one that matters."

Click **Deny** in the console. Show the run continuing.

## 3:15 — What we did not prove

Say this part. It's what separates a research demo from a pitch.

> "Three honest limits. The realizations vary *repetition*, which catches
> debounce and duplicate-listener bugs — they are not scheduler nondeterminism,
> so this isn't evidence about replication timing. The prediction numbers in the
> rehearsal come from a hardcoded prediction, so they show the metric
> discriminates, not that any model is calibrated. And we found that the
> bridge's own `place_restore` reverts almost nothing while reporting success —
> we don't use it, and there's a probe in the repo that measures exactly what it
> does and doesn't restore."

## 3:45 — Close

> "An agent that can write code is easy. An agent you'd give write access to has
> to prove its fix *caused* the fix. That's the whole project."

---

## If something breaks

| Symptom | Fix |
| --- | --- |
| `no Roblox Studio session` | Studio → toolbar → Connect; re-run `npm run probe:studio` |
| Bridge times out mid-run | Focus the Studio window; Studio throttles when hidden. The verifier retries timeouts 3× |
| `iso: false` on a case | Real signal, not a bug — a prior condition leaked state. Restart `npm run mcp` |
| No model configured | `npm run verify` and the console still work; the fan-out is the only part that needs a model |
| Console empty | `npx tsx scripts/seed-branches.ts` fills it with real verdicts, no model needed |

## Fallback demo, no model required

`npm run verify` plus `scripts/seed-branches.ts` plus the console covers 0:00
through 3:15 with no model in the loop at all. The only thing lost is the live
subagent fan-out in section 1:45 — describe it from the console instead.
