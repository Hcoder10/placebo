# Wiring the visual kit

Two new files, no existing file touched:

- `src/verifier/kit.ts` — `KIT_LUAU`, a `kit` table of pre-styled constructors injected
  into scope before the agent's world-building code runs, plus the palette and grid
  constants in TypeScript.
- `src/verifier/design.ts` — `inspectDesign(session, root)`, which measures how the built
  world looks and returns per-check findings with a repair for each one.

Everything below is additive. Tests: `tests/kit.test.ts`, `tests/design.test.ts` (66 tests
pass across the suite, typecheck clean).

## 1. `src/mcp/server.ts`

**Imports** (next to the other `../verifier/*` imports):

```ts
import { inspectDesign, renderDesignReport } from '../verifier/design.js';
import { KIT_BRIEF, withKit } from '../verifier/kit.js';
```

**`world_build` — put the kit in scope.** There are two places this can go, and they
are mutually exclusive. Pick one.

*Option A — server-side only, nothing else touched.* One word changes in the handler:

```ts
    async ({ luau }) => text(await authoring.build(await session(), withKit(luau))),
```

*Option B — in `authoring.ts`, which is cheaper and is what the in-progress edit there
is doing.* The kit ends up in the replayed `setup()` exactly once instead of once per
step. It needs **both** halves or it breaks:

```ts
import { withKit } from '../verifier/kit.js';   // the import currently missing

  // in build(): execute WITH the kit, but store the step RAW
  await session.luau(`
local sandbox = ...
${withKit(luau)}
return "built"
`);
  this.worldSteps.push(luau);                    // raw, not wrapped

  // in setup(): wrap the whole replay once
  setup(): string {
    return withKit(this.worldSteps.map(step => `do
${step}
end`).join('
'));
  }
```

With Option B, `world_build` in `server.ts` passes `luau` unchanged — wrapping in both
places would put a second copy of the kit inside every stored step.

Either way, `withKit` prepends the kit, applies lighting and a ground plane (both
idempotent), and wraps the agent's own Luau in a `do ... end` block. The block matters:
`Authoring` executes each step alone but replays them concatenated when a contract
rebuilds the world, and the block makes those two paths behave identically.

**`world_build` — tell the model the kit exists.** Append `KIT_BRIEF` to the tool's
`description` so it arrives with the tool list:

```ts
      description:
        'Runs Luau that creates or configures instances under the sandbox root. `sandbox` is in scope. Each call is remembered so the contracts you write afterwards can rebuild this world from nothing.\n\n' +
        KIT_BRIEF,
```

**A new read-only tool**, next to `contract_list`:

```ts
  server.registerTool(
    'design_inspect',
    {
      title: 'Check how the world you built looks',
      description:
        'Measures the appearance of the built world: palette adherence, untouched Instance.new defaults, grid alignment, size sanity, interpenetrating geometry, variety and lighting. Every failure names the instance, what was observed, and the one call that repairs it.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const report = await inspectDesign(await session(), authoring.root);
      return text({ ...report, summary: renderDesignReport(report) });
    },
  );
```

It is read-only, so it needs no entry in `MUST_BE_GATED`.

**Optional — put the place's lighting back on reset.** `kit.scene()` is the kit's only
side effect outside the sandbox root, and it stashes the previous values on `Lighting`
itself so they survive the folder being destroyed. If you want `/api/reset` to undo it:

```ts
import { KIT_LIGHTING_RESTORE_LUAU } from '../verifier/kit.js';

// inside app.post('/api/reset', ...), before res.json:
  void session().then(active => active.luau(KIT_LIGHTING_RESTORE_LUAU)).catch(() => undefined);
```

Skipping this is safe for the demo — the lighting change is idempotent and identical
across treatment and control, so it cannot affect a causal verdict. It only means the
place keeps the kit's sky until someone resets it.

## 2. `src/orchestrator/makeGame.ts`

**Import:**

```ts
import { KIT_BRIEF } from '../verifier/kit.js';
```

**In `INSTRUCTIONS`** (already a template literal, so `${KIT_BRIEF}` interpolates),
replace step 1's body and add a step 4:

```
1. world_build — create the objects the mechanic needs. \`sandbox\` is in scope.

${KIT_BRIEF}

   Use BindableEvents for player actions (Studio's edit mode does not run
   physics, so a Touched event will never fire). Give score-like values as
   Attributes, because those are what the verifier can observe.
```

```
4. design_inspect — once the mechanics are accepted, check how the world looks.
   Every failure names the instance and the call that fixes it; apply those with
   world_build and inspect again. Do not summarise until it passes.
```

## What this costs

The kit prelude is 8.6 KB of Luau. Under Option A it is prepended to every world-building
step, and a contract's `setup` is those steps concatenated, so a ten-step build sends
roughly 86 KB per condition — fine over the bridge, since the timeouts are Studio's
scheduler rather than payload size. Under Option B it appears once per condition
regardless of step count, which is why Option B is worth the extra edit.

Either way the prelude declares exactly one top-level local (asserted by a test), so it
cannot run into Luau's 200-local limit even when repeated.

## What I would not claim

`variety` is the weakest of the eight checks and is flagged as such in the code: colour
and size uniformity are gated independently, and a scene can legitimately be uniform on
either axis. The other seven are mechanical facts about the world.

`no_interpenetration` has two stated exclusions, both to keep it from firing on correct
scenes:

- The ground plane, on both sides of every pair, because a platform laid at ground level
  shares studs with the floor by construction.
- Parts rotated off the world axes. An axis-aligned bounding box is only the part itself
  when the rotation is a signed permutation — identity or a multiple of a quarter turn —
  and two *disjoint* parts at 45 degrees can share a bounding box. The check reports how
  many parts it skipped in its `note` rather than guessing about them. Everything the kit
  builds is axis-aligned, the yawed coin included, so nothing is skipped in a kit-built
  scene. A proper oriented-box test would lift the restriction; an AABB test over rotated
  parts would just produce confident false findings.

`authored_content` fails a world containing nothing but the bootstrap ground plane. Every
other check is a statement about parts, so without it a world with no parts satisfies all
of them and an agent could clear the design gate by building nothing — the same hole
`validate.ts` closes for contracts. The threshold is zero authored parts rather than some
minimum part count: it rules out the vacuous case, which is what it can defend, and does
not pretend to know how many parts a game ought to have.
