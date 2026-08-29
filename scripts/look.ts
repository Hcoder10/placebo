import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StudioSession } from '../src/verifier/studio.js';

/**
 * Take a picture of the built world.
 *
 *   npx tsx scripts/look.ts [out.png] [RootName]
 *
 * Every appearance check in this repo measures a property -- palette adherence,
 * alignment, interpenetration, variety. Those are worth having and they all
 * passed on a world a person then described, correctly, as looking terrible.
 * Checkable properties are not the same as composition, and nothing in the
 * pipeline could see the difference because nothing in the pipeline could see.
 *
 * The camera is framed to the world's own bounding box first, so the picture is
 * of the game rather than of wherever the camera happened to be left.
 */

const out = process.argv[2] ?? join(import.meta.dirname, '..', 'data', 'look.png');
const root = process.argv[3] ?? 'PlaceboSandbox';

const s = new StudioSession();
await s.connect();

const framed = await s.luau([
  `local sb = workspace:FindFirstChild(${JSON.stringify(root)})`,
  'if not sb then return "no world at " .. ' + JSON.stringify(root) + ' end',
  'local min, max, parts = nil, nil, 0',
  'for _, p in ipairs(sb:GetDescendants()) do',
  '  if p:IsA("BasePart") then',
  '    parts += 1',
  '    local a, b = p.Position - p.Size/2, p.Position + p.Size/2',
  '    min = min and Vector3.new(math.min(min.X,a.X), math.min(min.Y,a.Y), math.min(min.Z,a.Z)) or a',
  '    max = max and Vector3.new(math.max(max.X,b.X), math.max(max.Y,b.Y), math.max(max.Z,b.Z)) or b',
  '  end',
  'end',
  'if not min then return "no parts" end',
  'local centre = (min + max) / 2',
  'local span = (max - min).Magnitude',
  'local cam = workspace.CurrentCamera',
  'cam.CFrame = CFrame.new(centre + Vector3.new(span*0.55, span*0.45, span*0.55), centre)',
  'return string.format("framed %d parts, span %.0f studs", parts, span)',
].join('\n'));

process.stdout.write(`  ${String(framed)}\n`);

const shot = (await s.call('screenshot_take', { format: 'png' })) as {
  data?: { image_base64?: string; width?: number; height?: number };
};
const b64 = shot.data?.image_base64;
if (!b64) {
  process.stdout.write('  screenshot returned no image\n');
  process.exitCode = 1;
} else {
  writeFileSync(out, Buffer.from(b64, 'base64'));
  process.stdout.write(`  saved ${String(shot.data?.width)}x${String(shot.data?.height)} to ${out}\n`);
}
await s.close();
