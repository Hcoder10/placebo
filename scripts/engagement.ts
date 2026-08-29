import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadTask } from '../src/verifier/task.js';
import { sampleCandidates } from '../src/train/sample.js';

/**
 * The cheap half of the before/after, at a sample size that can carry a claim.
 *
 * Engine acceptance is the metric that matters, and it is expensive: every
 * candidate costs a full world rebuild per condition per realization. That caps
 * how many we can afford, and at n=30 a move from 1/30 to 6/30 is Fisher
 * p~=0.10 -- suggestive, not significant.
 *
 * This measures the mechanism instead, and needs no engine at all, so it can
 * run at n=150+ per arm. The base model's dominant failure is not broken Luau,
 * it is idiomatic Luau: it reaches for `Players.PlayerAdded`, builds
 * `leaderstats`, creates its own sandbox folder, and never touches the Collect
 * event or the Scoreboard it was handed. A patch that does that cannot cause
 * the contract's effects no matter how well written it is.
 *
 * So: does the completion engage with the world it was given? That is
 * checkable from the text, it is what post-training should move first, and a
 * tight interval on it is worth more than a wide one on the metric downstream
 * of it. Both get reported; neither is presented as the other.
 */

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'data', 'engagement.jsonl');

const SYSTEM = `You implement and repair Roblox game mechanics in Luau.

You are given a behavioural contract: an interaction, and the effects that
interaction must cause. Write the mechanic so that the interaction is what
causes them. An implementation whose end state looks right but which would look
identical had the interaction never happened is wrong.

Write only the Luau body. A folder named \`sandbox\` is already in scope.`;

const TASKS = ['tasks/build_coin.yaml', 'tasks/extend_door.yaml', 'tasks/repair_key.yaml'];

/** Reacts to the provided interaction rather than inventing its own world. */
function engages(luau: string): boolean {
  return /\bsandbox\s*[.:]\s*(Collect|Use|StepOn|Decoy)\b/.test(luau) ||
    /\bsandbox\s*[.:]\s*FindFirstChild\s*\(\s*["'](Collect|Use|StepOn)/.test(luau);
}

/** The specific wrong instinct, counted so the shift is legible. */
function inventsOwnWorld(luau: string): boolean {
  return /\bPlayers\s*\.\s*PlayerAdded\b/.test(luau) || /\bleaderstats\b/.test(luau);
}

/** Wilson score interval — honest at small n, unlike a bare proportion. */
function wilson(hits: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

async function main(): Promise<void> {
  const model = process.argv[2] ?? 'gpt-oss-20b';
  const perTask = Number(process.env.PLACEBO_SAMPLES ?? '50');
  const endpoint = process.env.PLACEBO_BASE_URL ?? 'http://100.79.153.43:8000/v1';
  mkdirSync(join(ROOT, 'data'), { recursive: true });

  let n = 0;
  let engaged = 0;
  let invented = 0;

  for (const relative of TASKS) {
    const { task, contracts } = loadTask(join(ROOT, relative));
    const prompt = [
      `Goal: ${task.goal.trim()}`,
      '',
      'Requirements:',
      ...contracts.map(c => `  - ${c.requirement.trim()}`),
      '',
      task.baseline.trim() ? `Current implementation:\n\`\`\`lua\n${task.baseline.trim()}\n\`\`\`` : 'There is no implementation yet.',
    ].join('\n');

    const drawn = await sampleCandidates({ endpoint, model, system: SYSTEM, prompt, count: perTask });
    for (const c of drawn.candidates) {
      const e = engages(c.luau);
      const i = inventsOwnWorld(c.luau);
      n += 1;
      if (e) engaged += 1;
      if (i) invented += 1;
      appendFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), model, task: task.id, candidate: c.id, engages: e, inventsOwnWorld: i })}\n`, 'utf8');
    }
    process.stdout.write(`  ${model.padEnd(16)} ${task.id.padEnd(14)} ${String(drawn.returned)} usable of ${String(perTask)}\n`);
  }

  const [lo, hi] = wilson(engaged, n);
  process.stdout.write(`\n  ${model}\n`);
  process.stdout.write(`    n                     ${String(n)}\n`);
  process.stdout.write(`    engages with world    ${String(engaged)} (${((engaged / n) * 100).toFixed(1)}%, 95% CI ${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)})\n`);
  process.stdout.write(`    invents its own       ${String(invented)} (${((invented / n) * 100).toFixed(1)}%)\n\n`);
}

await main();
