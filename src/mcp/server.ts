import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';

import { loadContract } from '../verifier/contract.js';
import { evaluate } from '../verifier/effect.js';
import { StudioSession } from '../verifier/studio.js';
import { Run, scorePrediction } from './runstate.js';

/**
 * The tools a Placebo agent works through.
 *
 * Annotations are the contract, not documentation: TrueForge resolves its
 * `@write` and `@destructive` approval selectors from `readOnlyHint` and
 * `destructiveHint`, so an unannotated tool is silently exempt from approval.
 * The roblox-studio-mcp server exposes 134 tools with no annotations at all,
 * which means the harness would let an agent publish a place unattended — the
 * mistake this file exists not to repeat.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const CONTRACT_PATH = process.env.PLACEBO_CONTRACT ?? join(ROOT, 'contracts', 'coin_awards_once.yaml');

const contract = loadContract(CONTRACT_PATH);
const run = new Run(`run-${String(Date.now())}`, contract.id, join(ROOT, 'runs', 'run.jsonl'));

// One Studio session for the process. Connected lazily so the MCP server can
// start before Studio does.
let studio: StudioSession | null = null;
async function session(): Promise<StudioSession> {
  if (studio) return studio;
  const created = new StudioSession();
  await created.connect();
  studio = created;
  return created;
}

/** Resolvers for approvals the console has not answered yet. */
const approvalWaiters = new Map<string, (status: 'allow' | 'deny') => void>();

/** Parks until a human answers through the console. */
export function awaitApproval(id: string, tool: string, args: Record<string, unknown>): Promise<'allow' | 'deny'> {
  run.state.pending[id] = { tool, args, requestedAt: new Date().toISOString() };
  run.setStatus('waiting', `Waiting on you: ${tool}`);
  return new Promise(resolve => approvalWaiters.set(id, resolve));
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'placebo-tools', version: '0.1.0' });

  server.registerTool(
    'contract_get',
    {
      title: 'Read the behavioural contract',
      description:
        'The requirement under test, as an intervention and the effects it must cause. Read this before proposing anything.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    () =>
      text({
        id: contract.id,
        requirement: contract.requirement,
        treatment: contract.treatment,
        controls: contract.controls.map(control => control.name),
        realizations: contract.realizations,
        // The desired effects are deliberately withheld. A branch that can read
        // e* can echo it back through predict_effect and score perfectly while
        // understanding nothing about its own patch.
        note: 'Expected effects are withheld. Predict what YOUR patch will do, not what the requirement wants.',
      }),
  );

  server.registerTool(
    'project_source',
    {
      title: 'Read the current implementation',
      description: 'The Luau currently implementing this mechanic, including its defect.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    () => text({ setup: contract.setup, current: process.env.PLACEBO_BROKEN_PATCH ?? '' }),
  );

  server.registerTool(
    'predict_effect',
    {
      title: 'Predict what your patch will do',
      description:
        'State the runtime effects your patch will cause, before it runs. Scored against what the engine actually observes, not against the requirement.',
      inputSchema: {
        branch: z.string().describe('Your branch id, e.g. the subagent name'),
        effects: z
          .record(z.string(), z.string())
          .describe('State key -> expected change, e.g. {"Scoreboard.@Coins": "+1"}'),
        unchanged: z.array(z.string()).default([]).describe('Keys you expect not to move'),
      },
      // Records a prediction; changes nothing in the world under test.
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ branch, effects, unchanged }) => {
      run.recordPrediction(branch, { effects, unchanged, at: new Date().toISOString() });
      return text({ recorded: true, branch, note: 'Prediction locked. It cannot be revised after verification.' });
    },
  );

  server.registerTool(
    'patch_propose',
    {
      title: 'Propose a patch',
      description: 'Submit candidate Luau for this branch. Runs only inside the scoped sandbox folder.',
      inputSchema: {
        branch: z.string(),
        luau: z.string().describe('Luau that wires the mechanic. `sandbox` is in scope.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ branch, luau }) => {
      run.recordPatch(branch, luau);
      return text({ recorded: true, branch, bytes: luau.length });
    },
  );

  server.registerTool(
    'causal_verify',
    {
      title: 'Run the experiment',
      description:
        'Runs your patch against the treatment and every matched control, across all realizations, and returns what it actually caused.',
      inputSchema: { branch: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ branch }) => {
      const candidate = run.state.branches[branch];
      if (!candidate?.patchLuau) {
        return text({ error: `branch ${branch} has not proposed a patch yet` });
      }
      if (!candidate.prediction) {
        // Prediction before observation, or the metric is worthless.
        return text({ error: `branch ${branch} must call predict_effect before verifying` });
      }

      const verdict = await evaluate({
        session: await session(),
        contract,
        patchLuau: candidate.patchLuau,
      });
      run.recordVerdict(branch, verdict);

      const prediction = scorePrediction(candidate);
      return text({
        accepted: verdict.accepted,
        satisfied: verdict.satisfied,
        missing: verdict.missing,
        collateral: verdict.collateral,
        observed: verdict.observed,
        inert: verdict.inert,
        stable: verdict.stable,
        realizations: verdict.realizations,
        prediction_score: `${String(prediction.correct)}/${String(prediction.total)}`,
        prediction_wrong: prediction.wrong,
      });
    },
  );

  server.registerTool(
    'publish_place',
    {
      title: 'Publish the winning patch to the live place',
      description: 'Writes the accepted patch into the real place and publishes it. Cannot be undone.',
      inputSchema: { branch: z.string(), place_name: z.string().default('production') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ branch, place_name }) =>
      text({
        published: false,
        branch,
        place_name,
        note: 'Wired and gated; publishing is disabled in the demo build.',
      }),
  );

  return server;
}

const app = express();

/**
 * Mounted before any body parser: the transport reads the request body off the
 * Node stream itself, and a parser that has already drained it turns into a
 * bare 500 with no body.
 *
 * A fresh server and transport per request, with `sessionIdGenerator: undefined`.
 * The SDK rejects reuse of a stateless transport, and a per-request transport
 * *with* a session id rejects the client's `initialized` notification — the two
 * near-misses both fail opaquely.
 */
app.post('/mcp', (req, res) => {
  void (async () => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  })().catch((error: unknown) => {
    process.stderr.write(`mcp error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    if (!res.headersSent) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
});

app.use(express.json({ limit: '4mb' }));

// The operator console: one static page, served from the same process that
// holds the run state. No build step and no second port to explain during a demo.
app.get('/', (_req, res) => {
  res.sendFile(join(ROOT, 'console', 'index.html'));
});

/**
 * A human's answer to a gated tool call.
 *
 * The orchestrator parks the harness turn until this resolves, so the run is
 * genuinely blocked on a person rather than being asked after the fact.
 */
app.post('/api/approvals/:id', (req, res) => {
  const id = req.params.id;
  const status = (req.body as { status?: unknown }).status;
  if (status !== 'allow' && status !== 'deny') {
    res.status(400).json({ error: 'status must be "allow" or "deny"' });
    return;
  }
  const waiter = approvalWaiters.get(id);
  if (!waiter) {
    res.status(404).json({ error: 'no pending approval with that id' });
    return;
  }
  approvalWaiters.delete(id);
  delete run.state.pending[id];
  waiter(status);
  res.json({ ok: true });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, contract: contract.id, studio: studio !== null });
});

/**
 * Clears the run so a fresh experiment starts from an empty board.
 *
 * Without this, seeded fixture branches and model-authored branches pile up in
 * the same view and a watcher cannot tell which is which — the console showed
 * ten branches from three different runs at one point.
 */
app.post('/api/reset', (_req, res) => {
  for (const key of Object.keys(run.state.branches)) {
    delete run.state.branches[key];
  }
  for (const key of Object.keys(run.state.pending)) {
    delete run.state.pending[key];
  }
  run.setStatus('idle', 'Idle');
  res.json({ ok: true });
});

/** The console reads this; it is the same object the tools write to. */
app.get('/api/state', (_req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.json({
    ...run.state,
    contract: {
      id: contract.id,
      requirement: contract.requirement,
      realizations: contract.realizations,
      controls: contract.controls.map(control => control.name),
    },
    predictions: Object.fromEntries(
      Object.values(run.state.branches).map(branch => [branch.id, scorePrediction(branch)]),
    ),
  });
});

const port = Number.parseInt(process.env.PLACEBO_MCP_PORT ?? '9400', 10);
app.listen(port, '0.0.0.0', () => {
  process.stdout.write(`placebo-tools on http://0.0.0.0:${String(port)}/mcp (contract ${contract.id})\n`);
});
