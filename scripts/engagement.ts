import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadTask } from '../src/verifier/task.js';
import { sampleCandidates } from '../src/train/sample.js';

/**
 * Does the model use the interface it was handed, or invent its own world?
 *
 *   npx tsx scripts/engagement.ts <model>
 *
 * This is the second version. The first one measured the prompt, twice over,
 * and it is worth writing down how because both failures are easy to repeat.
 *
 * It scored a completion as "engaged" if it referenced `sandbox.Collect`. Two
 * of the three tasks ship an existing implementation in the prompt, and that
 * baseline already contains that exact string, so the model copied it and
 * scored 100%. The third task ships no implementation AND never names the
 * event, so no model could reference it and every model scored 0%. The result
 * was 0/50, 50/50, 50/50 for every model tested, three of them landing on
 * exactly 100/150. Running it at n=150 with a tight Wilson interval made it
 * look like the most solid number in the project.
 *
 * The fix is to make the choice real. The prompt now carries the world
 * inventory, which is what `contract_get` and `project_source` give the agent
 * in the actual loop: these objects exist, these events exist, these
 * attributes exist. A model that then wires `Players.PlayerAdded` and builds
 * its own `leaderstats` is not missing information, it is ignoring what it was
 * given, and that is a property of the policy rather than of the prompt.
 *
 * The baseline implementation is deliberately NOT included. Anything quoted in
 * the prompt can be copied, and a metric that can be satisfied by copying
 * measures the prompt again.
 */

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'data', 'engagement.jsonl');

const SYSTEM = `You implement Roblox game mechanics in Luau.

Write only the Luau body. A folder named \`sandbox\` is already in scope.`;

const TASKS = ['tasks/build_coin.yaml', 'tasks/extend_door.yaml', 'tasks/repair_key.yaml'];

/**
 * The world, described the way the agent loop describes it.
 *
 * Parsed out of the contract's own setup so it cannot drift from what the
 * verifier will actually build.
 */
function inventory(setup: string): string {
  // Map each local variable to the instance it holds, so attributes are
  // reported against the instance name the contract uses rather than against
  // whatever the setup happened to call its local. An earlier version emitted
  // `board.@Coins`, and the model dutifully wrote `GetAttribute("@Coins")`.
  const varToName = new Map<string, string>();
  for (const m of setup.matchAll(/local\s+(\w+)\s*=\s*kit\.[\s\S]{0,160}?"([A-Za-z]\w*)"\s*\)/g)) {
    if (m[1] && m[2]) varToName.set(m[1], m[2]);
  }
  for (const m of setup.matchAll(/local\s+(\w+)\s*=\s*Instance\.new\([^)]*\)[\s\S]{0,80}?\.Name\s*=\s*"(\w+)"/g)) {
    if (m[1] && m[2]) varToName.set(m[1], m[2]);
  }

  // The name a kit constructor was given is its LAST string argument. Taking
  // any quoted string also collected palette names like "sand" and "cream",
  // which are colours, not objects.
  const objects: string[] = [];
  for (const m of setup.matchAll(/kit\.(\w+)\(([^;\n]*)\)/g)) {
    const fn = m[1];
    const args = m[2];
    if (!fn || !args || fn === 'tint' || fn === 'light' || fn === 'scene') continue;
    const quoted = [...args.matchAll(/"([A-Za-z]\w*)"/g)].map(q => q[1]).filter((q): q is string => Boolean(q));
    const last = quoted.at(-1);
    if (last && !objects.includes(last)) objects.push(last);
  }
  for (const name of varToName.values()) if (!objects.includes(name)) objects.push(name);

  const events: string[] = [];
  for (const m of setup.matchAll(/Instance\.new\("BindableEvent"\)[\s\S]{0,120}?\.Name\s*=\s*"(\w+)"/g)) {
    if (m[1]) events.push(m[1]);
  }

  const attrs: string[] = [];
  for (const m of setup.matchAll(/(\w+):SetAttribute\("(\w+)"/g)) {
    const owner = varToName.get(m[1] ?? '') ?? m[1];
    const line = `${String(owner)}.${String(m[2])}`;
    if (!attrs.includes(line)) attrs.push(line);
  }

  const lines = ['The sandbox already contains:'];
  if (objects.length) lines.push(`  objects: ${objects.filter(o => !events.includes(o)).join(', ')}`);
  if (events.length) lines.push(`  BindableEvents: ${events.map(e => `sandbox.${e}`).join(', ')}`);
  if (attrs.length) lines.push(`  attributes: ${attrs.join(', ')}`);
  lines.push('');
  lines.push('The interaction fires one of those BindableEvents. Connect to it.');
  return lines.join('\n');
}

/** Did it connect to an event it was told exists? */
function engages(luau: string, events: string[]): boolean {
  return events.some(e => new RegExp(String.raw`sandbox\s*[.:]\s*` + e + String.raw`\b`).test(luau));
}

/** Did it build its own world instead? */
function inventsOwnWorld(luau: string): boolean {
  return /\bPlayers\s*\.\s*PlayerAdded\b/.test(luau) || /\bleaderstats\b/.test(luau);
}

function wilson(hits: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
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
    const setup = contracts[0]?.setup ?? '';
    const events = [...setup.matchAll(/Instance\.new\("BindableEvent"\)[\s\S]{0,120}?\.Name\s*=\s*"(\w+)"/g)]
      .map(m => m[1])
      .filter((e): e is string => Boolean(e));

    const prompt = [
      `Goal: ${task.goal.trim()}`,
      '',
      'Requirements:',
      ...contracts.map(c => `  - ${c.requirement.trim()}`),
      '',
      inventory(setup),
    ].join('\n');

    const drawn = await sampleCandidates({ endpoint, model, system: SYSTEM, prompt, count: perTask });
    let e = 0;
    for (const c of drawn.candidates) {
      const hit = engages(c.luau, events);
      const own = inventsOwnWorld(c.luau);
      n += 1;
      if (hit) { engaged += 1; e += 1; }
      if (own) invented += 1;
      appendFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), model, task: task.id, candidate: c.id, engages: hit, inventsOwnWorld: own })}\n`, 'utf8');
    }
    process.stdout.write(`  ${model.padEnd(14)} ${task.id.padEnd(14)} ${String(e)}/${String(drawn.returned)} engaged\n`);
  }

  const [lo, hi] = wilson(engaged, n);
  process.stdout.write(`\n  ${model}\n    n ${String(n)}\n`);
  process.stdout.write(`    uses the given interface   ${String(engaged)} (${((engaged / n) * 100).toFixed(1)}%, 95% CI ${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)})\n`);
  process.stdout.write(`    invents its own world      ${String(invented)} (${((invented / n) * 100).toFixed(1)}%)\n\n`);
}

await main();
