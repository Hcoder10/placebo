import { join } from 'node:path';
import { evaluateTask, rankCandidates, verifyBaseline, type TaskResult } from './evaluateTask.js';
import { StudioSession } from './studio.js';
import { loadTask } from './task.js';

/**
 * Scores candidate implementations against a whole task.
 *
 *   npx tsx src/verifier/taskCli.ts tasks/extend_door.yaml
 *
 * The column that matters on an `extend` task is `regressed`. A candidate that
 * adds the new behaviour while dropping an old one is not a partial success —
 * it is a rejection, and the ranking puts it below a candidate that added
 * nothing at all but broke nothing either.
 */

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * Candidates for the extend task.
 *
 * Written to cover the three ways a feature-add actually goes wrong in
 * practice, not three arbitrary bugs.
 */
const EXTEND_CANDIDATES: { id: string; note: string; luau: string }[] = [
  {
    id: 'adds_door_keeps_coin',
    note: 'adds the door on top of the existing handler',
    luau: `
local board = sandbox.Scoreboard
local door = sandbox.Door
sandbox.Collect.Event:Connect(function()
	local coin = sandbox:FindFirstChild("Coin")
	if not coin then return end
	local total = (board:GetAttribute("Coins") or 0) + 1
	board:SetAttribute("Coins", total)
	coin:Destroy()
	if total >= 3 then
		door:SetAttribute("Open", true)
	end
end)
`,
  },
  {
    id: 'door_replaces_coin',
    note: 'rewrites the handler for the door and forgets to award',
    luau: `
local board = sandbox.Scoreboard
local door = sandbox.Door
local seen = 0
sandbox.Collect.Event:Connect(function()
	seen += 1
	local coin = sandbox:FindFirstChild("Coin")
	if coin then coin:Destroy() end
	if seen >= 3 then
		door:SetAttribute("Open", true)
	end
end)
`,
  },
  {
    id: 'door_opens_immediately',
    note: 'opens the door on the first collect, not the third',
    luau: `
local board = sandbox.Scoreboard
local door = sandbox.Door
sandbox.Collect.Event:Connect(function()
	local coin = sandbox:FindFirstChild("Coin")
	if not coin then return end
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
	coin:Destroy()
	door:SetAttribute("Open", true)
end)
`,
  },
  {
    id: 'door_opens_at_startup',
    note: 'opens the door when the game starts; the end state looks right',
    luau: `
local board = sandbox.Scoreboard
sandbox.Door:SetAttribute("Open", true)
sandbox.Collect.Event:Connect(function()
	local coin = sandbox:FindFirstChild("Coin")
	if not coin then return end
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
	coin:Destroy()
end)
`,
  },
];

/** For `build`, the same set the repair benchmark uses, minus the door. */
const BUILD_CANDIDATES: { id: string; note: string; luau: string }[] = [
  {
    id: 'correct',
    note: 'awards only when there is a coin to collect, then removes it',
    luau: `
local board = sandbox.Scoreboard
sandbox.Collect.Event:Connect(function()
	local coin = sandbox:FindFirstChild("Coin")
	if not coin then return end
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
	coin:Destroy()
end)
`,
  },
  {
    id: 'no_guard',
    note: 'awards on every collect, including ones with no coin left',
    luau: `
local board = sandbox.Scoreboard
sandbox.Collect.Event:Connect(function()
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
	local coin = sandbox:FindFirstChild("Coin")
	if coin then coin:Destroy() end
end)
`,
  },
  {
    id: 'preset_score',
    note: 'sets the score at startup and handles nothing',
    luau: `
sandbox.Scoreboard:SetAttribute("Coins", 1)
local coin = sandbox:FindFirstChild("Coin")
if coin then coin:Destroy() end
`,
  },
];

function summarise(result: TaskResult): string {
  const bits: string[] = [];
  if (result.gained.length) bits.push(`gained ${result.gained.join(',')}`);
  if (result.outstanding.length) bits.push(`missing ${result.outstanding.join(',')}`);
  if (result.regressed.length) bits.push(`BROKE ${result.regressed.join(',')}`);
  if (result.preserved.length) bits.push(`kept ${result.preserved.join(',')}`);
  return bits.join('; ') || 'nothing changed';
}

async function main(): Promise<void> {
  const taskPath = process.argv[2] ?? join(ROOT, 'tasks', 'extend_door.yaml');
  const { task, contracts } = loadTask(
    taskPath.startsWith('/') || /^[A-Za-z]:/.test(taskPath) ? taskPath : join(ROOT, taskPath),
  );

  const candidates = task.mode === 'extend' ? EXTEND_CANDIDATES : BUILD_CANDIDATES;

  const session = new StudioSession();
  await session.connect();

  process.stdout.write(`\ntask ${task.id}  [${task.mode}]\n  ${task.goal.trim()}\n`);
  process.stdout.write(
    `  contracts: ${contracts.map(c => c.id).join(', ')}   already satisfied: ${task.already_satisfied.join(', ') || 'none'}\n\n`,
  );

  // Prove the starting point before judging anything against it.
  const baseline = await verifyBaseline({ session, task, contracts });
  process.stdout.write(`  baseline: ${baseline.ok ? 'verified' : 'INCONSISTENT'}\n`);
  for (const problem of baseline.problems) {
    process.stdout.write(`    ${problem}\n`);
  }
  if (!baseline.ok) {
    process.stdout.write(
      '\n  refusing to score candidates against a baseline that is not what the task claims.\n\n',
    );
    await session.cleanup();
    await session.close();
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\n');

  const scored: { id: string; note: string; result: TaskResult; patchBytes: number }[] = [];
  for (const candidate of candidates) {
    // `extend` candidates replace the baseline wholesale, which is what an
    // agent editing a file actually does.
    const result = await evaluateTask({ session, task, contracts, patchLuau: candidate.luau });
    scored.push({ id: candidate.id, note: candidate.note, result, patchBytes: candidate.luau.length });
  }

  await session.cleanup();
  await session.close();

  process.stdout.write(`  ${'candidate'.padEnd(24)} ${'verdict'.padEnd(8)} outcome\n`);
  process.stdout.write(`  ${'-'.repeat(24)} ${'-'.repeat(8)} ${'-'.repeat(52)}\n`);
  for (const entry of rankCandidates(scored)) {
    process.stdout.write(
      `  ${entry.id.padEnd(24)} ${(entry.result.accepted ? 'ACCEPT' : 'REJECT').padEnd(8)} ${summarise(entry.result)}\n`,
    );
  }

  const winner = rankCandidates(scored)[0];
  process.stdout.write(
    `\n  ranked first: ${winner?.id ?? '(none)'} — ${winner?.note ?? ''}\n\n`,
  );
}

await main();
