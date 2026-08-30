import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { SYSTEM } from './prompt.js';
import { join } from 'node:path';
import { evaluateTask, verifyBaseline, type TaskResult } from '../verifier/evaluateTask.js';
import { StudioSession } from '../verifier/studio.js';
import { loadTask } from '../verifier/task.js';
import { candidatesFor } from '../verifier/candidates.js';

/**
 * Turns verified experiments into training data.
 *
 *   npx tsx src/train/export.ts tasks/build_coin.yaml tasks/extend_door.yaml
 *
 * Two files come out:
 *
 *   sft.jsonl   accepted implementations, as supervised examples
 *   dpo.jsonl   chosen/rejected pairs
 *
 * The pairs are the valuable half, and they are only meaningful because of how
 * they were produced: every candidate in a pair started from the *same* world,
 * ran the *same* interactions, and was labelled by the engine rather than by a
 * judge model. There is no annotator to disagree with and no reference
 * implementation to imitate — the preference is a measured difference in what
 * the code caused.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'data');

// Imported, not copied. Both this and continual.ts rebuild sft.jsonl from the
// same corpus, so a divergence here silently puts two different system prompts
// in one training file. They had already drifted by a word.


interface Example {
  taskId: string;
  candidateId: string;
  prompt: string;
  completion: string;
  accepted: boolean;
  /** Why the engine ruled the way it did — kept for auditing the dataset. */
  reason: string;
}

function promptFor(goal: string, requirements: string[], baseline: string): string {
  const parts = [`Goal: ${goal.trim()}`, '', 'Requirements:'];
  for (const requirement of requirements) parts.push(`  - ${requirement.trim()}`);
  if (baseline.trim()) {
    parts.push('', 'Current implementation:', '```lua', baseline.trim(), '```');
  } else {
    parts.push('', 'There is no implementation yet.');
  }
  return parts.join('\n');
}

function reasonFor(result: TaskResult): string {
  const bits: string[] = [];
  if (result.gained.length) bits.push(`caused ${result.gained.join(',')}`);
  if (result.outstanding.length) bits.push(`failed to cause ${result.outstanding.join(',')}`);
  if (result.regressed.length) bits.push(`regressed ${result.regressed.join(',')}`);
  return bits.join('; ') || 'no effect';
}

async function main(): Promise<void> {
  const taskPaths = process.argv.slice(2);
  if (taskPaths.length === 0) {
    process.stdout.write('usage: export.ts <task.yaml> [task.yaml ...]\n');
    process.exitCode = 1;
    return;
  }

  mkdirSync(OUT, { recursive: true });
  const sftPath = join(OUT, 'sft.jsonl');
  const dpoPath = join(OUT, 'dpo.jsonl');
  writeFileSync(sftPath, '', 'utf8');
  writeFileSync(dpoPath, '', 'utf8');

  const session = new StudioSession();
  await session.connect();

  let sftCount = 0;
  let dpoCount = 0;

  for (const relative of taskPaths) {
    const { task, contracts } = loadTask(join(ROOT, relative));

    const baseline = await verifyBaseline({ session, task, contracts });
    if (!baseline.ok) {
      process.stdout.write(`\n${task.id}: baseline inconsistent, skipping\n`);
      for (const problem of baseline.problems) process.stdout.write(`  ${problem}\n`);
      continue;
    }

    const prompt = promptFor(
      task.goal,
      contracts.map(contract => contract.requirement),
      task.baseline,
    );

    // Candidates come from the mutation library rather than a model. The pairs
    // are still exactly what DPO wants — same prompt, same starting world,
    // opposite engine verdicts — and generating them needs no GPU, so the
    // dataset exists before the model that will train on it.
    const examples: Example[] = [];
    for (const candidate of candidatesFor(task)) {
      const result = await evaluateTask({ session, task, contracts, patchLuau: candidate.luau });
      examples.push({
        taskId: task.id,
        candidateId: candidate.id,
        prompt,
        completion: candidate.luau.trim(),
        accepted: result.accepted,
        reason: reasonFor(result),
      });
    }

    const accepted = examples.filter(example => example.accepted);
    const rejected = examples.filter(example => !example.accepted);

    for (const example of accepted) {
      appendFileSync(
        sftPath,
        `${JSON.stringify({
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: example.prompt },
            { role: 'assistant', content: `\`\`\`lua\n${example.completion}\n\`\`\`` },
          ],
          meta: { task: example.taskId, candidate: example.candidateId, reason: example.reason },
        })}\n`,
        'utf8',
      );
      sftCount += 1;
    }

    for (const chosen of accepted) {
      for (const loser of rejected) {
        appendFileSync(
          dpoPath,
          `${JSON.stringify({
            prompt: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: chosen.prompt },
            ],
            chosen: `\`\`\`lua\n${chosen.completion}\n\`\`\``,
            rejected: `\`\`\`lua\n${loser.completion}\n\`\`\``,
            meta: {
              task: chosen.taskId,
              chosen_id: chosen.candidateId,
              rejected_id: loser.candidateId,
              // The label's provenance, kept in the row so the dataset can be
              // audited without re-running the engine.
              rejected_because: loser.reason,
            },
          })}\n`,
          'utf8',
        );
        dpoCount += 1;
      }
    }

    process.stdout.write(
      `${task.id.padEnd(16)} ${String(accepted.length)} accepted / ${String(examples.length)} candidates\n`,
    );
  }

  await session.cleanup();
  await session.close();

  process.stdout.write(`\n  sft.jsonl  ${String(sftCount)} examples\n`);
  process.stdout.write(`  dpo.jsonl  ${String(dpoCount)} pairs\n`);
  process.stdout.write(`  written to ${OUT}\n\n`);
}

await main();
