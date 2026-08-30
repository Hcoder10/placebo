import { StudioSession } from './../src/verifier/studio.js';

/**
 * Drive the built game and watch a physical touch move the score.
 *
 *   npx tsx scripts/prove-playable.ts
 *
 * `RunService:Run()` is the Studio "Run" button. It is PluginSecurity, so the
 * bridge can call it, and -- the property that matters -- it simulates in the
 * SAME DataModel the plugin is attached to, so every existing tool observes the
 * running world live. `StudioTestService:ExecutePlayModeAsync` spawns a separate
 * DataModel an edit-mode plugin can never see into, which is why the earlier
 * attempts reported success and showed nothing.
 *
 * Two gotchas, both learned the hard way:
 *   - `RunService:IsEdit()` stays true while `Run()` simulates. Trust IsRunning.
 *   - `Stop()` does NOT roll the world back, so anything the run destroys stays
 *     destroyed. That is exactly why the coin kept vanishing between sessions.
 *
 * The second gotcha is also why this script asserts its starting state instead
 * of reporting it. Run twice against a world nothing resets, the second run
 * reads:
 *
 *     score 3 -> 6   door true -> true
 *
 * which is three passing collects and a proof of nothing: the door was already
 * open before the first coin. The play layer now restores the built world when
 * the session starts, so the score being 0 and the door being shut *after*
 * simulation begins is the evidence that the restore ran -- and the run is only
 * worth reading once that holds.
 */

/**
 * Which world to drive, so a proof can run against a scratch copy instead of
 * the shared one.
 *
 *   PLACEBO_ROOT=PlaceboProof npx tsx scripts/prove-playable.ts
 *
 * Studio is a single shared instance here. `PlaceboSandbox` is also the name the
 * verifier destroys and rebuilds on every condition, so a proof that hardcodes
 * it loses a race it cannot see: the sandbox vanishes mid-run and the failure
 * reads as a missing Scoreboard rather than as someone else's rebuild.
 * `playableLuau` already takes a root; this is the other half of that.
 */
/**
 * Stop and Run are asynchronous, and a fixed `task.wait(1)` is not enough on a
 * loaded machine. Measured: a run whose Stop had not landed yet reported
 * `running=true`, and the next proof's `Run()` was then a no-op against a
 * simulation that was already going -- so PlayLayer never restarted, the
 * restore never fired, and the second run read `score=4` before it touched
 * anything. Both transitions are polled to the state they asked for.
 */
const settle = (want: boolean): string => [
  'local RunService = game:GetService("RunService")',
  `local want = ${String(want)}`,
  'if RunService:IsRunning() ~= want then',
  '\tif want then RunService:Run() else RunService:Stop() end',
  'end',
  'local waited = 0',
  'while RunService:IsRunning() ~= want and waited < 15 do task.wait(0.25) waited += 0.25 end',
  // Scripts start on the frame after Run(), so the world is only worth reading
  // once they have had a moment to do their startup work.
  'if want then task.wait(1.5) end',
  'return string.format("running=%s after %.2fs", tostring(RunService:IsRunning()), waited)',
].join('\n');

const ROOT = process.env.PLACEBO_ROOT ?? 'PlaceboSandbox';
const sandbox = `workspace:FindFirstChild(${JSON.stringify(ROOT)})`;
/** Fails with the root's name in the message rather than "not a valid member". */
const WORLD = `local sb = ${sandbox}\nif not sb then error("no world named ${ROOT}", 0) end`;

const s = new StudioSession();
await s.connect();

const failures: string[] = [];
/**
 * Whether the run reached the end of its checks.
 *
 * Separate from `failures` because a step that throws -- the sandbox destroyed
 * out from under the run, the bridge dropping -- skips every remaining check
 * and leaves `failures` empty. Reporting that as a pass is the exact failure
 * this script exists to catch, so the summary requires both.
 */
let completed = false;

const step = async (label: string, code: string): Promise<string> => {
  const out = await s.luau(code);
  const text = typeof out === 'string' ? out : JSON.stringify(out);
  process.stdout.write(`  ${label.padEnd(26)} ${text}\n`);
  return text;
};

/** Reports, and records a failure rather than throwing, so Stop still runs. */
const expect = (label: string, actual: string, wanted: string): void => {
  const ok = actual === wanted;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(21)} ${actual}${ok ? '' : `  (wanted ${wanted})`}\n`);
  if (!ok) failures.push(`${label}: got ${actual}, wanted ${wanted}`);
};

/**
 * The play layer's own output devices, as a count per scoreboard rather than a
 * total, so the check does not encode how many scoreboards this world has.
 * Two is correct -- one readout per face -- however many sessions have run.
 */
const READOUTS_PER_BOARD = [
  WORLD,
  'local readouts, boards = 0, 0',
  'for _, d in sb:GetDescendants() do if d.Name == "Readout" then readouts += 1 end end',
  'for _, d in sb:GetDescendants() do if d:GetAttribute("Coins") ~= nil then boards += 1 end end',
  'if boards == 0 then return "no scoreboards" end',
  'local verdict = readouts == boards * 2 and "ok" or "STACKED"',
  'return string.format("%s, %d readout(s) over %d board(s)", verdict, readouts, boards)',
].join('\n');

const SCORE_AND_DOOR = [
  WORLD,
  'return string.format("score=%s door=%s", tostring(sb.Scoreboard:GetAttribute("Coins")), tostring(sb.Door:GetAttribute("Open")))',
].join('\n');

try {
  await step('world before', [
    WORLD,
    'local c = sb:FindFirstChild("Coin")',
    'return string.format("coin=%s score=%s door=%s", tostring(c ~= nil), tostring(sb.Scoreboard:GetAttribute("Coins")), tostring(sb.Door:GetAttribute("Open")))',
  ].join('\n'));

  // Stopped first, then started. A simulation left running by a previous proof
  // makes Run() a no-op, which silently invalidates everything after it.
  await step('settle to edit', settle(false));
  const started = await step('start simulation', settle(true));
  expect('simulation started', started.startsWith('running=true') ? 'ok' : started, 'ok');

  // The play layer restores the built world as it starts, so this is read after
  // Run() rather than before it. A run that begins mid-game proves nothing, so
  // the rest of the output is only meaningful once these two hold.
  expect('restored to built', await step('after restore', SCORE_AND_DOOR), 'score=0 door=false');
  expect('coin is back', await step('coin present', `return tostring(${sandbox}:FindFirstChild("Coin") ~= nil)`), 'true');

  for (let collect = 1; collect <= 3; collect += 1) {
    await step(`drop rig #${String(collect)}`, [
      WORLD,
      'local coin = sb:FindFirstChild("Coin")',
      'if not coin then return "no coin to touch" end',
      'local old = workspace:FindFirstChild("ProofRig") if old then old:Destroy() end',
      'local rig = Instance.new("Model") rig.Name = "ProofRig"',
      'local hum = Instance.new("Humanoid") hum.Parent = rig',
      'local torso = Instance.new("Part") torso.Name = "Torso" torso.Size = Vector3.new(2,2,1)',
      'torso.Anchored = false torso.CanCollide = false',
      'torso.Position = coin.Position + Vector3.new(0, 14, 0)',
      'torso.Parent = rig rig.PrimaryPart = torso rig.Parent = workspace',
      // The rig is unanchored and has to fall 14 studs. Studio throttles its
      // physics step hard when the window is unfocused or the machine is busy,
      // and a 4s budget was measured missing one drop in a run whose other two
      // drops landed from the identical position -- a flaky proof that cries
      // wolf. The elapsed time is reported so a near miss is visible rather
      // than hidden by the larger budget.
      'local waited = 0',
      'while waited < 10 and coin.Parent do task.wait(0.1) waited += 0.1 end',
      'rig:Destroy()',
      'return string.format("touched=%s in %.1fs score=%s door=%s", tostring(coin.Parent == nil), waited, tostring(sb.Scoreboard:GetAttribute("Coins")), tostring(sb.Door:GetAttribute("Open")))',
    ].join('\n'));
    await step('wait for respawn', `task.wait(2.5) return "coin back=" .. tostring(${sandbox}:FindFirstChild("Coin") ~= nil)`);
  }

  expect('three collects opened it', await step('final state', SCORE_AND_DOOR), 'score=3 door=true');
  expect('door became passable', await step('door passable', `${WORLD} return tostring(sb.Door.CanCollide == false)`), 'true');

  // One pair of faces per scoreboard, however many sessions have run. These are
  // rebuilt each session; before they were, every Run left its own behind and
  // the live number ended up under a stack of frozen ones.
  const readouts = await step('readouts', READOUTS_PER_BOARD);
  expect('one readout per face', readouts.startsWith('ok') ? 'ok' : readouts, 'ok');
  completed = true;
} finally {
  // Leaving Studio simulating is not a tidy-up detail: it is what broke the
  // next run, so it is a checked outcome rather than a best effort.
  const stopped = await step('stop simulation', settle(false));
  expect('left in edit mode', stopped.startsWith('running=false') ? 'ok' : stopped, 'ok');
  await s.close();

  if (failures.length > 0) {
    process.stdout.write(`\n  ${String(failures.length)} check(s) failed:\n`);
    for (const failure of failures) process.stdout.write(`    ${failure}\n`);
    process.exitCode = 1;
  } else if (!completed) {
    process.stdout.write('\n  did not finish -- the error below stopped it before the checks were done\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('\n  played clean, and left a world the next run can play again\n');
  }
}
