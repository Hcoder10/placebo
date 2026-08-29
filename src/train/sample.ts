import { createHash } from 'node:crypto';
import type { Candidate } from '../verifier/candidates.js';

/**
 * Candidates the model actually produces, rather than ones I wrote.
 *
 * The flywheel bootstrapped on hand-authored candidate lists: a correct
 * implementation plus a set of plausible ways to get it wrong. That works
 * exactly once. Every candidate is consumed on the first turn, the corpus stops
 * growing, and "continual" becomes a claim about a loop that has nothing left to
 * do — which is what the first two turns measured (18 rows, then +0).
 *
 * Sampling from the target fixes the supply, but the more important thing it
 * fixes is the *shape* of the data. Preference training on negatives I invented
 * teaches the model to avoid mistakes it was never going to make; the gradient
 * points away from my imagination rather than away from its own failure modes.
 * Negatives drawn from the model's own distribution are the ones that move it.
 *
 * Which is the same argument the rest of this project makes about verification,
 * pointed at the training data: what matters is what the thing being measured
 * actually does, not what an author assumed it would do.
 */

/** How many samples to draw per task per turn. */
const DEFAULT_COUNT = 12;

/**
 * Room to think *and* answer.
 *
 * Measured, not guessed. At 400 tokens this model spent all 400 reasoning and
 * returned `finish_reason: "length"` with an empty answer on every draw. At
 * 1600 it answers a short prompt but still runs out on a full task prompt,
 * which carries the goal, every requirement, and the current implementation.
 * Reasoning length scales with the prompt, so the budget has to clear the
 * longest one rather than the one that was convenient to test.
 */
const MAX_TOKENS = Number(process.env.PLACEBO_MAX_TOKENS ?? '3072');

/**
 * Temperature is high enough to produce genuine variety.
 *
 * At temperature 0 every sample is identical and the turn yields one row. The
 * point of sampling is to find the edges of the model's competence, and those
 * only appear off the argmax.
 */
const DEFAULT_TEMPERATURE = 0.9;

/**
 * Pulls the Luau body out of a chat completion.
 *
 * Models fence code even when told not to, and gpt-oss additionally emits
 * Harmony channel markers when a reasoning parser is not configured. Both are
 * stripped here rather than by prompting harder, because a parser that only
 * works when the model cooperates is not a parser.
 */
export function extractLuau(raw: string): string {
  let text = raw.trim();

  // Harmony leakage: everything before the final channel marker is not code.
  const channel = text.lastIndexOf('<|channel|>');
  if (channel !== -1) {
    const after = text.slice(channel);
    const message = after.indexOf('<|message|>');
    if (message !== -1) text = after.slice(message + '<|message|>'.length);
  }
  text = text.replace(/<\|[a-z_]+\|>/g, '').trim();

  const fenced = /```(?:lua|luau)?\s*\n([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) return fenced[1].trim();

  // An unterminated fence is common when generation hits the token limit.
  const opening = /```(?:lua|luau)?\s*\n([\s\S]*)$/.exec(text);
  if (opening?.[1]) return opening[1].trim();

  return text;
}

/**
 * Is this worth spending engine runs on?
 *
 * Engine evaluation is the expensive resource here -- every candidate costs a
 * full world rebuild per condition per realization -- so output that is plainly
 * not code is discarded before it gets there.
 *
 * The bar is deliberately low, and the reason is worth stating: deciding
 * whether Luau is *correct* is the engine's job, and a cleverer filter starts
 * silently discarding the interesting failures. An earlier version also
 * required the text to mention `sandbox`, which threw away every sample where
 * the model reached for `game:GetService` instead -- a real and instructive
 * mistake the corpus wants as a negative, not one the filter should hide.
 * The only thing being excluded is prose.
 *
 * Returns the name of the check that failed, or null when the sample passes,
 * so a run that discards everything can say which rule did it.
 */
function implausible(luau: string): string | null {
  if (luau.length < 12) return 'too-short';

  // A first-person plural plan ("We need to...") is the model thinking out
  // loud. Checked first: reasoning text can still contain the word `function`.
  if (/^\s*(we|the user|okay|so\b|let's|first,|i need|here'?s)\b/i.test(luau)) return 'prose-opening';

  const constructs = [
    /\blocal\s+\w/,
    /\bfunction\s*\(/,
    /\bfunction\s+\w/,
    /:Connect\s*\(/,
    /:SetAttribute\s*\(/,
    /:GetAttribute\s*\(/,
    /\bInstance\.new\s*\(/,
    /\bgame:GetService\s*\(/,
    /\bend\s*\)/,
  ];
  if (!constructs.some(pattern => pattern.test(luau))) return 'no-luau-construct';

  return null;
}

export interface SampleParams {
  endpoint: string;
  model: string;
  system: string;
  prompt: string;
  count?: number;
  temperature?: number;
  /** Ids already in the corpus, so a re-run does not pay to re-evaluate them. */
  known?: ReadonlySet<string>;
}

export interface SampleReport {
  candidates: Candidate[];
  requested: number;
  returned: number;
  /** Answered, but the answer was not code. */
  unusable: number;
  duplicates: number;
  /** Reasoned past the token budget without ever reaching an answer. */
  truncated: number;
  /**
   * Never answered at all.
   *
   * Kept apart from `unusable` on purpose. A saturated server and a model that
   * cannot write the mechanic both reduce the yield to zero, and folding them
   * into one counter is how "the endpoint was busy" gets written down as "the
   * model failed". They have opposite remedies, so they get opposite columns.
   */
  failed: number;
}

/**
 * Draws candidates from the target and returns the distinct usable ones.
 *
 * Ids are content addresses of the code itself, not sequence numbers. Two
 * samples that happen to be identical collapse to one row, and a candidate that
 * reappears on a later turn is recognised as already measured. That is what
 * keeps an unattended loop from paying for the same engine runs forever, and it
 * holds across restarts without any bookkeeping beyond the corpus itself.
 */
/**
 * One draw, retried through transient refusals.
 *
 * The target is shared with whatever else is running against it, so a draw can
 * fail simply because a few hundred other requests are in flight. Retrying is
 * not politeness towards a flaky service, it is the difference between a corpus
 * row that says something about the model and one that says something about
 * load at the moment it was collected.
 */
interface Draw {
  content: string;
  /** vLLM's own word for why generation stopped; "length" means truncated. */
  finishReason: string;
}

async function draw(
  params: Required<Pick<SampleParams, 'endpoint' | 'model' | 'system' | 'prompt'>> & {
    temperature: number;
  },
): Promise<Draw | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${params.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: params.model,
        messages: [
          { role: 'system', content: params.system },
          { role: 'user', content: params.prompt },
        ],
        temperature: params.temperature,
        max_tokens: MAX_TOKENS,
      }),
    }).catch(() => null);

    if (response?.ok) {
      const body = (await response.json().catch(() => null)) as {
        choices?: { finish_reason?: string; message?: { content?: string | null } }[];
      } | null;
      const choice = body?.choices?.[0];
      // Only a transport failure is worth another attempt; an empty answer is
      // a real answer and a truncated one is a real budget problem.
      return { content: choice?.message?.content ?? '', finishReason: choice?.finish_reason ?? 'unknown' };
    }

    await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
  }
  return null;
}

export async function sampleCandidates(params: SampleParams): Promise<SampleReport> {
  const {
    endpoint,
    model,
    system,
    prompt,
    count = DEFAULT_COUNT,
    temperature = DEFAULT_TEMPERATURE,
    known = new Set<string>(),
  } = params;

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  let unusable = 0;
  let duplicates = 0;
  let failed = 0;
  let truncated = 0;

  // Batched rather than fired all at once. Twelve simultaneous long
  // generations against a shared endpoint mostly produces twelve slow ones.
  const draws: (Draw | null)[] = [];
  const CONCURRENCY = 4;
  for (let start = 0; start < count; start += CONCURRENCY) {
    const batch = Array.from({ length: Math.min(CONCURRENCY, count - start) }, () =>
      draw({ endpoint, model, system, prompt, temperature }),
    );
    draws.push(...(await Promise.all(batch)));
  }

  for (const raw of draws) {
    if (raw === null) {
      failed += 1;
      continue;
    }
    // Ran out of budget before reaching the answer channel. Counted apart from
    // `unusable` because the remedy is a bigger budget, not a better model, and
    // a run that silently files these as unusable reports a capability problem
    // it did not measure.
    if (raw.finishReason === 'length' && !raw.content.trim()) {
      truncated += 1;
      continue;
    }
    const luau = extractLuau(raw.content);
    const rejected = implausible(luau);
    if (rejected !== null) {
      unusable += 1;
      // Why a draw was discarded is the difference between a filter that is
      // protecting the corpus and one that is quietly emptying it.
      if (process.env.PLACEBO_DEBUG_SAMPLES === '1') {
        process.stdout.write(
          `    [unusable:${rejected}] len=${String(luau.length)} ${JSON.stringify(luau.slice(0, 120))}\n`,
        );
      }
      continue;
    }

    const id = `sampled-${createHash('sha1').update(luau).digest('hex').slice(0, 10)}`;
    if (seen.has(id) || known.has(id)) {
      duplicates += 1;
      continue;
    }
    seen.add(id);
    candidates.push({
      id,
      defect: 'unknown until the engine rules on it',
      // `correct` is deliberately left undefined. Nothing here has an opinion
      // about whether the sample works, and inventing one would turn the
      // verifier's own verdict into the expectation it is checked against.
      luau,
    });
  }

  return {
    candidates,
    requested: count,
    returned: candidates.length,
    unusable,
    duplicates,
    truncated,
    failed,
  };
}
