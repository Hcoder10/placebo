import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidatesFor } from '../verifier/candidates.js';
import { evaluateTask, verifyBaseline } from '../verifier/evaluateTask.js';
import { StudioSession } from '../verifier/studio.js';
import { loadTask } from '../verifier/task.js';
import { buildCurriculum } from '../bright/curriculum.js';
import { extract, fetchDocument } from '../bright/pipeline.js';
import { loadSpec } from '../bright/spec.js';

/**
 * One turn of the flywheel.
 *
 *   npx tsx src/train/continual.ts
 *
 * Each turn appends to a growing corpus rather than replacing it, which is the
 * only part of "continual" that actually matters: the model is trained on
 * everything the harness has ever verified, not on the last batch. Re-deriving
 * the whole corpus every time would also mean re-running every experiment, and
 * engine runs are the expensive resource here.
 *
 * Rows are content-addressed by (task, candidate) so re-running a turn is
 * idempotent — a crashed turn can simply be run again without doubling the
 * dataset, which is what makes an unattended loop safe to leave running.
 *
 * Bright Data enters here rather than as a separate pipeline: scraped API
 * claims that survive engine adjudication become curriculum notes attached to
 * the corpus, so the web is a source of *what to work on* while the engine
 * remains the only source of *what is true*.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const DATA = join(ROOT, 'data');
const CORPUS = join(DATA, 'corpus.jsonl');
const DPO = join(DATA, 'dpo.jsonl');
const SFT = join(DATA, 'sft.jsonl');
const CURRICULUM = join(DATA, 'curriculum.jsonl');

const SYSTEM = `You implement and repair Roblox game mechanics in Luau.

You are given a behavioural contract: an interaction, and the effects that
interaction must cause. Write the mechanic so that the interaction is what
causes them. An implementation whose end state looks right but which would look
identical had the interaction never happened is wrong.

Write only the Luau body. A folder named \`sandbox\` is already in scope.`;

interface CorpusRow {
  /** Stable identity, so re-running a turn does not duplicate work. */
  key: string;
  task: string;
  candidate: string;
  prompt: string;
  completion: string;
  accepted: boolean;
  reason: string;
  turn: number;
  at: string;
}

function readCorpus(): Map<string, CorpusRow> {
  const rows = new Map<string, CorpusRow>();
  if (!existsSync(CORPUS)) return rows;
  for (const line of readFileSync(CORPUS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as CorpusRow;
    rows.set(row.key, row);
  }
  return rows;
}

/** Which turn this is, from what is already on disk. */
function nextTurn(rows: Map<string, CorpusRow>): number {
  let highest = 0;
  for (const row of rows.values()) highest = Math.max(highest, row.turn);
  return highest + 1;
}

async function collectCurriculum(session: StudioSession, turn: number): Promise<number> {
  const specPath = join(ROOT, 'scrapers', 'roblox-deprecations.yaml');
  if (!existsSync(specPath)) return 0;

  try {
    const spec = loadSpec(specPath);
    const fetched = await fetchDocument(spec, join(ROOT, 'fixtures'));
    const extracted = extract(spec, fetched.html);
    if (extracted.brokenFields.length > 0) {
      process.stdout.write(
        `  curriculum: scraper needs repair (${extracted.brokenFields.join(', ')}); skipping this turn\n`,
      );
      return 0;
    }

    // The engine decides which scraped claims are real; the rest are dropped.
    const items = await buildCurriculum({ session, records: extracted.records });
    const confirmed = items.filter(item => item.proposal);

    for (const item of confirmed) {
      appendFileSync(
        CURRICULUM,
        `${JSON.stringify({ turn, at: new Date().toISOString(), ...item.proposal, evidence: item.detail })}\n`,
        'utf8',
      );
    }
    process.stdout.write(
      `  curriculum: ${String(confirmed.length)}/${String(items.length)} scraped claims survived the engine\n`,
    );
    return confirmed.length;
  } catch (error) {
    process.stdout.write(
      `  curriculum: skipped (${error instanceof Error ? error.message : String(error)})\n`,
    );
    return 0;
  }
}

async function main(): Promise<void> {
  const taskPaths = process.argv.slice(2);
  const tasks = taskPaths.length > 0 ? taskPaths : ['tasks/build_coin.yaml', 'tasks/extend_door.yaml'];

  mkdirSync(DATA, { recursive: true });
  const corpus = readCorpus();
  const turn = nextTurn(corpus);
  const before = corpus.size;

  process.stdout.write(`\n  turn ${String(turn)}  (corpus has ${String(before)} rows)\n\n`);

  const session = new StudioSession();
  await session.connect();

  await collectCurriculum(session, turn);

  for (const relative of tasks) {
    const { task, contracts } = loadTask(join(ROOT, relative));

    const baseline = await verifyBaseline({ session, task, contracts });
    if (!baseline.ok) {
      process.stdout.write(`  ${task.id}: baseline inconsistent, skipped\n`);
      continue;
    }

    const prompt = [
      `Goal: ${task.goal.trim()}`,
      '',
      'Requirements:',
      ...contracts.map(contract => `  - ${contract.requirement.trim()}`),
      '',
      task.baseline.trim() ? `Current implementation:\n\`\`\`lua\n${task.baseline.trim()}\n\`\`\`` : 'There is no implementation yet.',
    ].join('\n');

    let added = 0;
    for (const candidate of candidatesFor(task)) {
      const key = `${task.id}::${candidate.id}`;
      if (corpus.has(key)) continue; // already measured in an earlier turn

      const result = await evaluateTask({ session, task, contracts, patchLuau: candidate.luau });
      const reason = [
        result.gained.length ? `caused ${result.gained.join(',')}` : '',
        result.outstanding.length ? `failed to cause ${result.outstanding.join(',')}` : '',
        result.regressed.length ? `regressed ${result.regressed.join(',')}` : '',
      ]
        .filter(Boolean)
        .join('; ');

      const row: CorpusRow = {
        key,
        task: task.id,
        candidate: candidate.id,
        prompt,
        completion: candidate.luau.trim(),
        accepted: result.accepted,
        reason: reason || 'no effect',
        turn,
        at: new Date().toISOString(),
      };
      corpus.set(key, row);
      appendFileSync(CORPUS, `${JSON.stringify(row)}\n`, 'utf8');
      added += 1;
    }

    process.stdout.write(`  ${task.id.padEnd(16)} +${String(added)} new rows\n`);
  }

  await session.cleanup();
  await session.close();

  // Rebuild the training files from the whole corpus, not just this turn.
  const rows = [...corpus.values()];
  writeFileSync(SFT, '', 'utf8');
  writeFileSync(DPO, '', 'utf8');

  let sft = 0;
  let dpo = 0;
  const byTask = new Map<string, CorpusRow[]>();
  for (const row of rows) byTask.set(row.task, [...(byTask.get(row.task) ?? []), row]);

  for (const [, group] of byTask) {
    const accepted = group.filter(row => row.accepted);
    const rejected = group.filter(row => !row.accepted);

    for (const row of accepted) {
      appendFileSync(
        SFT,
        `${JSON.stringify({
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: row.prompt },
            { role: 'assistant', content: `\`\`\`lua\n${row.completion}\n\`\`\`` },
          ],
          meta: { task: row.task, candidate: row.candidate, turn: row.turn },
        })}\n`,
        'utf8',
      );
      sft += 1;
    }

    for (const chosen of accepted) {
      for (const loser of rejected) {
        appendFileSync(
          DPO,
          `${JSON.stringify({
            prompt: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: chosen.prompt },
            ],
            chosen: `\`\`\`lua\n${chosen.completion}\n\`\`\``,
            rejected: `\`\`\`lua\n${loser.completion}\n\`\`\``,
            meta: {
              task: chosen.task,
              chosen_id: chosen.candidate,
              rejected_id: loser.candidate,
              rejected_because: loser.reason,
              turn: Math.max(chosen.turn, loser.turn),
            },
          })}\n`,
          'utf8',
        );
        dpo += 1;
      }
    }
  }

  process.stdout.write(
    `\n  corpus ${String(before)} -> ${String(corpus.size)} rows\n  sft ${String(sft)}  dpo ${String(dpo)} pairs\n\n`,
  );
  process.stdout.write(`  next: retrain on data/dpo.jsonl, then serve the adapter and run turn ${String(turn + 1)}\n\n`);
}

await main();
