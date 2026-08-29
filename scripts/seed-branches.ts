/**
 * Drives the Placebo tools as if each candidate patch were a subagent branch.
 *
 * This is the pipeline rehearsal: it exercises predict_effect, patch_propose and
 * causal_verify over the real MCP surface, against a real Studio, and fills the
 * console with real verdicts — with no model in the loop.
 *
 * The point is not to fake the demo. It is that every part downstream of the
 * model can be proven correct before the model exists, so a serving problem
 * cannot take the whole submission down with it.
 *
 * The predictions below are deliberately what a confident agent would say: each
 * branch claims its patch awards exactly one coin. Several are wrong, and the
 * engine is what says so — which is the calibration signal the metric measures.
 *
 *   npx tsx scripts/seed-branches.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CANDIDATES } from '../src/verifier/patches.js';

const MCP = process.env.PLACEBO_MCP_URL ?? 'http://localhost:9400/mcp';

const client = new Client({ name: 'placebo-seeder', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP)));

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content as { type: string; text?: string }[] | undefined) ?? [];
  try {
    return JSON.parse(content.find(part => part.type === 'text')?.text ?? '{}');
  } catch {
    return {};
  }
}

/**
 * What each branch claims its own patch will do.
 *
 * Every branch predicts the same confident "+1 and the coin goes", because that
 * is what a model reasoning from the requirement produces. The interesting
 * number is how often that claim survives contact with the engine.
 */
const CONFIDENT = {
  effects: { 'Scoreboard.@Coins': '+1', 'exists:Coin': 'true->false' },
  unchanged: ['OtherScoreboard.@Coins'],
};

process.stdout.write(`\nseeding ${String(CANDIDATES.length)} branches through ${MCP}\n\n`);

for (const candidate of CANDIDATES) {
  const branch = candidate.id;
  await call('predict_effect', { branch, ...CONFIDENT });
  await call('patch_propose', { branch, luau: candidate.luau });

  const verdict = (await call('causal_verify', { branch })) as {
    accepted?: boolean;
    inert?: boolean;
    stable?: boolean;
    prediction_score?: string;
    error?: string;
  };

  const outcome = verdict.error
    ? `ERROR ${verdict.error.slice(0, 40)}`
    : `${verdict.accepted ? 'ACCEPT' : 'REJECT'}  prediction ${verdict.prediction_score ?? '-'}  ${verdict.stable ? 'stable' : 'timing-dependent'}${verdict.inert ? '  INERT' : ''}`;

  process.stdout.write(`  ${branch.padEnd(26)} ${outcome}\n`);
}

process.stdout.write(`\nconsole: http://localhost:9400/\n\n`);
await client.close();
