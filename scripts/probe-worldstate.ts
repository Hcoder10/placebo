/**
 * Does *our* restore actually restore?
 *
 * The bridge's `place_restore` claims to reverse changes and does not. Having
 * written a replacement, the same probe is pointed at ours — measuring it
 * rather than trusting the implementation, which is the only reason we know the
 * built-in one is broken.
 *
 *   npx tsx scripts/probe-worldstate.ts
 */
import { StudioSession } from '../src/verifier/studio.js';
import { restoreWorld, snapshotWorld } from '../src/verifier/worldstate.js';

const ROOT = 'workspace.PlaceboProbe';

const session = new StudioSession();
await session.connect();

// A small world standing in for someone's real place: nested instances, a
// property, an attribute, and something that will be deleted.
await session.luau(`
local old = workspace:FindFirstChild("PlaceboProbe")
if old then old:Destroy() end
local root = Instance.new("Folder") root.Name = "PlaceboProbe" root.Parent = workspace

local part = Instance.new("Part")
part.Name = "Platform"
part.Anchored = true
part.Transparency = 0
part:SetAttribute("Score", 5)
part.Parent = root

local nested = Instance.new("Part")
nested.Name = "Child"
nested.Anchored = true
nested.Parent = part

local doomed = Instance.new("Part")
doomed.Name = "Doomed"
doomed.Anchored = true
doomed.Parent = root

local script_ = Instance.new("Script")
script_.Name = "Logic"
script_.Source = "-- original body"
script_.Parent = root

root:SetAttribute("Level", 1)
return "seeded"
`);

const snapshot = await snapshotWorld(session, ROOT);
process.stdout.write(`\nsnapshot of ${ROOT}: ${String(snapshot.nodeCount)} instances\n`);

// Every way a patch can disturb a world.
await session.luau(`
local root = workspace.PlaceboProbe
root.Platform:SetAttribute("Score", 99)          -- attribute changed
root:SetAttribute("Level", 42)                   -- attribute on the root
root.Platform.Transparency = 0.5                 -- property changed
root.Platform.Anchored = false                   -- boolean property changed
root.Doomed:Destroy()                            -- instance deleted
local extra = Instance.new("Part")               -- instance created
extra.Name = "Extra"
extra.Parent = root
local deepExtra = Instance.new("Part")           -- created, nested
deepExtra.Name = "DeepExtra"
deepExtra.Parent = root.Platform
root.Platform.Child:SetAttribute("Tag", "new")   -- attribute added deep
root.Logic.Source = "-- rewritten by a patch"    -- script body edited
return "disturbed"
`);

const report = await restoreWorld(session, snapshot);
process.stdout.write(
  `restore: removed ${String(report.removed)}, recreated ${String(report.recreated)}, reverted ${String(report.reverted)}\n\n`,
);

const checks: [string, string, unknown][] = [
  ['attribute on instance', 'workspace.PlaceboProbe.Platform:GetAttribute("Score")', 5],
  ['attribute on root', 'workspace.PlaceboProbe:GetAttribute("Level")', 1],
  ['number property', 'workspace.PlaceboProbe.Platform.Transparency', 0],
  ['boolean property', 'workspace.PlaceboProbe.Platform.Anchored', true],
  ['deleted instance back', 'workspace.PlaceboProbe:FindFirstChild("Doomed") ~= nil', true],
  ['created instance gone', 'workspace.PlaceboProbe:FindFirstChild("Extra") == nil', true],
  ['nested creation gone', 'workspace.PlaceboProbe.Platform:FindFirstChild("DeepExtra") == nil', true],
  ['added attribute gone', 'workspace.PlaceboProbe.Platform.Child:GetAttribute("Tag") == nil', true],
  ['script source', 'workspace.PlaceboProbe.Logic.Source', '-- original body'],
];

process.stdout.write(`  ${'change kind'.padEnd(24)} ${'want'.padEnd(7)} ${'got'.padEnd(7)} reverted?\n`);
process.stdout.write(`  ${'-'.repeat(24)} ${'-'.repeat(7)} ${'-'.repeat(7)} ---------\n`);

let restored = 0;
for (const [label, expression, want] of checks) {
  const got = await session.luau(`return ${expression}`);
  const ok = String(got) === String(want);
  restored += ok ? 1 : 0;
  process.stdout.write(
    `  ${label.padEnd(24)} ${String(want).padEnd(7)} ${String(got).padEnd(7)} ${ok ? 'yes' : 'NO'}\n`,
  );
}

process.stdout.write(`\n  ${String(restored)}/${String(checks.length)} kinds of change reverted\n\n`);

await session.luau(`
local root = workspace:FindFirstChild("PlaceboProbe")
if root then root:Destroy() end
return "cleaned"
`);
await session.close();

if (restored !== checks.length) process.exitCode = 1;
