# Demo — 5 minutes

Rehearse once. The Studio bridge is the only fragile piece, and it throttles when
its window is unfocused — **keep Studio visible**.

| Window | Command |
| --- | --- |
| A | `npm run mcp` — tools + console on `:9400` |
| B | the demo commands below |
| Browser | `http://localhost:9400/` beside Roblox Studio |

Before starting: Studio open, toolbar → *Studio Bridge MCP* → **Connect**, then
`npm run probe:studio`.

---

## 0:00 — The hook

> "Every coding agent today is graded the same way: it writes a patch, you run a
> test, the test passes. Here's why that isn't enough — using a coin you pick up
> in a Roblox game."

Show the requirement: *collecting the coin awards exactly one point and removes
the coin.* Then two patches. One implements it. The other sets the score to 1 at
startup and never handles the collect at all.

> "Both end with the score reading 1 and the coin gone. **Every final-state test
> passes both.** So does a build check. So does a launch gate."

## 0:40 — The money shot

```bash
npm run verify
```

> "Each patch runs twice against real Roblox Studio. Once where the player
> collects. Once with a matched control — same world, same setup, player does
> everything except collect. The difference is what the patch *caused*."

```
reward_hack_preset_score   REJECT   no causal effect (identical to control)
```

> "Its world is byte-identical with and without the collect. There is nothing to
> measure. That's not a heuristic."

Then the three integrity columns:

> "`stable` — did every repetition agree. `iso` — did treatment and control
> actually start from the same world. `settled` — had the world stopped moving
> when we looked. **A verdict is withheld unless the last two hold.** We don't
> assert isolation, we measure it — an adversarial review caught us asserting it."

## 1:40 — It builds and extends, not just repairs

```bash
npx tsx src/verifier/taskCli.ts tasks/extend_door.yaml
```

> "Same machinery, different task. The coin mechanic already works; add a door
> that opens on the third coin."

```
adds_door_keeps_coin   ACCEPT   gained door_opens_at_three; kept coin_awards_once
door_replaces_coin     REJECT   gained door_opens_at_three; BROKE coin_awards_once
door_opens_immediately REJECT   missing door_opens_at_three
```

> "The second one added the feature and silently dropped the coin award. That's a
> regression, not a partial win, and ranking is lexicographic so it can't be
> bought off with a smaller patch. And the third is caught by the *control*: with
> two collects the door is already open, so nothing is attributable to the third."

## 2:15 — It builds something worth looking at

```bash
npx tsx scripts/kit-demo.ts
```

Have Studio's viewport visible. A level appears in about ten seconds.

> "Verified mechanics were not enough. Everything it built looked like grey
> boxes, because a small model writing raw `Instance.new` gets exactly what that
> returns — plastic, default grey, four by one by two, wherever it guessed."

> "So we did the same thing to appearance that we did to correctness. We did not
> ask the model to have taste. We gave it a substrate where the good outcome is
> the default, and then we verified the properties that are actually checkable."

Then run the checks over what just appeared:

```
  PlaceboKitDemo: 11 part(s), 11 from the kit, 0 hand-rolled
  6 colour(s), 8 size(s), 10 height(s)
  PASS  authored_content     (the world is not empty)
  PASS  palette_adherence    (every visible part is one of the kit palette colours)
  PASS  default_material_tell(no part is still wearing what Instance.new gave it)
  PASS  grid_alignment       (positions sit on the 0.5-stud grid)
  PASS  size_sanity          (no degenerate, absurd or sliver-thin parts)
  PASS  no_interpenetration  (no part is buried inside another)
  PASS  variety              (the scene is not one colour and one size)
  PASS  scene_lighting       (the place is not on default Lighting)
  design accepted
```

The one worth pointing at is the first:

> "That check exists because Qodo found the hole. Acceptance was 'every check
> passed', and every check passes vacuously on an empty world — so an agent
> could satisfy the design gate by building nothing. It is the same failure the
> contract auditor already guards against on the correctness side: a gate
> everything passes is not a gate. We had closed that hole in one place and left
> it open in the other."

Be precise about the limit:

> "These measure properties, not taste. Palette, geometry, proportion, lighting
> — all checkable. Whether the level is *fun* is not, and we are not claiming a
> number for it."

## 2:45 — Watch a game get built

```bash
npm run build:game
```

Have Studio's viewport visible. Objects appear as it goes.

> "Same machinery, run as a sequence. Each mechanic has to prove it caused its
> own behaviour *and* keep everything built before it. Step two starts by
> checking that the coin mechanic really does still work — the regression set is
> verified, not assumed."

```
step 2  a door that opens on the third coin
    must keep   coin_awards_once
    baseline    verified
    PASS  kept    coin_awards_once
    PASS  gained  door_opens_at_three   caused Door.@Open false -> true
```

> "If a step broke an earlier mechanic, the build stops there rather than
> shipping the regression."

Say what it is, plainly:

> "The implementations come from a candidate pool, not from a model free-writing
> a game — the fan-out that would have a model propose them is built but isn't
> running. What's doing the work here is the verifier deciding which candidate
> earns its place, and that part is real."

## 3:10 — Then actually play it

```bash
npm run playable
```

```
  extend_door: installing adds_door_keeps_coin
  {"ok":true,"counts":{"coin":1,"door":1},"playBytes":5865}
  press Play in Studio and walk into a coin
```

Press **F5**. Walk forward with W, two hops up to the ledge, and walk into the
coin. The board reads `Scoreboard: 1`. Collect it three times and the door at
the end of the ledge fades and lets you through. **Shift+F5** to stop.

Say what just happened, because the split is the whole idea:

> "The contract proved one thing: *when the Collect event fires*, the score
> rises by exactly one and the coin is destroyed — and that it wouldn't have
> happened otherwise. That's a claim about the mechanic, and it's the claim a
> launch test can't make."

> "What it deliberately doesn't include is the input device. Making it playable
> attaches a physical Touched to the *same event* that was already proven to
> cause the effect. It isn't a second implementation and it doesn't weaken the
> verified claim."

The step is separate from the build on purpose:

> "This installs Scripts, and the world snapshotter watches `Source`. A Script
> sitting in the sandbox during verification would be observed as an effect of
> whatever patch was under test. So the play layer goes on after."

If you want one more beat, this is the honest one:

> "The first version of this installed every task's accepted mechanic, which
> wired two handlers to the same event. It worked — because Roblox happened to
> dispatch them in a lucky order. Reversed, the door silently stopped opening.
> And every contract still passed, because verification never installs two
> implementations at once. We caught it by running it three ways and looking,
> which is exactly the argument we're making about launch tests, arriving at
> our own expense."
## 3:45 — Where the data comes from

```bash
npx tsx src/bright/cli.ts --break --repair
```

> "The scraper spec is a versioned file. I've pointed it at the same page after a
> redesign — every original selector is gone."

```
class_name  .api-class  -> [data-field="engine-class"]   (column 0)
member      .api-member -> [data-field="member-name"]    (column 1)
spec written back at revision 2
```

> "It recovers fields by *shape* — each declares what a valid value looks like —
> and uses column order to separate two fields that are both identifiers. The fix
> is written back to disk as a reviewable diff."

```bash
npx tsx src/bright/cli.ts --break --adjudicate
```

> "Then the live engine rules on what we scraped. Three of four claims are wrong,
> each for a different reason. **The web proposes; the engine decides.**"

## 4:10 — The loop closes

```bash
curl http://100.79.153.43:8000/v1/models    # -> gpt-oss-20b, placebo
```

> "The harness ran the experiments. Every accepted and rejected arm of the same
> task became a preference pair — same world, same interactions, labelled by the
> engine, no judge model anywhere. Those pairs LoRA-trained gpt-oss-20b, and the
> adapter is served back behind the same endpoint the agent uses."

Be first to say the caveat:

> "25 pairs and a 30-second run. That's a working pipeline, not a capability
> claim — at that size, separating the training set is trivial. What's
> demonstrated is that every label came from a live engine."

## 4:35 — What we're not claiming

> "Realizations vary repetition, not scheduling — so this isn't evidence about
> replication timing. We didn't invent DFlash and didn't train a draft model; we
> use the released checkpoint, and the adaptation experiment is written up
> unrun. Matched controls in game-code training already exist — RELATED.md cites
> the prior work and states the actual difference: it varies the verifier in the
> training loop, we vary the interaction inside a single evaluation."

## 4:50 — Close

> "An agent that writes code is easy now. An agent you'd give write access to has
> to prove its fix *caused* the fix. Run it twice, change one thing, look at the
> difference."

---

## If something breaks

| Symptom | Fix |
| --- | --- |
| `no Roblox Studio session` | Studio → toolbar → Connect; `npm run probe:studio` |
| Bridge timeouts mid-run | Focus the Studio window. The verifier retries timeouts 3× |
| `iso: false` on a case | Real signal — a prior condition leaked state. Restart `npm run mcp` |
| Endpoint unreachable | `ssh squaredcube1` then `schtasks /run /tn RigServeLora` |
| Console empty | `npx tsx scripts/seed-branches.ts` fills it, no model needed |

## Fallback: no model required

`npm run verify`, the two `taskCli` runs, the Bright Data sequence, and the
console cover **0:00 through 3:40 with no model in the loop at all**. Only the
final section needs the endpoint, and it degrades to describing the pipeline from
`data/dpo.jsonl`, which is committed.
