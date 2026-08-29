/**
 * What the DFlash regression is actually made of.
 *
 *   npx tsx scripts/bench-control.ts
 *
 * `bench-dflash.ts` measured the speculative server 18% slower than the plain
 * one, and that comparison is confounded. Loading the drafter requires two vLLM
 * flags the plain server does not run with — `--disable-hybrid-kv-cache-manager`
 * and `--disable-sliding-window` — and both remove optimisations. So the gap is
 * `flag cost + speculation cost`, and charging all of it to speculation is
 * wrong; 18% is only an upper bound on what the drafter costs.
 *
 * This adds the missing arm: a third server, same weights, same two flags, no
 * speculator. With it the gap splits into the part the flags caused and the
 * part the drafter caused.
 *
 * Four things make that split trustworthy rather than decorative:
 *
 *   - the arms are interleaved, and the order rotates every round, so drift in
 *     a neighbouring tenant lands on all three arms rather than on whichever ran
 *     last. Each arm takes its whole prompt set back to back rather than one
 *     reading at a time, because these GPUs drop to 180MHz when idle and take a
 *     moment to boost: leaving gaps between an arm's readings measures the clock
 *     ramp instead of the server. An earlier version of this script waited on a
 *     busy arm between readings and drove the other two down to 25 tok/s doing
 *     it;
 *   - every reading is gated on the server being otherwise idle, checked before
 *     and after from vLLM's own counters, and thrown away if anyone else's
 *     request overlapped it. These servers are shared with the rest of the
 *     harness, and a throughput number taken while eight other requests are in
 *     flight is not a slower server, it is a different measurement;
 *   - each prompt is measured several times and scored on its *fastest* reading,
 *     because the rig is shared at the GPU level too — a training job on a
 *     neighbouring card slows an arm without showing up in that server's request
 *     counters. Interference can only ever subtract throughput, so the quickest
 *     run of a prompt is the one least contaminated by it. The median and the
 *     full spread are reported next to it, so a conclusion that depends on which
 *     estimator you pick is visible as one;
 *   - the comparison is paired — each prompt is compared against itself across
 *     arms — because the prompts differ in length, and an unpaired mean would
 *     partly be measuring which prompts happened to be long.
 *
 * Temperature is 0 everywhere. Speculation is meant to be output-preserving, so
 * where an arm is self-consistent across repeats its text should match the
 * control's; where an arm is not self-consistent, a cross-arm difference says
 * nothing, and the script only fails on the comparison it can actually make.
 */

interface Arm {
  key: string;
  url: string;
  model: string;
  note: string;
}

const ALL_ARMS: Arm[] = [
  {
    key: 'baseline',
    url: process.env.PLACEBO_BASE_URL ?? 'http://100.79.153.43:8000/v1',
    model: 'gpt-oss-20b',
    note: 'no flags, no speculator',
  },
  {
    key: 'control',
    url: process.env.PLACEBO_CONTROL_URL ?? 'http://100.79.153.43:8003/v1',
    model: 'gpt-oss-control',
    note: 'both flags, no speculator',
  },
  {
    key: 'dflash',
    url: process.env.PLACEBO_SPEC_URL ?? 'http://100.79.153.43:8002/v1',
    model: 'gpt-oss-spec',
    note: 'both flags, DFlash draft',
  },
];

/**
 * Which arms to run, so a saturated server can be measured on its own in a
 * patient pass without stalling the others. Always keep `control` in the set:
 * it is the arm both comparisons are taken against, and running it alongside
 * makes it the anchor that shows whether two passes are comparable at all.
 */
const ARMS: Arm[] = process.env.PLACEBO_BENCH_ARMS
  ? ALL_ARMS.filter(arm => process.env.PLACEBO_BENCH_ARMS?.split(',').includes(arm.key))
  : ALL_ARMS;

const REPEATS = Number.parseInt(process.env.PLACEBO_BENCH_REPEATS ?? '5', 10);
const MAX_TOKENS = 320;

/**
 * How long to wait for a quiet moment on a shared server, per reading. Kept
 * short on purpose: a long wait here stalls the arms that *are* free, and an
 * idle GPU drops its clocks, so patience on one arm is paid for in throughput
 * on the other two.
 */
const QUIET_BUDGET_MS = Number.parseInt(process.env.PLACEBO_QUIET_BUDGET_MS ?? '2500', 10);

/** Give up on an arm entirely after this many consecutive cells lost to traffic. */
const CONTENDED_GIVE_UP = Number.parseInt(process.env.PLACEBO_CONTENDED_GIVE_UP ?? '3', 10);

const SYSTEM =
  'You implement Roblox game mechanics in Luau. Write only the Luau body. A folder named `sandbox` is in scope.';

// The five bench-dflash.ts used come first, so the numbers stay comparable with
// the confounded measurement this run is meant to replace; the rest are the
// remainder of the speculation.ts workload, because attributing a ~20% effect
// off five prompts leaves too much of the answer resting on which five.
const PROMPTS = [
  'Collecting the coin awards exactly one point and removes the coin.',
  'A door opens once the player has collected three coins.',
  'Stepping on the lava reduces the player health by ten, once per step.',
  'A button toggles a light on and off each time it is pressed.',
  'Picking up a key unlocks the chest, and only the chest it belongs to.',
  'A checkpoint saves the player position, and respawning returns them to it.',
  'A timer counts down from sixty and ends the round when it reaches zero.',
  'Standing on the pressure plate opens the gate, and stepping off closes it.',
];

interface Sample {
  ms: number;
  tokens: number;
  text: string;
}

interface Reading extends Sample {
  arm: string;
  prompt: number;
}

type Generated = { ok: true; sample: Sample } | { ok: false; error: string };

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function generate(arm: Arm, prompt: string): Promise<Generated> {
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(`${arm.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: arm.model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        max_tokens: MAX_TOKENS,
      }),
    });
  } catch (cause) {
    return { ok: false, error: `request failed: ${cause instanceof Error ? cause.message : String(cause)}` };
  }

  const raw = await response.text();
  if (!response.ok) {
    // Worth surfacing rather than counting. A server that answers four prompts
    // and refuses the fifth has a different problem than a slow one.
    let detail = raw.slice(0, 160);
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      // Not JSON; the raw prefix is the best description available.
    }
    return { ok: false, error: `HTTP ${String(response.status)}: ${detail}` };
  }

  const body = JSON.parse(raw) as {
    usage?: { completion_tokens?: number };
    choices?: { message?: { content?: string | null; reasoning?: string | null } }[];
  };
  const message = body.choices?.[0]?.message;
  return {
    ok: true,
    sample: {
      ms: Date.now() - started,
      tokens: body.usage?.completion_tokens ?? 0,
      text: `${message?.reasoning ?? ''} ${message?.content ?? ''}`,
    },
  };
}

interface Activity {
  running: number;
  waiting: number;
  finished: number;
}

/**
 * What else the server is doing. `running` catches traffic in flight either
 * side of our request; the `finished` delta catches a request that both started
 * and ended inside our window, which `running` alone would miss.
 */
async function activity(arm: Arm): Promise<Activity | null> {
  const origin = arm.url.replace(/\/v1\/?$/, '');
  const response = await fetch(`${origin}/metrics`).catch(() => null);
  if (!response?.ok) return null;
  const body = await response.text();

  const running = /^vllm:num_requests_running\{[^}]*\}\s+([0-9.e+]+)$/m.exec(body);
  const waiting = /^vllm:num_requests_waiting\{[^}]*\}\s+([0-9.e+]+)$/m.exec(body);
  let finished = 0;
  const pattern = /^vllm:request_success_total\{[^}]*\}\s+([0-9.e+]+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (match[1]) finished += Number.parseFloat(match[1]);
  }

  return {
    running: running?.[1] ? Number.parseFloat(running[1]) : 0,
    waiting: waiting?.[1] ? Number.parseFloat(waiting[1]) : 0,
    finished,
  };
}

/** Cumulative vLLM speculation counters, so a run is measured as a delta. */
async function readSpecCounters(
  arm: Arm,
): Promise<{ drafts: number; draftTokens: number; accepted: number } | null> {
  const origin = arm.url.replace(/\/v1\/?$/, '');
  const response = await fetch(`${origin}/metrics`).catch(() => null);
  if (!response?.ok) return null;
  const body = await response.text();

  const scalar = (name: string): number => {
    const match = new RegExp(`^vllm:${name}\\{[^}]*\\}\\s+([0-9.e+]+)$`, 'm').exec(body);
    return match?.[1] ? Number.parseFloat(match[1]) : 0;
  };

  return {
    drafts: scalar('spec_decode_num_drafts_total'),
    draftTokens: scalar('spec_decode_num_draft_tokens_total'),
    accepted: scalar('spec_decode_num_accepted_tokens_total'),
  };
}

type Outcome =
  | { kind: 'ok'; sample: Sample }
  | { kind: 'error'; error: string }
  | { kind: 'contended' };

/**
 * One reading, taken only if the server was ours alone for its whole duration.
 * If it was not, retry until the budget runs out and then say so, because a
 * contended reading reported as a clean one is exactly the mistake this script
 * exists to correct.
 */
async function measureQuiet(arm: Arm, prompt: string): Promise<Outcome> {
  const deadline = Date.now() + QUIET_BUDGET_MS;

  for (;;) {
    const before = await activity(arm);

    if (before && (before.running > 0 || before.waiting > 0)) {
      if (Date.now() >= deadline) return { kind: 'contended' };
      await sleep(400);
      continue;
    }

    const result = await generate(arm, prompt);
    if (!result.ok) return { kind: 'error', error: result.error };

    const after = await activity(arm);
    const overlapped =
      before !== null &&
      after !== null &&
      (after.running > 0 || after.waiting > 0 || after.finished - before.finished > 1);

    if (!overlapped) return { kind: 'ok', sample: result.sample };
    if (Date.now() >= deadline) return { kind: 'contended' };
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Sample standard deviation; 0 for fewer than two readings. */
function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance =
    values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function rate(sample: Sample): number {
  return sample.ms > 0 ? (sample.tokens / sample.ms) * 1000 : 0;
}

/** Rotate the arm order so no arm sits permanently first or last. */
function rotated(offset: number): Arm[] {
  const at = offset % ARMS.length;
  return [...ARMS.slice(at), ...ARMS.slice(0, at)];
}

/**
 * A freshly loaded server is slow for its first few full-length generations —
 * the control arm's first three readings came in near 65 tok/s and everything
 * after them near 250. One short warm-up request does not cover that, so keep
 * generating at full length until two consecutive readings agree, and print the
 * trace so the settling is visible rather than assumed.
 */
async function warmUp(arm: Arm): Promise<number[]> {
  const trace: number[] = [];
  let previous = 0;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const prompt = PROMPTS[attempt % PROMPTS.length];
    if (prompt === undefined) break;

    const outcome = await measureQuiet(arm, prompt);
    if (outcome.kind === 'contended') break; // Nothing to warm; the arm is unusable anyway.
    if (outcome.kind === 'error') continue; // A prompt this arm cannot serve is not a warm-up signal.

    const current = rate(outcome.sample);
    trace.push(current);
    if (previous > 0 && Math.abs(current - previous) / Math.max(current, previous) < 0.05) break;
    previous = current;
  }

  return trace;
}

/** How much of two generations is byte-identical before they diverge. */
function commonPrefix(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

async function main(): Promise<void> {
  process.stdout.write('\n  three arms, same weights, same prompts, temperature 0\n\n');
  for (const arm of ARMS) {
    process.stdout.write(`    ${arm.key.padEnd(9)} ${arm.url.padEnd(30)} ${arm.note}\n`);
  }

  for (const arm of ARMS) {
    const probe = await fetch(`${arm.url}/models`).catch(() => null);
    if (!probe?.ok) {
      process.stdout.write(`\n  ${arm.key} is not answering at ${arm.url}\n\n`);
      process.exitCode = 1;
      return;
    }
  }

  process.stdout.write('\n  warming up until throughput settles\n');
  for (const arm of ARMS) {
    const trace = await warmUp(arm);
    process.stdout.write(
      `    ${arm.key.padEnd(9)} ${trace.length > 0 ? trace.map(value => value.toFixed(0)).join(' -> ') : 'skipped'}\n`,
    );
  }

  const specArm = ARMS.find(arm => arm.key === 'dflash');
  const specBefore = specArm ? await readSpecCounters(specArm) : null;

  const readings: Reading[] = [];
  const errors = new Map<string, Map<string, number>>();
  const contended = new Map<string, number>();
  const consecutive = new Map<string, number>();
  const abandoned = new Set<string>();

  process.stdout.write(
    `\n  ${String(REPEATS)} repeats x ${String(PROMPTS.length)} prompts, arms interleaved, readings gated on an idle server\n\n`,
  );

  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    for (const arm of rotated(repeat)) {
      if (abandoned.has(arm.key)) continue;

      const cells: string[] = [];

      for (let index = 0; index < PROMPTS.length; index += 1) {
        const prompt = PROMPTS[index];
        if (prompt === undefined) continue;

        const outcome = await measureQuiet(arm, prompt);

        if (outcome.kind === 'ok') {
          readings.push({ ...outcome.sample, arm: arm.key, prompt: index });
          cells.push(rate(outcome.sample).toFixed(1).padStart(6));
          consecutive.set(arm.key, 0);
          continue;
        }

        if (outcome.kind === 'error') {
          const perArm = errors.get(arm.key) ?? new Map<string, number>();
          perArm.set(outcome.error, (perArm.get(outcome.error) ?? 0) + 1);
          errors.set(arm.key, perArm);
          cells.push('  fail');
          consecutive.set(arm.key, 0);
          continue;
        }

        contended.set(arm.key, (contended.get(arm.key) ?? 0) + 1);
        consecutive.set(arm.key, (consecutive.get(arm.key) ?? 0) + 1);
        cells.push('  busy');
      }

      process.stdout.write(`    r${String(repeat + 1)}  ${arm.key.padEnd(9)} ${cells.join(' ')}  tok/s\n`);

      // A server saturated for whole rounds on end is not going to come free by
      // being asked again; record it as unmeasurable rather than burning the
      // clock, which also keeps the other arms' readings back to back.
      if ((consecutive.get(arm.key) ?? 0) >= CONTENDED_GIVE_UP * PROMPTS.length) {
        abandoned.add(arm.key);
        process.stdout.write(
          `        ${arm.key} is serving other traffic continuously; no clean reading is available\n`,
        );
      }
    }
  }

  const specAfter = specArm ? await readSpecCounters(specArm) : null;

  // ---- per-arm throughput, with the spread that says whether a gap is real ----

  process.stdout.write('\n  per arm (clean readings only)\n\n');
  process.stdout.write('    arm         n   mean tok/s      sd  median     min    best   aggregate\n');

  for (const arm of ARMS) {
    const armReadings = readings.filter(reading => reading.arm === arm.key);
    const rates = armReadings.map(rate);
    if (rates.length === 0) {
      process.stdout.write(`    ${arm.key.padEnd(9)}   0   no clean readings\n`);
      continue;
    }
    const totalMs = armReadings.reduce((total, reading) => total + reading.ms, 0);
    const totalTokens = armReadings.reduce((total, reading) => total + reading.tokens, 0);
    const aggregate = totalMs > 0 ? (totalTokens / totalMs) * 1000 : 0;
    process.stdout.write(
      `    ${arm.key.padEnd(9)} ${String(rates.length).padStart(3)}   ` +
        `${mean(rates).toFixed(1).padStart(9)}  ${stddev(rates).toFixed(1).padStart(6)}  ` +
        `${median(rates).toFixed(1).padStart(6)}  ` +
        `${Math.min(...rates).toFixed(1).padStart(6)}  ${Math.max(...rates).toFixed(1).padStart(6)}  ` +
        `${aggregate.toFixed(1).padStart(10)}\n`,
    );
  }

  for (const [key, count] of contended) {
    process.stdout.write(`    ${key}: ${String(count)} readings discarded, server was serving other traffic\n`);
  }
  for (const [key, perArm] of errors) {
    for (const [message, count] of perArm) {
      process.stdout.write(`    ${key}: ${String(count)}x ${message}\n`);
    }
  }

  // ---- paired comparison: each prompt against itself, across arms ----

  const ratiosFor = (
    numerator: string,
    denominator: string,
    score: (values: number[]) => number,
  ): number[] => {
    const values: number[] = [];
    for (let index = 0; index < PROMPTS.length; index += 1) {
      const top = readings
        .filter(reading => reading.arm === numerator && reading.prompt === index)
        .map(rate);
      const bottom = readings
        .filter(reading => reading.arm === denominator && reading.prompt === index)
        .map(rate);
      if (top.length === 0 || bottom.length === 0) continue;
      const scored = score(bottom);
      if (scored > 0) values.push(score(top) / scored);
    }
    return values;
  };

  const best = (values: number[]): number => (values.length === 0 ? 0 : Math.max(...values));

  const pairs: [string, string, string][] = [
    ['flags', 'control', 'baseline'],
    ['speculation', 'dflash', 'control'],
    ['combined', 'dflash', 'baseline'],
  ];

  process.stdout.write('\n  paired by prompt, each prompt compared against itself across arms\n\n');
  for (const [label, numerator, denominator] of pairs) {
    const bestRatios = ratiosFor(numerator, denominator, best);
    if (bestRatios.length === 0) {
      process.stdout.write(`    ${label.padEnd(12)} ${numerator} / ${denominator}   not measurable\n`);
      continue;
    }

    const centre = median(bestRatios);
    const cost = (1 - centre) * 100;
    process.stdout.write(
      `    ${label.padEnd(12)} ${numerator} / ${denominator}   ` +
        `${centre.toFixed(3)}x  over ${String(bestRatios.length)} prompts ` +
        `(range ${Math.min(...bestRatios).toFixed(3)} - ${Math.max(...bestRatios).toFixed(3)})   ` +
        `${cost >= 0 ? 'costs' : 'gains'} ${Math.abs(cost).toFixed(1)}%\n`,
    );

    // If the two estimators disagree, the gap is being carried by contention
    // rather than by the thing under test, and that is worth seeing.
    const medianRatios = ratiosFor(numerator, denominator, median);
    if (medianRatios.length > 0) {
      process.stdout.write(
        `    ${' '.repeat(12)} by median instead of best: ${median(medianRatios).toFixed(3)}x\n`,
      );
    }
  }

  // The noise floor the effects have to clear: how much one arm varies against
  // itself, measured the same paired way, repeat by repeat.
  const withinArm: number[] = [];
  for (const arm of ARMS) {
    for (let index = 0; index < PROMPTS.length; index += 1) {
      const rates = readings
        .filter(reading => reading.arm === arm.key && reading.prompt === index)
        .map(rate);
      if (rates.length < 2) continue;
      const centre = median(rates);
      if (centre > 0) withinArm.push((Math.max(...rates) - Math.min(...rates)) / centre);
    }
  }
  if (withinArm.length > 0) {
    process.stdout.write(
      `\n    noise floor: repeats of one prompt on one arm spread ` +
        `${(median(withinArm) * 100).toFixed(1)}% median, ${(Math.max(...withinArm) * 100).toFixed(1)}% worst\n`,
    );
  }

  // ---- what the arms actually generated ----

  const textsFor = (armKey: string, index: number): string[] =>
    readings
      .filter(reading => reading.arm === armKey && reading.prompt === index)
      .map(reading => reading.text);

  /** A prompt an arm answered the same way every time; only those can be compared. */
  const isStable = (armKey: string, index: number): boolean => {
    const texts = textsFor(armKey, index);
    return texts.length >= 2 && new Set(texts).size === 1;
  };

  process.stdout.write('\n  text at temperature 0\n\n');
  for (const arm of ARMS) {
    let stable = 0;
    let measured = 0;
    for (let index = 0; index < PROMPTS.length; index += 1) {
      if (textsFor(arm.key, index).length < 2) continue;
      measured += 1;
      if (isStable(arm.key, index)) stable += 1;
    }
    process.stdout.write(
      `    ${arm.key.padEnd(9)} identical across repeats on ${String(stable)}/${String(measured)} prompts\n`,
    );
  }

  // Only compare prompts where both arms were self-consistent. Where an arm
  // disagrees with itself, a cross-arm difference is not evidence of anything.
  const compare = (
    armKey: string,
    against: string,
  ): { matches: number; compared: number; shares: number[] } => {
    let matches = 0;
    let compared = 0;
    const shares: number[] = [];

    for (let index = 0; index < PROMPTS.length; index += 1) {
      if (!isStable(armKey, index) || !isStable(against, index)) continue;
      const mine = textsFor(armKey, index)[0];
      const theirs = textsFor(against, index)[0];
      if (mine === undefined || theirs === undefined) continue;
      compared += 1;
      if (mine === theirs) {
        matches += 1;
        shares.push(1);
        continue;
      }
      // Where two stable generations differ, how far they agree first separates
      // a drafter that is producing different text from one whose arithmetic
      // drifts and then diverges like any greedy decode would.
      const shortest = Math.min(mine.length, theirs.length);
      shares.push(shortest > 0 ? commonPrefix(mine, theirs) / shortest : 0);
    }

    return { matches, compared, shares };
  };

  const spec = compare('dflash', 'control');
  const flags = compare('control', 'baseline');

  const shareNote = (shares: number[]): string =>
    shares.length === 0
      ? ''
      : `, agreeing on the first ${(median(shares) * 100).toFixed(0)}% of the text before diverging`;

  process.stdout.write(
    `\n    dflash matches control on ${String(spec.matches)}/${String(spec.compared)} of the prompts both answer stably` +
      `${shareNote(spec.shares)}` +
      ` — speculation is meant to be output-preserving\n`,
  );
  process.stdout.write(
    `    control matches baseline on ${String(flags.matches)}/${String(flags.compared)} of the prompts both answer stably` +
      `${shareNote(flags.shares)}` +
      ` — the flags change attention, so this is a measurement, not an invariant\n`,
  );

  // ---- what the drafter did during this run ----

  if (specBefore && specAfter) {
    const drafts = specAfter.drafts - specBefore.drafts;
    const draftTokens = specAfter.draftTokens - specBefore.draftTokens;
    const accepted = specAfter.accepted - specBefore.accepted;
    if (drafts > 0) {
      // +1 for the token the target produces itself on every verification step.
      process.stdout.write(
        `\n  dflash over this run: ${(draftTokens > 0 ? (accepted / draftTokens) * 100 : 0).toFixed(1)}% acceptance, ` +
          `${(accepted / drafts + 1).toFixed(2)} accepted length over ${String(drafts)} drafts\n`,
      );
    }
  }

  if (spec.compared > 0 && spec.matches < spec.compared) {
    process.stdout.write('\n  FAIL: speculation changed the output. That is a bug, not a speedup.\n\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\n');
}

await main();
