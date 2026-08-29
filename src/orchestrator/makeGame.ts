import { join } from 'node:path';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { MCP_SERVER_NAME } from './spec.js';
import { assertGated, setup } from './setup.js';

/**
 * Build a game from a request, with every mechanic causally verified.
 *
 *   npx tsx src/orchestrator/makeGame.ts "a coin game where three coins open a door"
 *
 * The division of labour is the point. The agent builds the world, states what
 * each mechanic should do, and writes the code. It does not get to decide
 * whether its own spec is worth anything: `contract_propose` audits every
 * contract by running it against an empty implementation, and a contract
 * satisfied by no code at all is rejected before it can be used.
 *
 * What no amount of machinery decides is whether the contract describes the
 * game the audience asked for. That judgement stays with a person, which is
 * what the approval step in the console is for.
 */

const ROOT = join(import.meta.dirname, '..', '..');

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  // defaults below apply
}

const BASE_URL = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
const MCP_HOST = process.env.PLACEBO_MCP_HOST ?? 'http://localhost:9400';
const MODEL = process.env.PLACEBO_MODEL ?? 'selfhosted/gpt-oss-20b';

const MUST_BE_GATED = ['patch_propose', 'world_build', 'contract_propose', 'publish_place'];

const INSTRUCTIONS = `
Build a small Roblox game. Work in this order and call one tool at a time.

1. world_build — build the space. \`sandbox\` and \`kit\` are in scope; lighting
   and ground are already there. Use the kit, not Instance.new:
     kit.platform(sandbox, x, y, z, width, depth)
     kit.coin(sandbox, x, y, z)      kit.door(sandbox, x, y, z, axis)
     kit.hazard(sandbox, x, y, z, width, depth)   kit.spawn(sandbox, x, y, z)
     kit.wall(sandbox, x, y, z, length, axis)     kit.decor(sandbox, x, y, z, kind)
   Each returns the instance, so you can attach Attributes. A character is 5
   studs tall and jumps 7; vary heights so it reads as a level. Add a
   BindableEvent for each player action, because edit mode runs no physics.

2. design_check — fix anything it reports, then check again.

3. contract_propose — one mechanic:
     treatment "sandbox.Collect:Fire()"   control "-- nothing"
     effects "Score.@Points:+1, exists:Coin:true->false"
     non_effects "Other.@Points"          reference <your Luau>
   The treatment fires the trigger; the implementation reacts to it. A contract
   satisfied by no implementation is rejected.

4. patch_propose, then causal_verify with your contract_id. If rejected, read
   what the engine observed and fix it.

Repeat 3-4 for each mechanic requested. Then call contract_list and summarise.
Do not publish.
`.trim();

async function main(): Promise<void> {
  const request = process.argv.slice(2).join(' ').trim();
  if (!request) {
    process.stdout.write('usage: makeGame.ts "<what the game should do>"\n');
    process.exitCode = 1;
    return;
  }

  const client = new TrueForge({ baseUrl: BASE_URL, timeoutInSeconds: 2400 });

  const registration = await setup({ client, mcpUrl: `${MCP_HOST}/mcp` });
  assertGated(registration.tools, MUST_BE_GATED);

  await fetch(`${MCP_HOST}/api/reset`, { method: 'POST' }).catch(() => undefined);

  const { data: session } = await client.sessions.create({
    agent: {
      spec: {
        model: {
          name: MODEL,
          // Every failure of this run so far has been a token-budget failure
          // wearing a different hat, and all of them trace to how much this
          // model thinks before it acts.
          //
          //   run 4: `Input length (18441) exceeds maximum (16384)`
          //   run 5: `max_tokens breached` at 8192 output, having written the
          //          tool call as markdown JSON instead of calling the tool
          //
          // `low` reasoning effort is the lever that addresses both: gpt-oss
          // spends thousands of tokens deliberating by default, and on a task
          // that is mostly "call the right tool with the right arguments" that
          // deliberation is what overflows the window, not the work.
          //
          // temperature 0 for the second failure specifically. Format drift --
          // describing a tool call rather than making one -- is a sampling
          // accident, and there is no reason to sample here: we want the most
          // likely tool call, not a creative one.
          //
          // `reasoningEffort` is not settable here -- TrueForge answers 422,
          // "does not support configurable reasoning effort", for this model.
          // The effort directive goes in the system prompt instead, which is
          // how gpt-oss takes it natively anyway.
          params: {
            temperature: 0,
            maxTokens: 8192,
            parallelToolCalls: false,
          },
        },
        instructions: INSTRUCTIONS,
        mcp_servers: [
          {
            name: MCP_SERVER_NAME,
            enable_tools: ['@all'],
            // Only the irreversible publish stops. World building and patches
            // are scoped to the sandbox and rebuilt between conditions, so
            // gating them would put a prompt in front of every step and train
            // the operator to click through the one that matters.
            require_approval_for_tools: ['@destructive'],
            preload: true,
          },
        ],
        config: {
          iteration_limit: 120,
          sandbox: { enabled: false, file_downloads: false },
          dynamic_sub_agents: { enabled: false },
          context_management: { compaction: { enabled: true }, large_tool_response: { enabled: true } },
          generative_ui: { enabled: false },
          ask_user_questions: { enabled: false },
        },
      } as never,
    },
  });

  process.stdout.write(`\n  request: ${request}\n  model:   ${MODEL}\n  session: ${session.id}\n\n`);

  const stream = await client.sessions.createTurnStream(session.id, {
    input: [{ type: 'user.message', content: `Build this game: ${request}` }] as never,
  });

  let final = '';
  for await (const { data } of stream.withMetadata()) {
    const event = data as unknown as { type: string; content?: unknown; tool_calls?: unknown[] };

    if (event.type === 'model.message') {
      const calls = (event.tool_calls ?? []) as { tool_info?: { name?: string } }[];
      for (const call of calls) {
        const name = call.tool_info?.name;
        if (name) process.stdout.write(`  -> ${name}\n`);
      }
      if (typeof event.content === 'string' && event.content) final = event.content;
    }
  }

  const state = (await (await fetch(`${MCP_HOST}/api/state`)).json()) as {
    authored?: { worldSteps: number; contracts: { id: string; approved: boolean; usable: boolean }[] };
    branches?: Record<string, { verdict?: { accepted?: boolean } }>;
  };

  process.stdout.write(`\n  world steps: ${String(state.authored?.worldSteps ?? 0)}\n`);
  process.stdout.write(`  contracts that survived audit:\n`);
  for (const entry of state.authored?.contracts ?? []) {
    process.stdout.write(`    ${entry.id}  ${entry.usable ? 'audited' : 'REJECTED'}\n`);
  }
  const accepted = Object.values(state.branches ?? {}).filter(b => b.verdict?.accepted).length;
  process.stdout.write(`  mechanics verified: ${String(accepted)}\n`);
  process.stdout.write(`\n${final}\n\n  approve contracts at ${MCP_HOST}/\n\n`);
}

await main();
