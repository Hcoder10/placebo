import { join } from 'node:path';
import { candidatesFor } from '../src/verifier/candidates.js';
import { playableLuau } from '../src/verifier/kit.js';
import { StudioSession } from '../src/verifier/studio.js';
import { loadTask } from '../src/verifier/task.js';

/**
 * Turn the verified world into one you can press Play on.
 *
 *   npx tsx scripts/make-playable.ts [tasks/build_coin.yaml ...]
 *
 * Deliberately a separate step, run after verification rather than during it.
 * The play layer installs Scripts, and a Script in the sandbox while the
 * verifier is working would appear in the causal diff — `worldstate.ts` watches
 * `Source`, so it would be observed as an effect of whatever patch happened to
 * be under test.
 *
 * The division it makes explicit is the interesting one. A contract proves that
 * *when the Collect event fires*, the score rises by one and the coin is
 * destroyed. That is a claim about the mechanic, and it is the claim worth
 * proving, because it is the one a launch test cannot make. What it deliberately
 * does not include is the input device: something that fires Collect when a
 * player actually walks into the coin.
 *
 * Attaching one does not weaken the verified claim and is not a second
 * implementation of it. It connects a physical trigger to the same event that
 * was already proven to cause the effect. The mechanic is installed verbatim —
 * during verification it only ever ran in the command bar, so without this the
 * play layer would fire Collect into a world where nothing is listening.
 */

const ROOT = join(import.meta.dirname, '..');

async function main(): Promise<void> {
  const relatives = process.argv.slice(2);
  const tasks = relatives.length > 0 ? relatives : ['tasks/build_coin.yaml', 'tasks/extend_door.yaml'];

  // The mechanics the verifier accepted, in the order they were built. Anything
  // it did not accept has no business being installed.
  const accepted: string[] = [];
  for (const relative of tasks) {
    const { task } = loadTask(join(ROOT, relative));
    const winner = candidatesFor(task).find(candidate => candidate.correct);
    if (!winner) {
      process.stdout.write(`  ${task.id}: no verified mechanic, skipped\n`);
      continue;
    }
    accepted.push(`-- ${task.id}\n${winner.luau.trim()}`);
    process.stdout.write(`  ${task.id}: installing ${winner.id}\n`);
  }

  if (accepted.length === 0) {
    process.stdout.write('\n  nothing verified to install\n\n');
    process.exitCode = 1;
    return;
  }

  // Only the LAST one, and this is not a detail.
  //
  // Each step's accepted implementation is cumulative — `buildGame` accretes
  // mechanics, so the door candidate is the coin mechanic plus the door, which
  // is exactly why it is required to keep `coin_awards_once` passing.
  // Installing every step's winner therefore connects two handlers to the same
  // Collect event.
  //
  // Measured, three collects per configuration:
  //
  //   coin then door   scores 1,2,3   door opens: true
  //   door then coin   scores 1,2,3   door opens: FALSE
  //   door alone       scores 1,2,3   door opens: true
  //
  // It does not double-count — both guard on the coin still existing, so
  // whichever runs second bails — but only one of them completes, and which one
  // depends on Roblox's handler dispatch order, which is not guaranteed. The
  // list order happened to be lucky. Reorder it, add a task, or let Roblox
  // change dispatch, and the door quietly stops opening while every contract
  // still passes, because verification never installs two implementations at
  // once.
  const install = accepted.slice(-1);

  const session = new StudioSession();
  await session.connect();
  const raw = await session.luau(playableLuau({ mechanic: install.join('\n\n') }));
  await session.close();

  process.stdout.write(`\n  ${typeof raw === 'string' ? raw : JSON.stringify(raw)}\n`);
  process.stdout.write('\n  press Play in Studio and walk into a coin\n\n');
}

await main();
