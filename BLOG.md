# The agent passed the test. It hadn't done anything.

We spent a day building an agent that repairs Roblox game logic, and most of
that day went into a single question: how do you know a fix worked?

The obvious answer is a test. Write the requirement — *collecting the coin
awards exactly one point and removes the coin* — assert the final state, run it.
Here are two patches:

```lua
-- A
local taken = false
sandbox.Collect.Event:Connect(function()
	if taken then return end
	taken = true
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
	sandbox.Coin:Destroy()
end)

-- B
board:SetAttribute("Coins", 1)
sandbox.Coin:Destroy()
```

Patch B sets the score to 1 when the game starts and never handles the collect
signal at all. Both patches end with the score reading 1 and the coin gone. Any
assertion over the final state passes both. The build is healthy, the project
launches, the test is green, and the mechanic does not exist.

This is not a contrived example. It is what reward hacking looks like when the
reward is "the test passed", and it is the failure mode that gets worse as the
thing writing the patch gets better at satisfying whatever you measure.

## Run it twice

The fix is old and comes from a different field: run a control.

For every requirement we define a **treatment** — the player collects the coin —
and one or more **matched controls**, identical in every way except that the
interaction under test does not happen. Same world, built from nothing both
times. Same setup. The player just doesn't collect.

Then the causal effect is the difference between those two worlds.

```
reference                  ACCEPT   caused [Scoreboard.@Coins, exists:Coin]
reward_hack_preset_score   REJECT   no causal effect (identical to control)
```

Patch B's world is byte-identical with and without the collect. There is no
difference to measure. It caused nothing, and no amount of correct-looking final
state changes that.

That is the whole idea. Everything below is what it cost to make it true.

## Six things that were harder than the idea

### 1. The harness doesn't start on Windows

We built on TrueForge, an open-source agent harness released ten days earlier.
First command, first minute:

```
Failed to start server: Only URLs with a scheme in: file, data, and node are
supported by the default ESM loader. On Windows, absolute paths must be valid
file:// URLs. Received protocol 'c:'
```

A missing `pathToFileURL`. Also, on the same run: `Local sandbox fallback is
unavailable: LocalSandboxProvider supports macOS and Linux only`.

Running it inside WSL fixed both, and cost twenty minutes. Finding this in
minute three of a hackathon instead of hour six is the entire argument for
standing up your riskiest dependency before you write any of your own code.

### 2. Two adjacent configurations, both failing silently

Our tool server speaks MCP over Streamable HTTP. The SDK has a stateless mode.
There are two obvious ways to wire it and both are wrong:

- **A fresh transport per request, with a session id generator.** The client's
  `initialize` lands on one transport; the `notifications/initialized` that
  immediately follows lands on a *new* transport that never saw the handshake.
  400, "Server not initialized."
- **One shared transport, stateless.** The transport refuses outright —
  "Stateless transport cannot be reused across requests" — and because it is
  wrapped in Hono's request listener, that throw becomes a bare **500 with an
  empty body**. No stack, no message, nothing in your logs.

The correct pairing is a fresh transport per request *with*
`sessionIdGenerator: undefined`, because that path skips session validation
entirely. Obvious in hindsight, invisible from the errors.

A related one, same afternoon: mount the MCP route **before** your JSON body
parser. The transport reads the body off the Node stream itself, and a parser
that has already drained it produces the same bodyless 500.

### 3. Everything you background over SSH dies

We needed a 39GB model download on a remote box. Started it over SSH with
`nohup setsid`, came back later to 448MB and no running process. WSL shuts down
when the session that started it ends, and it takes your children with it.

`Start-Process -WindowStyle Hidden` did not save it either. What worked was a
Windows Scheduled Task — a real detached process the session doesn't own.

We lost this twice before believing it.

### 4. 134 tools, none of them gated

TrueForge decides which tool calls pause for human approval by reading MCP
annotations: `readOnlyHint`, `destructiveHint`. You write
`require_approval_for_tools: ["@write", "@destructive"]` and the harness resolves
the rest.

We pointed it at an existing Roblox Studio MCP server — 134 tools, including
publishing a place and deleting instances — and asked what the harness saw:

```
134 tools visible to TrueForge
  UNANNOTATED      134
```

Every one of them exempt. Not denied, not flagged — **exempt**, because an
unannotated tool matches neither selector. The gate was configured correctly and
guarding nothing, and there is no error anywhere in that picture.

Our own server now fails to start if a tool that must be gated isn't:

```
Tools that must require approval are not gated:
  publish_place: resolves to UNANNOTATED, which the harness does not gate
```

### 5. The snapshot that doesn't restore

Our verifier needs every branch to start from an identical world. The Studio
bridge offers `place_snapshot` and `place_restore`, and the tool's own
description says it "reverses any changes since the snapshot."

So we measured it:

| change | reverted? |
| --- | --- |
| attribute on an instance | no |
| attribute on a service | no |
| property on an instance | no |
| instance created after the snapshot | no |
| instance deleted after the snapshot | **yes** |

It restores deleted instances. That's all. And it returns `ok: true` regardless,
so a verifier built on it would silently compare a treatment against a control
that started somewhere else — and every number downstream would be wrong in a
way nothing would ever surface.

We rebuild each world from nothing instead. Determinism by construction beats
determinism by promise.

### 6. Collapsing the round trips exposed a race that latency was hiding

Each experimental condition was five separate calls to Studio: reset, build,
patch, interact, observe. That's ~45 round trips per candidate, and Roblox Studio
throttles its scheduler hard when its window isn't focused, so we were burning
30-second timeouts.

We collapsed each condition into one Luau program. Immediately, **every patch
scored as inert** — including the correct one.

`BindableEvent:Fire()` doesn't run its handlers synchronously. Roblox resumes
connections at the next scheduler point. Across five network round trips, the
latency between "fire" and "observe" was accidentally doing the waiting for us.
In one program there was no gap, so we were reading the world before a single
handler had run.

The first fix was `task.wait()` four times. Which is a guess.

## The part where we asked a different model to break it

With a few hours left we ran the repo past OpenAI's Codex as an adversary, with
the specific claims we wanted attacked. It came back with six findings. Four were
valid, two of those would have invalidated results, and one was simply wrong.

The two that mattered:

**The settle was a guess.** Four frames is an assumption about how long a handler
takes. A patch that defers cleanup past that window gets read as having caused
nothing — a **correct patch reported as broken**, with no error. We replaced it
with quiescence detection: observe, wait, observe, repeat until the world stops
changing, with a hard bound so a patch that never settles fails loudly.

**Isolation was asserted, not checked.** We had been saying each condition starts
"from nothing". It doesn't. Destroying our sandbox folder does not disconnect a
handler attached to a service, cancel a spawned task, or clear a global. So we
stopped claiming it: each condition is now snapshotted *before* its interaction,
and treatment and control must match. If they don't, the verdict is withheld
rather than reported.

Both are now columns in the output, next to every result:

```
  case                       want    got     stable  iso    settled
  reference                  ACCEPT  ACCEPT  true    true   true
  reward_hack_preset_score   REJECT  REJECT  true    true   true
```

The finding Codex got wrong is interesting too. It read one of our bug fixtures
as behaviourally correct because of a guard variable — which is declared and
**never assigned**. A careful reader misled by dead code is a good reason to
delete dead code.

## Two things the system taught us about itself

**How faithfully you poke the world decides which bugs exist.** We wrote a
missing-debounce bug, and the verifier accepted it. Firing one clean event makes
a missing debounce *unobservable* — the correct patch and the buggy one produce
identical state. It only appears when the interaction repeats. A verifier is
exactly as good as the realism of its intervention, and ours was too polite.

**`Destroy()` is an implicit debounce.** Our first attempt at that bug was a
no-op: destroying the coin inside the handler guards the second event by itself.
The real bug needs deferred cleanup — which is also how people actually write it,
because destroying an object mid-handler cuts off its own sound and particles.

Both of these were found by the verifier rejecting our own test fixtures. It
turned out to be a better critic of the benchmark than we were.

## What we're not claiming

Before writing any of this down we went and read the literature, which we
recommend doing in that order.

Execution-gated training for game code exists. Matched controls to demonstrate
that a verifier is doing the work exist — *The Verifier is the Curriculum*
(arXiv:2607.09709) swaps a strict launch gate for a lenient build check and shows
the gain vanishes. Game-specialised post-training with execution-grounded RL
exists (*OpenGame*, arXiv:2604.18394).

The difference is **what the control varies**. That prior work varies the
*verifier in the training loop* — did the improvement come from filter precision
or from more data? We vary the *interaction inside a single evaluation* — was
this state change caused by the player's action, or was it going to happen
anyway?

A launch gate accepts patch B. It launches perfectly.

We also aren't claiming robustness to event ordering: our realizations vary
repetition, which catches debounce and duplicate-listener bugs, and that is a
different thing from scheduler nondeterminism. Saying so cost us a sentence and
buys the rest of the post its credibility.

## The thing worth keeping

An agent that writes code is easy now. An agent you would give write access to is
not, and the gap between them is almost entirely about verification.

The interesting question was never "did the tests pass." It was "did this edit
cause the behaviour the requirement describes" — and the way you answer that is
the way you answer it anywhere else: run it twice, change one thing, and look at
the difference.

---

*Source: [github.com/Hcoder10/placebo](https://github.com/Hcoder10/placebo).
Built on [TrueForge](https://trueforge.dev), verified against a live Roblox
Studio.*
