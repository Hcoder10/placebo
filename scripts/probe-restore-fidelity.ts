/**
 * What does place_restore actually revert?
 *
 * Branch-relative causal scoring is only valid if every branch starts from a
 * byte-identical world. `place_restore` returned ok while leaving a mutated
 * attribute in place, so this maps the gap precisely across the four kinds of
 * change a patch can make.
 *
 *   npx tsx scripts/probe-restore-fidelity.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const STUDIO_MCP = process.env.STUDIO_MCP_URL ?? 'http://localhost:3000/mcp';
const LABEL = 'placebo-fidelity';

const client = new Client({ name: 'placebo-fidelity', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(STUDIO_MCP)));

async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content as { type: string; text?: string }[] | undefined) ?? [];
  const text = content.find(part => part.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function luau(code: string): Promise<unknown> {
  const out = (await call('execution_run_luau', { code })) as { data?: { value?: unknown } };
  return out?.data?.value;
}

await call('session_connect');

// A clean baseline: one part, one attribute, one property.
await luau(`
local old = workspace:FindFirstChild("FidelityPart")
if old then old:Destroy() end
local p = Instance.new("Part")
p.Name = "FidelityPart"
p.Anchored = true
p.Transparency = 0
p.Parent = workspace
p:SetAttribute("Score", 1)
workspace:SetAttribute("WorldScore", 1)
return "baseline"
`);

await call('place_snapshot', { label: LABEL });

// Four independent kinds of divergence.
await luau(`
workspace.FidelityPart:SetAttribute("Score", 99)      -- attribute on existing instance
workspace:SetAttribute("WorldScore", 99)              -- attribute on a service
workspace.FidelityPart.Transparency = 0.5             -- property on existing instance
local extra = Instance.new("Part")                    -- instance created after snapshot
extra.Name = "FidelityExtra"
extra.Parent = workspace
local doomed = workspace:FindFirstChild("FidelityPart2")
return "diverged"
`);

// A separate part that exists at snapshot time and is deleted after it.
await luau(`
local p2 = Instance.new("Part") p2.Name = "FidelityDoomed" p2.Parent = workspace return "seeded"
`);
await call('place_snapshot', { label: `${LABEL}-2` });
await luau(`workspace.FidelityDoomed:Destroy() return "deleted"`);

await call('place_restore', { label: LABEL });
await call('place_restore', { label: `${LABEL}-2` });

const checks: [string, string, unknown][] = [
  ['attribute on part', 'workspace.FidelityPart:GetAttribute("Score")', 1],
  ['attribute on service', 'workspace:GetAttribute("WorldScore")', 1],
  ['property on part', 'workspace.FidelityPart.Transparency', 0],
  ['created instance removed', 'workspace:FindFirstChild("FidelityExtra") == nil', true],
  ['deleted instance restored', 'workspace:FindFirstChild("FidelityDoomed") ~= nil', true],
];

process.stdout.write(`\n  ${'change kind'.padEnd(26)} ${'want'.padEnd(8)} ${'got'.padEnd(8)} reverted?\n`);
process.stdout.write(`  ${'-'.repeat(26)} ${'-'.repeat(8)} ${'-'.repeat(8)} ---------\n`);

for (const [label, expression, want] of checks) {
  const got = await luau(`return ${expression}`);
  const ok = String(got) === String(want);
  process.stdout.write(
    `  ${label.padEnd(26)} ${String(want).padEnd(8)} ${String(got).padEnd(8)} ${ok ? 'yes' : 'NO'}\n`,
  );
}

await luau(`
for _, n in {"FidelityPart", "FidelityExtra", "FidelityDoomed"} do
  local i = workspace:FindFirstChild(n) if i then i:Destroy() end
end
workspace:SetAttribute("WorldScore", nil)
workspace:SetAttribute("PlaceboProbe", nil)
return "cleaned"
`);

process.stdout.write('\n');
await client.close();
