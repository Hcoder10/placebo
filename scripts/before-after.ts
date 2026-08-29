import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateTask, verifyBaseline } from '../src/verifier/evaluateTask.js';
import { StudioSession } from '../src/verifier/studio.js';
import { loadTask } from '../src/verifier/task.js';
import { sampleCandidates } from '../src/train/sample.js';

/**
 * Did post-training make the model better at causing things?
 *
 *   PLACEBO_BASE_URL=http://host:port/v1 npx tsx scripts/before-after.ts base placebo-dpo
 *
 * One number, measured the only way this project accepts: sample candidates
 * from each model, run every one against a live engine, and count how many the
 * verifier accepts. No proxy, no perplexity, no judge model.
 *
 * The comparison is matched deliberately. Same tasks, same prompts, same sample
 * count, same temperature, same engine, same session, run back to back. The
 * only thing that differs is which weights answered. Anything else and the
 * result would be about the day rather than about the training.
 *
 * A second number is recorded alongside it, because acceptance alone is coarse
 * at this sample size: how often the completion so much as *mentions* the
 * objects the contract is about. The dominant failure of the base model is not
 * broken Luau, it is idiomatic Luau — reaching for `Players.PlayerAdded` and
 * `leaderstats` and building its own world, rather than reacting to the event
 * and the scoreboard it was handed. That is a shift you can see move before
 * acceptance does.
 */

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'data', 'before-after.jsonl');

const SYSTEM = `You implement and repair Roblox game mechanics in Luau.

You are given a behavioural contract: an interaction, and the effects that
interaction must cause. Write the mechanic so that the interaction is what
causes them. An implementation whose end state looks right but which would look
identical had the interaction never happened is wrong.

Write only the Luau body. A folder named \`sandbox\` is already in scope.`;

const TASKS = ['tasks/build_coin.yaml', 'tasks/extend_door.yaml', 'tasks/repair_key.yaml'];
const SAMPLES = Number(process.env.PLACEBO_SAMPLES ?? '10');

/** Does the completion engage with the world it was given, at all? */
function engagesWithWorld(luau: string): boolean {
  return /\bsandbox\s*[.:]\w/.test(luau) || /\bsandbox\b[^\n]*Find/.test(luau);
}

interface Score {
  model: string;
  sampled: number;
  accepted: number;
  engaged: number;
  perTask: Record<string, { sampled: number; accepted: number }>;
}

async function scoreModel(session: StudioSession, endpoint: string, model: string): Promise<Score> {
  const score: Score = { model, sampled: 0, accepted: 0, engaged: 0, perTask: {} };

  for (const relative of TASKS) {
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
      task.baseline.trim()
        ? `Current implementation:\n\`\`\`lua\n${task.baseline.trim()}\n\`\`\``
        : 'There is no implementation yet.',
    ].join('\n');

    const drawn = await sampleCandidates({ endpoint, model, system: SYSTEM, prompt, count: SAMPLES });
    const perTask = { sampled: 0, accepted: 0 };

    for (const candidate of drawn.candidates) {
      const result = await evaluateTask({ session, task, contracts, patchLuau: candidate.luau });
      score.sampled += 1;
      perTask.sampled += 1;
      if (engagesWithWorld(candidate.luau)) score.engaged += 1;
      if (result.accepted) {
        score.accepted += 1;
        perTask.accepted += 1;
      }
      appendFileSync(
        OUT,
        `${JSON.stringify({
          at: new Date().toISOString(),
          model,
          task: task.id,
          candidate: candidate.id,
          accepted: result.accepted,
          engaged: engagesWithWorld(candidate.luau),
          gained: result.gained,
          outstanding: result.outstanding,
          regressed: result.regressed,
        })}\n`,
        'utf8',
      );
    }

    score.perTask[task.id] = perTask;
    process.stdout.write(
      `  ${model.padEnd(16)} ${task.id.padEnd(14)} ${String(perTask.accepted)}/${String(perTask.sampled)} accepted\n`,
    );
  }
  return score;
}

async function main(): Promise<void> {
  const models = process.argv.slice(2);
  if (models.length < 2) {
    process.stdout.write('usage: before-after.ts <before-model> <after-model>\n');
    process.exitCode = 1;
    return;
  }

  const endpoint = process.env.PLACEBO_BASE_URL ?? 'http://localhost:8000/v1';
  mkdirSync(join(ROOT, 'data'), { recursive: true });

  const session = new StudioSession();
  await session.connect();

  process.stdout.write(`\n  endpoint ${endpoint}\n  ${String(SAMPLES)} samples per task, ${String(TASKS.length)} tasks\n\n`);

  const scores: Score[] = [];
  for (const model of models) scores.push(await scoreModel(session, endpoint, model));

  await session.cleanup();
  await session.close();

  process.stdout.write('\n  model             accepted   engaged with the given world\n');
  for (const s of scores) {
    const acc = s.sampled > 0 ? ((s.accepted / s.sampled) * 100).toFixed(0) : '0';
    const eng = s.sampled > 0 ? ((s.engaged / s.sampled) * 100).toFixed(0) : '0';
    process.stdout.write(
      `  ${s.model.padEnd(18)}${String(s.accepted)}/${String(s.sampled)} (${acc}%)   ${String(s.engaged)}/${String(s.sampled)} (${eng}%)\n`,
    );
  }
  process.stdout.write(`\n  rows appended to data/before-after.jsonl\n\n`);
}

await main();
