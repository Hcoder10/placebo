/**
 * Does DFlash actually make our workload faster?
 *
 *   npx tsx scripts/bench-dflash.ts
 *
 * Two endpoints, same model, same prompts, same sampling: one plain, one with
 * the DFlash draft. The prompts are the work this system actually does —
 * generating Luau game mechanics — because speculative decoding pays according
 * to how predictable the next tokens are, and a benchmark on open prose would
 * measure a different question than the one we care about.
 *
 * Temperature is 0 on both sides. Speculative decoding is supposed to be
 * output-preserving, so a difference in the text would mean something is wrong,
 * not that the drafter is being creative.
 */

const BASE = process.env.PLACEBO_BASE_URL ?? 'http://100.79.153.43:8000/v1';
const SPEC = process.env.PLACEBO_SPEC_URL ?? 'http://100.79.153.43:8002/v1';

const SYSTEM =
  'You implement Roblox game mechanics in Luau. Write only the Luau body. A folder named `sandbox` is in scope.';

const PROMPTS = [
  'Collecting the coin awards exactly one point and removes the coin.',
  'A door opens once the player has collected three coins.',
  'Stepping on the lava reduces the player health by ten, once per step.',
  'A button toggles a light on and off each time it is pressed.',
  'Picking up a key unlocks the chest, and only the chest it belongs to.',
];

interface Sample {
  ms: number;
  completionTokens: number;
  text: string;
}

async function generate(baseUrl: string, model: string, prompt: string): Promise<Sample | null> {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 320,
    }),
  }).catch(() => null);

  if (!response?.ok) return null;
  const body = (await response.json()) as {
    usage?: { completion_tokens?: number };
    choices?: { message?: { content?: string | null; reasoning?: string | null } }[];
  };

  const message = body.choices?.[0]?.message;
  return {
    ms: Date.now() - started,
    completionTokens: body.usage?.completion_tokens ?? 0,
    text: (message?.content ?? message?.reasoning ?? '').slice(0, 60),
  };
}

async function run(label: string, baseUrl: string, model: string): Promise<void> {
  // One warm-up so compilation and cache effects do not land in the measurement.
  await generate(baseUrl, model, 'Return the word ready.');

  let totalMs = 0;
  let totalTokens = 0;
  let failures = 0;

  for (const prompt of PROMPTS) {
    const sample = await generate(baseUrl, model, prompt);
    if (!sample) {
      failures += 1;
      continue;
    }
    totalMs += sample.ms;
    totalTokens += sample.completionTokens;
    process.stdout.write(
      `    ${String(sample.completionTokens).padStart(4)} tok  ${String(sample.ms).padStart(6)} ms  ${((sample.completionTokens / sample.ms) * 1000).toFixed(1).padStart(6)} tok/s\n`,
    );
  }

  const rate = totalMs > 0 ? (totalTokens / totalMs) * 1000 : 0;
  process.stdout.write(
    `  ${label}: ${String(totalTokens)} tokens in ${(totalMs / 1000).toFixed(1)}s = ${rate.toFixed(1)} tok/s` +
      (failures ? `  (${String(failures)} failed)` : '') +
      '\n\n',
  );
}

process.stdout.write(`\n  baseline  ${BASE}\n`);
await run('baseline', BASE, 'gpt-oss-20b');

process.stdout.write(`  dflash    ${SPEC}\n`);
await run('dflash', SPEC, 'gpt-oss-spec');
