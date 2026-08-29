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
 */

const s = new StudioSession();
await s.connect();

const step = async (label: string, code: string) => {
  const out = await s.luau(code);
  process.stdout.write(`  ${label.padEnd(26)} ${typeof out === 'string' ? out : JSON.stringify(out)}\n`);
  return out;
};

try {
  await step('world before', [
    'local sb = workspace.PlaceboSandbox',
    'local c = sb:FindFirstChild("Coin")',
    'return string.format("coin=%s score=%s door=%s", tostring(c ~= nil), tostring(sb.Scoreboard:GetAttribute("Coins")), tostring(sb.Door:GetAttribute("Open")))',
  ].join('\n'));

  await step('start simulation', 'game:GetService("RunService"):Run() task.wait(1.5) return "running=" .. tostring(game:GetService("RunService"):IsRunning())');

  for (let collect = 1; collect <= 3; collect += 1) {
    await step(`drop rig #${String(collect)}`, [
      'local sb = workspace.PlaceboSandbox',
      'local coin = sb:FindFirstChild("Coin")',
      'if not coin then return "no coin to touch" end',
      'local old = workspace:FindFirstChild("ProofRig") if old then old:Destroy() end',
      'local rig = Instance.new("Model") rig.Name = "ProofRig"',
      'local hum = Instance.new("Humanoid") hum.Parent = rig',
      'local torso = Instance.new("Part") torso.Name = "Torso" torso.Size = Vector3.new(2,2,1)',
      'torso.Anchored = false torso.CanCollide = false',
      'torso.Position = coin.Position + Vector3.new(0, 14, 0)',
      'torso.Parent = rig rig.PrimaryPart = torso rig.Parent = workspace',
      'local waited = 0',
      'while waited < 4 and coin.Parent do task.wait(0.1) waited += 0.1 end',
      'rig:Destroy()',
      'return string.format("touched=%s score=%s door=%s", tostring(coin.Parent == nil), tostring(sb.Scoreboard:GetAttribute("Coins")), tostring(sb.Door:GetAttribute("Open")))',
    ].join('\n'));
    await step('wait for respawn', 'task.wait(2.5) return "coin back=" .. tostring(workspace.PlaceboSandbox:FindFirstChild("Coin") ~= nil)');
  }

  await step('final state', [
    'local sb = workspace.PlaceboSandbox',
    'return string.format("score=%s doorOpen=%s doorPassable=%s", tostring(sb.Scoreboard:GetAttribute("Coins")), tostring(sb.Door:GetAttribute("Open")), tostring(sb.Door.CanCollide == false))',
  ].join('\n'));
} finally {
  await step('stop simulation', 'game:GetService("RunService"):Stop() task.wait(1) return "running=" .. tostring(game:GetService("RunService"):IsRunning())');
  await s.close();
}
