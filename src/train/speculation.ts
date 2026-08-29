import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Is the draft model getting better at OUR domain?
 *
 *   npx tsx src/train/speculation.ts
 *
 * Speculative decoding pays exactly as well as the drafter predicts the target.
 * The released DFlash draft is general purpose, and on Luau game mechanics it
 * measured an accepted length of 1.99 out of 8 drafted tokens — a 12.3%
 * acceptance rate, which is why enabling it made generation 18% *slower* rather
 * than faster. Paying for eight draft tokens and a verification to gain two is a
 * bad trade on any hardware that is not starved for bandwidth.
 *
 * That is a starting point, not a verdict. A drafter trained on the traces this
 * system generates should predict them far better than a general one does, and
 * accepted length is the number that says whether it has.
 *
 * So every measurement is appended to a history file. "It keeps getting faster"
 * is a claim about a trend, and a trend needs a series — one impressive
 * measurement proves nothing, and a regression after a training turn is exactly
 * the thing worth catching.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const HISTORY = join(ROOT, 'data', 'speculation.jsonl');

const SPEC_URL = process.env.PLACEBO_SPEC_URL ?? 'http://100.79.153.43:8002';
const SPEC_MODEL = process.env.PLACEBO_SPEC_MODEL ?? 'gpt-oss-spec';

const SYSTEM =
  'You implement Roblox game mechanics in Luau. Write only the Luau body. A folder named `sandbox` is in scope.';

/**
 * The workload the drafter is being judged on.
 *
 * Deliberately the work this system actually does. Measuring acceptance on open
 * prose would answer a different question than the one that decides whether
 * speculation is worth running here.
 */
const PROMPTS = [
  'Collecting the coin awards exactly one point and removes the coin.',
  'A door opens once the player has collected three coins.',
  'Stepping on the lava reduces the player health by ten, once per step.',
  'A button toggles a light on and off each time it is pressed.',
  'Picking up a key unlocks the chest, and only the chest it belongs to.',
  'A checkpoint saves the player position, and respawning returns them to it.',
  'A timer counts down from sixty and ends the round when it reaches zero.',
  'Standing on the pressure plate opens the gate, and stepping off closes it.',
];

interface SpecMetrics {
  drafts: number;
  draftTokens: number;
  accepted: number;
  perPosition: number[];
}

async function readMetrics(): Promise<SpecMetrics | null> {
  const response = await fetch(`${SPEC_URL}/metrics`).catch(() => null);
  if (!response?.ok) return null;
  const body = await response.text();

  const scalar = (name: string): number => {
    const match = new RegExp(`^vllm:${name}\\{[^}]*\\}\\s+([0-9.e+]+)$`, 'm').exec(body);
    return match?.[1] ? Number.parseFloat(match[1]) : 0;
  };

  const perPosition: number[] = [];
  const pattern = /^vllm:spec_decode_num_accepted_tokens_per_pos_total\{[^}]*position="(\d+)"[^}]*\}\s+([0-9.e+]+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (match[1] && match[2]) perPosition[Number.parseInt(match[1], 10)] = Number.parseFloat(match[2]);
  }

  return {
    drafts: scalar('spec_decode_num_drafts_total'),
    draftTokens: scalar('spec_decode_num_draft_tokens_total'),
    accepted: scalar('spec_decode_num_accepted_tokens_total'),
    perPosition,
  };
}

async function generate(prompt: string): Promise<{ ms: number; tokens: number } | null> {
  const started = Date.now();
  const response = await fetch(`${SPEC_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: SPEC_MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 256,
    }),
  }).catch(() => null);

  if (!response?.ok) return null;
  const body = (await response.json()) as { usage?: { completion_tokens?: number } };
  return { ms: Date.now() - started, tokens: body.usage?.completion_tokens ?? 0 };
}

async function main(): Promise<void> {
  mkdirSync(join(ROOT, 'data'), { recursive: true });

  // Counters are cumulative, so the measurement is the delta across this run —
  // otherwise every reading is polluted by whatever the server did before.
  const before = await readMetrics();
  if (!before) {
    process.stdout.write(`\n  no speculative endpoint at ${SPEC_URL}\n\n`);
    process.exitCode = 1;
    return;
  }

  let totalMs = 0;
  let totalTokens = 0;
  for (const prompt of PROMPTS) {
    const sample = await generate(prompt);
    if (sample) {
      totalMs += sample.ms;
      totalTokens += sample.tokens;
    }
  }

  const after = await readMetrics();
  if (!after) {
    process.stdout.write('  metrics disappeared mid-run\n');
    process.exitCode = 1;
    return;
  }

  const drafts = after.drafts - before.drafts;
  const draftTokens = after.draftTokens - before.draftTokens;
  const accepted = after.accepted - before.accepted;

  const acceptanceRate = draftTokens > 0 ? (accepted / draftTokens) * 100 : 0;
  // +1 for the token the target produces itself on every verification step.
  const acceptedLength = drafts > 0 ? accepted / drafts + 1 : 0;
  const throughput = totalMs > 0 ? (totalTokens / totalMs) * 1000 : 0;

  const perPosition = after.perPosition.map((value, index) => value - (before.perPosition[index] ?? 0));

  const record = {
    at: new Date().toISOString(),
    model: SPEC_MODEL,
    prompts: PROMPTS.length,
    drafts,
    draftTokens,
    accepted,
    acceptanceRate: Number(acceptanceRate.toFixed(2)),
    acceptedLength: Number(acceptedLength.toFixed(3)),
    throughput: Number(throughput.toFixed(1)),
  };
  appendFileSync(HISTORY, `${JSON.stringify(record)}\n`, 'utf8');

  process.stdout.write(`\n  drafts            ${String(drafts)}\n`);
  process.stdout.write(`  draft tokens      ${String(draftTokens)}\n`);
  process.stdout.write(`  accepted tokens   ${String(accepted)}\n`);
  process.stdout.write(`  acceptance rate   ${acceptanceRate.toFixed(1)}%\n`);
  process.stdout.write(`  accepted length   ${acceptedLength.toFixed(2)} tokens per verify\n`);
  process.stdout.write(`  throughput        ${throughput.toFixed(1)} tok/s\n`);
  process.stdout.write(
    `  per position      ${perPosition.map(value => String(value)).join(' -> ')}\n`,
  );

  // The trend is the claim. A single reading is not.
  if (existsSync(HISTORY)) {
    const history = readFileSync(HISTORY, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as typeof record);
    if (history.length > 1) {
      process.stdout.write(`\n  history (${String(history.length)} measurements)\n`);
      for (const entry of history.slice(-6)) {
        process.stdout.write(
          `    ${entry.at.slice(0, 19)}  accepted ${entry.acceptedLength.toFixed(2)}  ${entry.throughput.toFixed(0)} tok/s\n`,
        );
      }
      const first = history[0];
      const last = history.at(-1);
      if (first && last) {
        const delta = last.acceptedLength - first.acceptedLength;
        process.stdout.write(
          `\n  accepted length ${first.acceptedLength.toFixed(2)} -> ${last.acceptedLength.toFixed(2)} (${delta >= 0 ? '+' : ''}${delta.toFixed(2)})\n`,
        );
      }
    }
  }
  process.stdout.write('\n');
}

await main();
