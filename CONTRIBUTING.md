# Contributing

## Running the verifier

Everything except the model work runs against a local Roblox Studio:

```bash
npm install
npm test          # 16 unit tests, no Studio needed
npm run verify    # 7 candidates against a live Studio
```

Studio must be open with the bridge plugin connected: toolbar → **Studio Bridge
MCP** → **Connect**. Confirm with `npm run probe:studio`.

## Writing a contract

A contract is a requirement expressed as an intervention and the effects it must
cause. Three rules, each of which exists because breaking it produced a wrong
answer at some point:

**Every contract needs a matched control.** Without one it can only assert final
state, which is the thing this project exists to stop trusting. `ContractSchema`
refuses to load a contract with an empty `controls` list.

**A control must differ from the treatment in the interaction alone.** A control
that creates an instance the treatment does not is structurally different, and
that difference shows up as a spurious effect. Build shared objects in `setup`.

**Make the intervention realistic.** Firing one clean event makes a missing
debounce *unobservable* — the correct implementation and the buggy one produce
identical state. If a bug class should be detectable, the interaction has to
provoke it.

## Writing a task

Tasks combine contracts and declare what already holds:

```yaml
mode: extend
setup: |            # the world every contract in this task shares
baseline: |         # what the agent starts from
contracts: [...]
already_satisfied: [contract_id]   # the regression set
```

`already_satisfied` is checked, not trusted. `verifyBaseline` runs the baseline
against those contracts first and refuses to score anything if they do not
actually hold — otherwise every candidate looks like a regression and the
ranking is meaningless.

## Adding an MCP tool

Annotate it. TrueForge resolves `@write` and `@destructive` from `readOnlyHint`
and `destructiveHint`, so an **unannotated tool is silently exempt from
approval**. `assertGated` fails startup if a tool that must pause would not.

Reversible, sandbox-scoped writes should not be gated. Putting an approval
prompt in front of routine work trains an operator to click through the one that
matters.

## Working with Roblox Studio

Three engine behaviours that cost real debugging time:

- **Signals are deferred.** `BindableEvent:Fire()` does not run handlers
  synchronously. Observing immediately after firing reads a world where nothing
  has happened yet. Wait for quiescence.
- **Studio throttles when unfocused.** The bridge long-polls a plugin, so a
  hidden Studio window turns into 30-second tool timeouts. Keep it visible.
- **`place_restore` does not restore.** Measured: it re-adds deleted instances
  and reverts nothing else, while returning `ok: true`. See
  `scripts/probe-restore-fidelity.ts`. Build worlds from scratch instead.

## Style

Strict TypeScript, no `any` in new code. Comments explain *why* a decision was
made, especially where the obvious approach is wrong — several of the comments in
this repo exist because the obvious approach produced a confidently wrong number.
