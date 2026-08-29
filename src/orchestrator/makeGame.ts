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
You build small Roblox games that are worth playing, one mechanic at a time,
and you prove each one works.

BUILD THE SPACE FIRST, THEN THE MECHANICS.

1. world_build — create the objects the game needs. \`sandbox\` and \`kit\` are
   in scope. Lighting and a ground plane are already applied.

   Build with the kit, not with raw Instance.new:
     kit.platform(sandbox, x, y, z, width, depth)
     kit.coin(sandbox, x, y, z)
     kit.door(sandbox, x, y, z, axis)
     kit.wall(sandbox, x, y, z, length, axis)
     kit.hazard(sandbox, x, y, z, width, depth)
     kit.spawn(sandbox, x, y, z)
     kit.decor(sandbox, x, y, z, kind)

   Each returns the instance, so you can still attach Attributes to it.

   A character is about 5 studs tall and jumps about 7. Space platforms so they
   can actually be reached. Vary heights — a flat plane of identical parts is
   not a level. Put the interesting thing somewhere the player has to travel to.

   Use BindableEvents for player actions: Studio's edit mode does not run
   physics, so a Touched event will never fire here. Give score-like values as
   Attributes, because those are what the verifier can observe.

2. design_check — look at what you built. It reports overlapping geometry,
   unstyled default parts, proportion and variety problems, each with the fix.
   Repair anything it finds with world_build and check again before moving on.

3. contract_propose — state what a mechanic must DO:
     treatment  — Luau firing the interaction, e.g. sandbox.Grab:Fire()
     control    — Luau for the SAME world where it does NOT happen; "-- nothing" is fine
     effects    — "Score.@Points:+1, exists:Coin:true->false"
     non_effects— "Other.@Points"   (may be empty)
     reference  — the Luau implementation you believe satisfies it

   A contract is audited before it is kept. If it can be satisfied with no
   implementation at all it is rejected, so do not write a treatment that
   performs the effect itself — the treatment fires the trigger, the
   implementation reacts to it.

4. patch_propose then causal_verify with contract_id set to your contract.
   If it is rejected, read what the engine observed and try again.

Build the mechanics the request asks for and no others. When every mechanic is
accepted and design_check passes, call contract_list and summarise what you
built and what each mechanic was proven to cause.

Do not publish anything.
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
          params: {
            reasoningEffort: 'low',
            temperature: 0,
            maxTokens: 2048,
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
