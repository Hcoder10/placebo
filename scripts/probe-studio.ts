/**
 * Feasibility probe: can real Roblox Studio serve as the causal verifier?
 *
 * The whole public-repo plan rests on four primitives working over MCP:
 *   1. connect to the live Studio session
 *   2. run Luau in it and read a value back
 *   3. snapshot the place  (the counterfactual checkpoint)
 *   4. restore the place   (so treatment and control start identical)
 *
 * If snapshot/restore round-trips cleanly, branch-relative causal scoring works
 * against the real engine and we never need to ship the private shim.
 *
 *   npx tsx scripts/probe-studio.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const STUDIO_MCP = process.env.STUDIO_MCP_URL ?? 'http://localhost:3000/mcp';

const client = new Client({ name: 'placebo-probe', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(STUDIO_MCP)));

/** Calls a tool and returns its text payload, parsed when it is JSON. */
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

function show(label: string, value: unknown): void {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  process.stdout.write(`  ${label.padEnd(26)} ${rendered.slice(0, 160)}\n`);
}

process.stdout.write(`\nprobing ${STUDIO_MCP}\n\n`);

// 1. Attach to the live Studio session. Most tools declare requires_session.
show('session_status', await call('session_status'));
show('session_connect', await call('session_connect'));

// 2. Round-trip Luau: write an attribute, read it back.
show(
  'run_luau (write attr)',
  await call('execution_run_luau', {
    code: 'workspace:SetAttribute("PlaceboProbe", 41) return workspace:GetAttribute("PlaceboProbe")',
  }),
);
show('eval (read attr)', await call('execution_eval_expression', {
  expression: 'workspace:GetAttribute("PlaceboProbe")',
}));

// 3. Checkpoint.
const LABEL = 'placebo-checkpoint';
show('place_snapshot', await call('place_snapshot', { label: LABEL }));

// 4. Diverge from the checkpoint.
show(
  'run_luau (mutate to 99)',
  await call('execution_run_luau', {
    code: 'workspace:SetAttribute("PlaceboProbe", 99) return workspace:GetAttribute("PlaceboProbe")',
  }),
);
show('eval (after mutation)', await call('execution_eval_expression', {
  expression: 'workspace:GetAttribute("PlaceboProbe")',
}));

// 5. Restore — the step that makes treatment and control comparable.
show('place_restore', await call('place_restore', { label: LABEL }));
show('eval (after restore)', await call('execution_eval_expression', {
  expression: 'workspace:GetAttribute("PlaceboProbe")',
}));

process.stdout.write(
  '\nIf the value reads 41 after restore, real Studio can host counterfactual branches.\n\n',
);

await client.close();
