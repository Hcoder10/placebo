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

## Ten things that were harder than the idea

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

### 7. Four ways to measure a model's incompetence that measure your own

The flywheel bootstrapped on hand-written candidates: one correct
implementation and some plausible ways to get it wrong. That works exactly
once. Turn one consumed all eighteen; turn two added nothing. So we started
sampling candidates from the model itself.

The first batch came back and the engine rejected twenty out of twenty. A
clean, damning number about a small model's ability to write game code.

It was a number about our extractor. gpt-oss answers on one Harmony channel
and reasons on another, and when the answer channel was empty we fell back to
the reasoning channel — so twenty English paragraphs *about* the coin mechanic
were evaluated as if they were the coin mechanic. The answer channel was empty
because the token budget was 400 and the model had spent all 400 thinking.
`finish_reason: length`, every time.

Three more of the same species surfaced once we started looking:

- A failed HTTP request and an unusable answer shared one counter. A saturated
  endpoint and an incapable model both drive yield to zero, and they have
  opposite remedies.
- Truncation shared a counter with unusable output, so "the budget was too
  small" was recorded as "the model produced garbage."
- The filter that rejected prose required the text to mention `sandbox` — which
  silently discarded every sample that reached for `game:GetService` instead. A
  real and instructive mistake, thrown away by the thing that was supposed to
  be protecting the corpus.

Each of these produces a plausible number. None of them produces a true one.
The whole project exists because a passing test can mean nothing; it turns out
a failing measurement can mean nothing in exactly the same way, and we wrote
four of them before breakfast.

### 8. We built a gate that everything passes, in the one place we weren't looking

We handed the repository to Qodo. It came back with eight bugs. All eight were
real. The first one was the one that mattered:

> `analyzeParts` derives acceptance only from checks that all pass for an empty
> or bootstrap-ground-only scene. A model can therefore call `world_build` with
> no meaningful content and satisfy the new mandatory `design_check` gate.

Acceptance was `checks.every(check => check.pass)`. Every check is vacuous on a
world with nothing in it: the ground plane is excluded from the variety test,
low part counts bypass variety findings, and none of the others have anything
to look at. Build nothing, pass everything. A test in our own suite *codified*
accepting a scene with zero parts.

The part that stings is that this is the project's central idea. The contract
auditor exists precisely to reject a specification that an empty implementation
satisfies — run it against no code, and if the effects still appear, the
contract describes the world rather than the code. We had that argument
written down, implemented, and tested on the correctness side. Then we built a
second gate for appearance and left the identical hole in it.

Knowing the failure mode is not the same as recognising it. It helps to have
something that has not spent a day being pleased with the idea.

### 9. A contract can be well-formed, non-trivial, and still not say what you meant

Qodo's second finding was subtler and took longer to accept.

We had written a repair task: two chests, two keys, and a bug where any key
opens every chest. The contract said KeyA must unlock ChestA, listed
`ChestB.@Locked` under `non_effects`, and used two controls — one where nothing
happens, one where the *other* key is used.

It passes an implementation that opens ChestB on any key at all.

`non_effects` is differential. A key is reported as collateral only when the
treatment and a control disagree about it. Against `never_uses`, ChestB moves.
Against `uses_other_key`, ChestB moves in both, so they agree. The two controls
disagree with each other, and a key the controls disagree about is *dropped*
rather than counted against the patch. The bug becomes invisible precisely
because it is indiscriminate.

The fix was two symmetric contracts, one per key, each with controls that never
touch the other chest — so every wrong behaviour shows up as a real difference.
Driven live afterwards, the buggy baseline is rejected from both sides with
collateral on the opposite chest, and the correct fix is accepted by both.

What is worth carrying: the original contract passed its own triviality audit
and its own reference implementation. Every automatic check we had said it was
fine. A specification can be well-formed, non-trivial, satisfiable, and still
describe something other than what you wanted, and there is no mechanical test
for that last part.

### 10. Two rounds of prompt engineering to work around a parser

The agent that builds a game from a request kept dying, and it kept dying
differently. It blew the context window. It hit the output cap having written
its tool call as markdown JSON instead of calling the tool. It guessed the name
of an MCP server nobody had told it. It corrupted its own JSON escaping past a
thousand characters of embedded Luau.

Underneath two of those was one bug that had nothing to do with the model:

```
Tool call_tool<|channel|>commentary not found in tool mapping
```

vLLM's streaming Harmony parser assembles the channel marker into the function
name. The same request, not streamed, returns a clean tool call in 121 tokens —
verified directly against the endpoint. The tokens were always fine; the
incremental assembly of them was not.

It correlates with prompt length, because past some size the model starts
answering on the `commentary` channel. So it looks exactly like a prompt
problem, and we shortened the prompt twice to make it go away, and both times
it came back. We were tuning a prompt to avoid a parser.

There is a general lesson in there that is more annoying than profound: when a
failure correlates with something you control, you will keep adjusting that
thing. The correlation was real and the causation was somewhere else entirely.
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

And we are not claiming we made anything faster. We adapted the released DFlash
drafter on the system's own traces and it worked on the metric it targets --
accepted length 2.17 to 2.44, acceptance 14.6% to 18.0% -- measured against a
noise floor we established by running the *same* released drafter twice and
watching it return 2.23 and then 2.17. Throughput went 209.2 to 212.1, which is
inside that noise. The drafter got twelve percent better at predicting the
target and generation did not get faster, because on a GPU that is not
bandwidth-starved, verification was never the bottleneck.

It would be easy to report the first pair of numbers and stop. They are the ones
that sound like a result. The second pair is what tells you whether the first
pair bought anything, and on this hardware it did not.

One more thing about that number, because it changes what it means: 1641 of the
1644 traces we collected finish on `length` rather than `stop`, and every one of
them opens on gpt-oss's `analysis` channel. The corpus is essentially reasoning
text. So this is acceptance over the model's *thinking*, not over Luau source.
The evaluation has the same composition, which is very likely why the gain
transferred at all -- but nobody should read it as "game code became more
predictable.

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
