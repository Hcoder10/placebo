import { join } from 'node:path';
import { TrueForge } from '@truefoundry/trueforge-sdk';

import { assertGated, harnessBucket, setup } from './setup.js';
import { BRANCH_BRIEF_TEXT, parentAgentSpec } from './spec.js';

/**
 * Drives one causal repair experiment through the TrueForge harness.
 *
 *   npx tsx src/orchestrator/main.ts setup
 *   npx tsx src/orchestrator/main.ts run [branches]
 *
 * The parent agent does not write patches. It fans out N subagents from one
 * identical starting point, and the harness gives each of them a context with
 * no access to the parent conversation or to each other. That isolation is the
 * scientific requirement, not a context-window optimisation: if branch B could
 * see branch A's attempt, comparing them would measure ordering as much as it
 * measures the patches.
 */

const ROOT = join(import.meta.dirname, '..', '..');

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  // no .env; defaults below apply
}

const BASE_URL = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
const MCP_HOST = process.env.PLACEBO_MCP_HOST ?? 'http://localhost:9400';
// The model TrueForge actually has registered here. Anything else 404s at
// session creation, which reads as a harness failure rather than a config one.
const MODEL = process.env.PLACEBO_MODEL ?? 'selfhosted/gpt-oss-20b';

/** Tools that must never be exempt from approval. */
const MUST_BE_GATED = ['patch_propose', 'publish_place'];

function client(): TrueForge {
  return new TrueForge({ baseUrl: BASE_URL, timeoutInSeconds: 1800 });
}

interface TurnEvent {
  type: string;
  id: string;
  thread_id?: string | null;
  [key: string]: unknown;
}

async function cmdSetup(): Promise<void> {
  const result = await setup({ client: client(), mcpUrl: `${MCP_HOST}/mcp` });

  process.stdout.write(`\nregistered ${result.mcpUrl}\n\n`);
  for (const tool of result.tools) {
    process.stdout.write(`  ${tool.name.padEnd(18)} ${harnessBucket(tool.annotations)}\n`);
  }

  assertGated(result.tools, MUST_BE_GATED);
  process.stdout.write(`\nall ${String(MUST_BE_GATED.length)} mutating tools are gated\n`);
  process.stdout.write(
    `models: ${result.models.slice(0, 6).join(', ') || '(none configured — add a provider in TrueForge settings)'}\n`,
  );
}

async function cmdRun(branches: number): Promise<void> {
  const tf = client();

  const registration = await setup({ client: tf, mcpUrl: `${MCP_HOST}/mcp` });
  assertGated(registration.tools, MUST_BE_GATED);
  if (registration.models.length === 0) {
    throw new Error('no model provider configured on the TrueForge server');
  }

  // Start from an empty board so the console shows this run and not the last one.
  await fetch(`${MCP_HOST}/api/reset`, { method: 'POST' }).catch(() => undefined);

  const { data: session } = await tf.sessions.create({
    agent: { spec: parentAgentSpec({ model: MODEL, branches }) as never },
  });
  process.stdout.write(`\nsession ${session.id}  model ${MODEL}  branches ${String(branches)}\n\n`);

  const prompt = [
    `Run the experiment. Fan out exactly ${String(branches)} sub-agents.`,
    ``,
    `Give every sub-agent this brief verbatim, with its own branch id substituted:`,
    ``,
    BRANCH_BRIEF_TEXT,
  ].join('\n');

  let input: unknown[] = [{ type: 'user.message', content: prompt }];
  let finalText = '';

  // A turn that ends with pending approvals is not finished, it is waiting.
  // Each pass resolves what is pending and opens a new turn carrying the
  // decisions, until a turn comes back with nothing outstanding.
  for (let turn = 1; turn <= 10; turn += 1) {
    const pending: { toolCallId: string; threadId: string; tool: string }[] = [];
    const seen = new Map<string, TurnEvent>();

    const stream = await tf.sessions.createTurnStream(session.id, { input: input as never });

    for await (const { data } of stream.withMetadata()) {
      const event = data as unknown as TurnEvent;
      seen.set(event.id, event);
      report(event);

      if (event.type === 'model.message' && typeof event.content === 'string' && event.content) {
        finalText = event.content;
      }

      if (event.type === 'tool.approval_required') {
        const refs = (event.tool_calls ?? []) as { id: string; source_event_id: string }[];
        for (const ref of refs) {
          pending.push({
            toolCallId: ref.id,
            threadId: String(event.thread_id ?? ''),
            tool: toolNameFor(seen, ref),
          });
        }
      }
    }

    if (pending.length === 0) break;

    // Every gated call is irreversible by construction — @destructive is the
    // only selector that pauses — so it goes to a person, never to a default.
    process.stdout.write(`\n  ${String(pending.length)} call(s) waiting on a human:\n`);
    for (const item of pending) {
      process.stdout.write(`    ${item.tool}  ->  open http://localhost:9400/ to decide\n`);
    }

    input = pending.map(item => ({
      type: 'user.tool_approval',
      thread_id: item.threadId,
      tool_call_id: item.toolCallId,
      approval: { status: 'deny', reason: 'No operator attached to this run.' },
    }));
  }

  process.stdout.write(`\n--- parent agent's ranking ---\n${finalText}\n`);
  process.stdout.write(`\nfull run state: http://localhost:9400/\n`);
}

/** Prints only the events that change what an operator would do. */
function report(event: TurnEvent): void {
  switch (event.type) {
    case 'thread.created':
      process.stdout.write(`  branch opened   ${String(event.title ?? event.thread_id)}\n`);
      break;
    case 'thread.done':
      process.stdout.write(`  branch finished ${String(event.title ?? event.thread_id)}\n`);
      break;
    case 'tool.approval_required':
      process.stdout.write(`  APPROVAL REQUIRED\n`);
      break;
    default:
      break;
  }
}

/** Resolves a pending call back to the tool name that proposed it. */
function toolNameFor(seen: Map<string, TurnEvent>, ref: { id: string; source_event_id: string }): string {
  const source = seen.get(ref.source_event_id);
  const calls = (source?.tool_calls ?? []) as {
    id: string;
    function?: { name?: string };
    tool_info?: { name?: string };
  }[];
  const call = calls.find(candidate => candidate.id === ref.id);
  return call?.tool_info?.name ?? call?.function?.name ?? 'unknown';
}

const [command, argument] = process.argv.slice(2);

switch (command) {
  case 'setup':
    await cmdSetup();
    break;
  case 'run':
    await cmdRun(Number.parseInt(argument ?? '3', 10));
    break;
  default:
    process.stdout.write('usage: main.ts <setup|run> [branches]\n');
    process.exitCode = 1;
}
