import { join } from 'node:path';
import { candidatesFor } from './candidates.js';
import { evaluateTask, verifyBaseline } from './evaluateTask.js';
import { StudioSession } from './studio.js';
import { loadTask } from './task.js';

/**
 * Builds a game one mechanic at a time, verifying each against everything
 * before it.
 *
 *   npx tsx src/verifier/buildGame.ts
 *
 * Each step takes the accepted implementation from the step before as its
 * starting point, adds one behaviour, and has to satisfy *every* contract
 * accumulated so far. A step that adds its own behaviour while breaking an
 * earlier one does not advance the build — it stops it.
 *
 * The objects are created in the live Studio, so the game visibly accretes in
 * the viewport as it goes: a coin and a scoreboard, then a door that opens on
 * the third coin.
 *
 * What this is not: the agent is not free-authoring a game. Each step's
 * implementation comes from the candidate pool, and the verifier's job is to
 * decide which candidate earns its place. The fan-out that would have a model
 * propose those candidates is built but not running — see SUBMISSION.md.
 */

const ROOT = join(import.meta.dirname, '..', '..');

const STEPS = [
  { task: 'tasks/build_coin.yaml', headline: 'a coin you can collect' },
  { task: 'tasks/extend_door.yaml', headline: 'a door that opens on the third coin' },
];

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const session = new StudioSession();
  const attached = await session.connect();

  process.stdout.write(`\n  building a game in Studio place ${attached.placeId || '(unsaved)'}\n`);
  process.stdout.write(`  each mechanic must prove it caused its own behaviour, and must not break the ones before it\n\n`);

  const satisfied: string[] = [];

  for (const [index, step] of STEPS.entries()) {
    const { task, contracts } = loadTask(join(ROOT, step.task));
    const winner = candidatesFor(task).find(candidate => candidate.correct);
    if (!winner) throw new Error(`${task.id}: no candidate marked correct`);

    process.stdout.write(`  ${'-'.repeat(66)}\n`);
    process.stdout.write(`  step ${String(index + 1)}  ${step.headline}\n`);
    process.stdout.write(`  ${'-'.repeat(66)}\n`);
    process.stdout.write(`    goal        ${task.goal.trim().replace(/\s+/g, ' ')}\n`);
    process.stdout.write(
      `    must keep   ${satisfied.length > 0 ? satisfied.join(', ') : '(nothing yet — this is the first mechanic)'}\n`,
    );

    if (task.already_satisfied.length > 0) {
      const baseline = await verifyBaseline({ session, task, contracts });
      process.stdout.write(
        `    baseline    ${baseline.ok ? 'verified — it really does satisfy what the task claims' : 'INCONSISTENT'}\n`,
      );
      if (!baseline.ok) {
        for (const problem of baseline.problems) process.stdout.write(`      ${problem}\n`);
        break;
      }
    }

    process.stdout.write(`    running     ${String(contracts.length)} contract(s) against a live engine...\n`);
    const result = await evaluateTask({ session, task, contracts, patchLuau: winner.luau });

    for (const outcome of result.outcomes) {
      const mark = outcome.verdict.accepted ? 'PASS' : 'FAIL';
      const role = outcome.wasSatisfied ? 'kept  ' : 'gained';
      process.stdout.write(`      ${mark}  ${role}  ${outcome.contractId}\n`);
      if (outcome.verdict.accepted && !outcome.wasSatisfied) {
        const caused = Object.entries(outcome.verdict.observed)
          .filter(([key]) => !key.includes('.Anchored') && !key.includes('.CanCollide'))
          .slice(0, 3)
          .map(([key, change]) => `${key} ${change}`);
        for (const line of caused) process.stdout.write(`              caused ${line}\n`);
      }
    }

    if (!result.accepted) {
      process.stdout.write(`\n    step rejected — the build stops here rather than shipping a regression\n`);
      if (result.regressed.length > 0) {
        process.stdout.write(`    broke: ${result.regressed.join(', ')}\n`);
      }
      break;
    }

    for (const id of result.gained) if (!satisfied.includes(id)) satisfied.push(id);
    process.stdout.write(`    accepted    ${String(result.engineRuns)} engine runs\n\n`);

    // Leave the world standing for a moment so it is visible in the viewport.
    await pause(1200);
  }

  // Show what is actually sitting in the place now.
  const world = await session.snapshotSandbox();
  process.stdout.write(`  ${'-'.repeat(66)}\n`);
  process.stdout.write(`  the game now in Studio:\n`);
  for (const name of world) process.stdout.write(`    ${name}\n`);
  process.stdout.write(
    `\n  ${String(satisfied.length)} mechanic(s), each one proven to cause its own behaviour:\n`,
  );
  for (const id of satisfied) process.stdout.write(`    ${id}\n`);
  process.stdout.write('\n');

  await session.close();
}

await main();
