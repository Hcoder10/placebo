import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { SYSTEM } from './prompt.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCurriculum, type CurriculumItem } from '../bright/curriculum.js';
import { extract, fetchDocument } from '../bright/pipeline.js';
import { loadSpec } from '../bright/spec.js';
import {
  confirmAbsent,
  curriculumNote,
  generatorInputFor,
  probeSeparability,
  renderReferenceMigration,
  renderShortcuts,
  writeGeneratedTask,
  type GeneratorInput,
  type Separability,
} from '../bright/tasks.js';
import { candidateId, extractLuau } from './sample.js';
import { evaluateTask, verifyBaseline } from '../verifier/evaluateTask.js';
import { StudioSession } from '../verifier/studio.js';
import { loadTask } from '../verifier/task.js';

/**
 * Scraped claims, all the way into the training data.
 *
 *   npx tsx src/train/curriculum_train.ts
 *
 * `continual.ts` already scrapes, adjudicates, and writes surviving claims to
 * `data/curriculum.jsonl`. That file was a dead end: the corpus, the SFT set and
 * the preference pairs were all built from hand-written tasks, so "Bright Data
 * is in the pipeline" described a file sitting next to the pipeline rather than
 * anything the model was trained on.
 *
 * This closes it. A claim that survives engine adjudication is turned into a
 * generated repair task (`src/bright/tasks.ts`), the target model is sampled on
 * it, every sample is judged by the same causal verifier as every other task,
 * and the accepted and rejected ones land in `data/corpus.jsonl` — from which
 * `data/sft.jsonl` and `data/dpo.jsonl` are rebuilt. A scraped fact now has a
 * measurable weight in the training set.
 *
 * It also measures the cheaper thing worth knowing, and measures it against a
 * control. The model is sampled on the same task three ways: with the scraped
 * API note in its prompt, without it, and with a note of identical shape whose
 * replacement name the engine has confirmed does not exist. The third arm is
 * what stops "acceptance rose when we added the note" from being a claim about
 * prompt length rather than about the scraped fact.
 *
 * What has NOT changed is who decides truth. The web supplies a candidate
 * migration; the engine decides whether a world can even be built in which the
 * two members differ, and the verifier decides whether any given patch works.
 * A claim the engine will not corroborate produces no task, and a task no
 * implementation passes produces no positive rows.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const DATA = join(ROOT, 'data');
const CORPUS = join(DATA, 'corpus.jsonl');
const DPO = join(DATA, 'dpo.jsonl');
const SFT = join(DATA, 'sft.jsonl');
const MEASUREMENT = join(DATA, 'curriculum-measurement.json');
/**
 * Every arm ever run, appended.
 *
 * One run of sixteen draws per arm is not enough draws to tell a real effect
 * from a lucky sample, and overwriting the measurement each time would make it
 * impossible to accumulate any. Runs append here instead, and the report pools
 * them — so leaving the loop running is what buys the confidence rather than
 * choosing a single flattering run.
 */
const ARM_HISTORY = join(DATA, 'curriculum-arms.jsonl');
const SPEC_PATH = process.env.PLACEBO_SCRAPER ?? join(ROOT, 'scrapers', 'roblox-deprecations.yaml');

const ENDPOINT = process.env.PLACEBO_BASE_URL ?? 'http://100.79.153.43:8000/v1';
const MODEL = process.env.PLACEBO_TARGET_MODEL ?? 'gpt-oss-20b';
/** Draws per arm. Three arms, so three times this many generations per task. */
const DRAWS = Number(process.env.PLACEBO_CURRICULUM_SAMPLES ?? '16');
const MAX_TOKENS = Number(process.env.PLACEBO_MAX_TOKENS ?? '3072');
const TEMPERATURE = 0.9;
const CONCURRENCY = 4;

/**
 * Copied verbatim from `src/train/continual.ts`, which owns it.
 *
 * It is duplicated rather than imported because that module runs its own
 * `main()` on import and does not export this. The two must stay identical: it
 * is the system turn written into every SFT row, and a rebuild from one script
 * that disagreed with the other would silently change what the model is trained
 * against. Exporting it from `continual.ts` would remove this note.
 */
// Imported, not copied. Both this and continual.ts rebuild sft.jsonl from the
// same corpus, so a divergence here silently puts two different system prompts
// in one training file. They had already drifted by a word.


/** The corpus row shape `continual.ts` writes, plus provenance for these rows. */
interface CorpusRow {
  key: string;
  task: string;
  candidate: string;
  prompt: string;
  completion: string;
  accepted: boolean;
  reason: string;
  turn: number;
  at: string;
  /** Only on rows this script writes: which prompt arm produced the sample. */
  arm?: string;
  /** Only on rows this script writes: the scraped claim that generated the task. */
  claim?: string;
}

function readCorpus(): Map<string, CorpusRow> {
  const rows = new Map<string, CorpusRow>();
  if (!existsSync(CORPUS)) return rows;
  for (const line of readFileSync(CORPUS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as CorpusRow;
    rows.set(row.key, row);
  }
  return rows;
}

function nextTurn(rows: Map<string, CorpusRow>): number {
  let highest = 0;
  for (const row of rows.values()) highest = Math.max(highest, row.turn);
  return highest + 1;
}

/**
 * Is this worth spending engine runs on?
 *
 * The same low bar `sample.ts` applies, for the same reason: whether Luau is
 * *correct* is the engine's job, and a cleverer filter starts hiding the
 * interesting failures. The only thing excluded is prose. Draws that fail it are
 * still counted in the per-arm denominator — they are real draws that produced
 * no working mechanic — they just do not become corpus rows.
 */
function looksLikeLuau(text: string): boolean {
  if (text.trim().length < 12) return false;
  if (/^\s*(we|the user|okay|so\b|let's|first,|i need|here'?s)\b/i.test(text)) return false;
  return [
    /\blocal\s+\w/,
    /\bfunction\s*\(/,
    /\bfunction\s+\w/,
    /:Connect\s*\(/,
    /:SetAttribute\s*\(/,
    /:GetAttribute\s*\(/,
    /\bInstance\.new\s*\(/,
    /\bgame:GetService\s*\(/,
  ].some(pattern => pattern.test(text));
}

interface Draw {
  content: string;
  finishReason: string;
}

async function draw(system: string, prompt: string): Promise<Draw | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
      }),
    }).catch(() => null);

    if (response?.ok) {
      const body = (await response.json().catch(() => null)) as {
        choices?: { finish_reason?: string; message?: { content?: string | null } }[];
      } | null;
      const choice = body?.choices?.[0];
      return { content: choice?.message?.content ?? '', finishReason: choice?.finish_reason ?? 'unknown' };
    }
    await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
  }
  return null;
}

interface ArmResult {
  arm: string;
  prompt: string;
  draws: number;
  /** Draws the server never answered. */
  failed: number;
  /** Draws that reasoned past the token budget without reaching an answer. */
  truncated: number;
  /** Draws whose answer was prose rather than a mechanic. */
  notCode: number;
  /** Draws that produced a runnable candidate. */
  code: number;
  /**
   * Draws whose program the engine never returned a verdict on.
   *
   * Studio is shared, and a bridge timeout while another agent holds it comes
   * back as a failed evaluation. Counting those as rejections would write "the
   * engine was busy" down as "the model was wrong" — the same distinction
   * `sample.ts` keeps between a saturated server and a bad answer, moved to the
   * verifier. They are excluded from the denominator rather than scored.
   */
  unmeasured: number;
  /** Distinct programs among those. */
  distinct: number;
  /** Draws whose program the verifier accepted. */
  accepted: number;
  /** candidateId -> the code, for every distinct program this arm produced. */
  programs: Map<string, string>;
  /** One entry per draw that produced code, so acceptance is counted per draw. */
  perDraw: string[];
}

async function runArm(params: { arm: string; prompt: string }): Promise<ArmResult> {
  const result: ArmResult = {
    arm: params.arm,
    prompt: params.prompt,
    draws: DRAWS,
    failed: 0,
    truncated: 0,
    notCode: 0,
    code: 0,
    unmeasured: 0,
    distinct: 0,
    accepted: 0,
    programs: new Map(),
    perDraw: [],
  };

  const raws: (Draw | null)[] = [];
  for (let start = 0; start < DRAWS; start += CONCURRENCY) {
    const batch = Array.from({ length: Math.min(CONCURRENCY, DRAWS - start) }, () =>
      draw(SYSTEM, params.prompt),
    );
    raws.push(...(await Promise.all(batch)));
  }

  for (const raw of raws) {
    if (raw === null) {
      result.failed += 1;
      continue;
    }
    if (raw.finishReason === 'length' && !raw.content.trim()) {
      result.truncated += 1;
      continue;
    }
    const luau = extractLuau(raw.content);
    if (!looksLikeLuau(luau)) {
      result.notCode += 1;
      continue;
    }
    const id = candidateId(luau);
    result.code += 1;
    result.perDraw.push(id);
    result.programs.set(id, luau);
  }

  result.distinct = result.programs.size;
  return result;
}

/**
 * Rebuilds the SFT and preference files from the whole corpus.
 *
 * Same rule `continual.ts` applies, deliberately: accepted completions are
 * supervised targets, and every accepted/rejected pair within a task is a
 * preference pair whose label came from the engine rather than an annotator.
 * Written in one call rather than appended row by row, because these files are
 * read by training runs that may be going on at the same time.
 */
function rebuild(rows: CorpusRow[]): { sft: number; dpo: number } {
  const byTask = new Map<string, CorpusRow[]>();
  for (const row of rows) byTask.set(row.task, [...(byTask.get(row.task) ?? []), row]);

  const sftLines: string[] = [];
  const dpoLines: string[] = [];

  for (const [, group] of byTask) {
    const accepted = group.filter(row => row.accepted);
    const rejected = group.filter(row => !row.accepted);

    for (const row of accepted) {
      sftLines.push(
        JSON.stringify({
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: row.prompt },
            { role: 'assistant', content: `\`\`\`lua\n${row.completion}\n\`\`\`` },
          ],
          meta: { task: row.task, candidate: row.candidate, turn: row.turn },
        }),
      );
    }

    for (const chosen of accepted) {
      for (const loser of rejected) {
        dpoLines.push(
          JSON.stringify({
            prompt: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: chosen.prompt },
            ],
            chosen: `\`\`\`lua\n${chosen.completion}\n\`\`\``,
            rejected: `\`\`\`lua\n${loser.completion}\n\`\`\``,
            meta: {
              task: chosen.task,
              chosen_id: chosen.candidate,
              rejected_id: loser.candidate,
              rejected_because: loser.reason,
              turn: Math.max(chosen.turn, loser.turn),
            },
          }),
        );
      }
    }
  }

  writeFileSync(SFT, sftLines.length ? `${sftLines.join('\n')}\n` : '', 'utf8');
  writeFileSync(DPO, dpoLines.length ? `${dpoLines.join('\n')}\n` : '', 'utf8');
  return { sft: sftLines.length, dpo: dpoLines.length };
}

/** Small p-values are the interesting ones; rounding them to 0.000 hides that. */
function formatP(value: number): string {
  return value < 0.001 ? value.toExponential(2) : value.toFixed(3);
}

function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

/** One arm of one run, as it is appended to the history file. */
interface ArmRecord {
  at: string;
  task: string;
  model: string;
  arm: string;
  draws: number;
  code: number;
  accepted: number;
}

function readArmHistory(): ArmRecord[] {
  if (!existsSync(ARM_HISTORY)) return [];
  return readFileSync(ARM_HISTORY, 'utf8')
    .split('\n')
    .filter(text => text.trim())
    .map(text => JSON.parse(text) as ArmRecord);
}

const logFactorialCache = [0, 0];
function logFactorial(n: number): number {
  for (let index = logFactorialCache.length; index <= n; index += 1) {
    logFactorialCache[index] = (logFactorialCache[index - 1] ?? 0) + Math.log(index);
  }
  return logFactorialCache[n] ?? 0;
}

/**
 * Two-sided Fisher exact test on the 2x2 table of accepted/not by arm.
 *
 * Exact rather than a normal approximation because the counts here are in the
 * dozens, which is exactly where the approximation starts inventing confidence.
 * Reported so the effect can be read with the right amount of scepticism: a
 * difference in acceptance across a few dozen draws is easy to produce by
 * chance, and saying so is part of the measurement.
 */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  const logP = (w: number, x: number, y: number, z: number): number =>
    logFactorial(w + x) +
    logFactorial(y + z) +
    logFactorial(w + y) +
    logFactorial(x + z) -
    logFactorial(n) -
    logFactorial(w) -
    logFactorial(x) -
    logFactorial(y) -
    logFactorial(z);

  const observed = logP(a, b, c, d);
  const rowOne = a + b;
  const colOne = a + c;
  let total = 0;
  for (let i = Math.max(0, colOne - (c + d)); i <= Math.min(rowOne, colOne); i += 1) {
    const candidate = logP(i, rowOne - i, colOne - i, n - rowOne - colOne + i);
    // 1e-9 of slack: equally likely tables must be counted in, and floating
    // point makes exact equality unreliable.
    if (candidate <= observed + 1e-9) total += Math.exp(candidate);
  }
  return Math.min(1, total);
}

async function main(): Promise<void> {
  mkdirSync(DATA, { recursive: true });

  const spec = loadSpec(SPEC_PATH);
  const fetched = await fetchDocument(spec, join(ROOT, 'fixtures'));
  const extracted = extract(spec, fetched.html);

  line();
  line(`  scraper ${spec.name} revision ${String(spec.revision)}`);
  line(`  ${spec.url}`);
  line(`  fetched via ${fetched.via} at ${fetched.fetchedAt}`);
  line(`  ${String(extracted.records.length)}/${String(extracted.recordCount)} records extracted` +
    (extracted.brokenFields.length ? `  BROKEN: ${extracted.brokenFields.join(', ')}` : '  all fields healthy'));

  if (extracted.brokenFields.length > 0) {
    line(`  the scraper needs repair before its claims mean anything; run src/bright/cli.ts --repair`);
    process.exitCode = 1;
    return;
  }

  const session = new StudioSession();
  await session.connect();

  // ---- gate one: does the engine believe the claim at all? -----------------
  const items = await buildCurriculum({ session, records: extracted.records });
  line();
  line('  the engine adjudicates the scraped claims:');
  for (const item of items) {
    line(`    ${(item.verdict === 'confirmed' ? 'CONFIRMED' : 'REJECTED').padEnd(10)} ${String(item.record.class_name)}.${String(item.record.member)} -> ${String(item.record.replacement)}`);
    line(`               ${item.detail}`);
  }
  const confirmed = items.filter(item => item.proposal);

  // ---- gate two: can a world be built in which the claim is a real task? ---
  line();
  line('  the engine decides whether a task is constructible:');
  const buildable: { item: CurriculumItem; separability: Separability; input: GeneratorInput }[] = [];
  const unbuildable: { item: CurriculumItem; separability: Separability }[] = [];
  for (const item of confirmed) {
    const separability = await probeSeparability({
      session,
      className: item.record.class_name ?? '',
      member: item.record.member ?? '',
      replacement: item.record.replacement ?? '',
    });
    const input = generatorInputFor({
      item,
      separability,
      source: { url: spec.url, via: fetched.via, fetchedAt: fetched.fetchedAt },
    });
    line(`    ${(separability.separable ? 'BUILDABLE' : 'DROPPED').padEnd(10)} ${String(item.record.class_name)}.${String(item.record.member)}`);
    line(`               ${separability.detail}`);
    if (input) buildable.push({ item, separability, input });
    else unbuildable.push({ item, separability });
  }

  const corpus = readCorpus();
  const turn = nextTurn(corpus);
  const corpusBefore = corpus.size;

  const measurements: unknown[] = [];
  let rowsAdded = 0;

  for (const { item, input } of buildable) {
    const generated = writeGeneratedTask(ROOT, input);
    line();
    line(`  generated ${generated.taskPath.replace(ROOT, '.')}`);
    line(`            ${generated.contractPath.replace(ROOT, '.')}`);

    const { task, contracts } = loadTask(generated.taskPath);

    // The generated task has to be a real task before it is worth sampling on:
    // the baseline must genuinely fail the contract, or every candidate would
    // "pass" and the rows would teach nothing.
    const baseline = await verifyBaseline({ session, task, contracts });
    if (!baseline.ok) {
      line(`  baseline check FAILED: ${baseline.problems.join('; ')}`);
      line('  no rows written for this claim.');
      continue;
    }
    line(`  baseline check: the deprecated implementation does not satisfy the contract (${baseline.result.outstanding.join(', ')})`);

    const basePrompt = [
      `Goal: ${task.goal.trim()}`,
      '',
      'Requirements:',
      ...contracts.map(contract => `  - ${contract.requirement.trim()}`),
      '',
      `Current implementation:\n\`\`\`lua\n${task.baseline.trim()}\n\`\`\``,
    ].join('\n');

    const note = curriculumNote({
      className: input.className,
      member: input.member,
      replacement: input.replacement,
      source: { url: spec.url, via: fetched.via },
    });

    // ---- the reference migration the claim itself proposes -----------------
    //
    // Run through the verifier rather than assumed. If the engine rejects the
    // migration the scraped claim suggests, the claim was wrong in a way
    // adjudication could not see, and that is worth finding out before any of
    // it is written down as training data.
    const reference = renderReferenceMigration(input);
    const referenceResult = await evaluateTask({ session, task, contracts, patchLuau: reference });
    line(
      `  reference migration (${input.className}.${input.replacement}): ` +
        `${referenceResult.accepted ? 'ACCEPTED by the verifier' : 'REJECTED by the verifier'}`,
    );

    // The reference migration is the known-good answer to this task. If the
    // engine will not accept it, no implementation can pass, and every draw
    // sampled against this world would be labelled a failure by a world that
    // was broken rather than by a model that was wrong.
    //
    // This is not hypothetical: Studio is shared, and a run overlapping another
    // agent's rebuild of the sandbox produced a round in which all three arms
    // scored zero. Nothing there was a measurement. So the run stops here and
    // writes nothing rather than adding two dozen fabricated rejections to the
    // corpus and the pooled statistics.
    if (!referenceResult.accepted) {
      const detail = referenceResult.outcomes
        .flatMap(outcome => [
          outcome.verdict.error ? `error: ${outcome.verdict.error}` : '',
          outcome.verdict.missing.length ? `missing ${outcome.verdict.missing.join(',')}` : '',
          outcome.verdict.collateral.length ? `collateral ${outcome.verdict.collateral.join(',')}` : '',
          outcome.verdict.isolated ? '' : 'conditions did not start from the same world',
        ])
        .filter(Boolean)
        .join('; ');
      line(`  the known-good implementation does not pass, so this world cannot label anything.`);
      line(`  ${detail}`);
      line('  no draws taken, no rows written. Re-run when Studio is free.');
      process.exitCode = 1;
      continue;
    }

    // ---- the shortcuts the contract claims to close ------------------------
    //
    // Run every time rather than argued for in a comment. If either of these
    // passes, the generated contract can be satisfied without reading the
    // member the scraped claim points at, and the rows the task produces would
    // be teaching the wrong lesson.
    const shortcuts: { name: string; why: string; accepted: boolean }[] = [];
    for (const shortcut of renderShortcuts(input)) {
      const outcome = await evaluateTask({ session, task, contracts, patchLuau: shortcut.luau });
      shortcuts.push({ name: shortcut.name, why: shortcut.why, accepted: outcome.accepted });
      line(
        `  shortcut ${shortcut.name.padEnd(20)} ${outcome.accepted ? 'ACCEPTED — the contract is too weak' : 'rejected, as the contract intends'}`,
      );
    }

    // ---- a matched control for the note ------------------------------------
    //
    // "Acceptance went up when we attached the note" is not yet a finding: the
    // note also made the prompt longer, more specific, and more insistent that
    // something needs changing. The arm that separates those is a note of
    // identical shape whose replacement name is worthless — so this one is
    // built from a claim the engine REJECTED earlier in this same run, and the
    // engine is asked again to confirm the name really does not resolve.
    //
    // The note text for this arm therefore carries a false claim on purpose.
    // That is what a placebo is, and it is the only arm where a difference tells
    // you the model is reading the note rather than reacting to its presence.
    const placeboCandidates = [
      ...items
        .filter(entry => !entry.proposal && entry.record.replacement)
        .map(entry => String(entry.record.replacement)),
      `${input.member}Value`,
    ];
    let placeboReplacement: string | null = null;
    for (const candidate of placeboCandidates) {
      if (candidate === input.replacement || candidate === input.member) continue;
      if (await confirmAbsent({ session, className: input.className, member: candidate })) {
        placeboReplacement = candidate;
        break;
      }
    }
    const placeboNote = placeboReplacement
      ? curriculumNote({
          className: input.className,
          member: input.member,
          replacement: placeboReplacement,
          source: { url: spec.url, via: fetched.via },
        })
      : null;
    line(
      placeboReplacement
        ? `  placebo arm points at ${input.className}.${placeboReplacement}, confirmed by the engine not to resolve`
        : '  placebo arm skipped: no name the engine agrees is absent',
    );

    // ---- the arms ----------------------------------------------------------
    line(`  sampling ${String(DRAWS)} draws per arm from ${MODEL}...`);
    const arms = [
      await runArm({ arm: 'without-note', prompt: basePrompt }),
      await runArm({ arm: 'with-note', prompt: `${note}\n\n${basePrompt}` }),
      ...(placeboNote ? [await runArm({ arm: 'placebo-note', prompt: `${placeboNote}\n\n${basePrompt}` })] : []),
    ];

    // Every distinct program is evaluated exactly once, and the verdict is
    // shared by both arms. Two arms that happen to produce the same code do not
    // get two different engine answers, and do not cost two sets of runs.
    const verdicts = new Map<string, { accepted: boolean; reason: string; errored: boolean }>();
    const programs = new Map<string, string>();
    for (const arm of arms) for (const [id, luau] of arm.programs) programs.set(id, luau);

    line(
      `  ${String(programs.size)} distinct programs across ${String(arms.length)} arms; evaluating each in the engine`,
    );
    for (const [id, luau] of programs) {
      const result = await evaluateTask({ session, task, contracts, patchLuau: luau });
      const reason =
        [
          result.gained.length ? `caused ${result.gained.join(',')}` : '',
          result.outstanding.length ? `failed to cause ${result.outstanding.join(',')}` : '',
          result.regressed.length ? `regressed ${result.regressed.join(',')}` : '',
        ]
          .filter(Boolean)
          .join('; ') || 'no effect';
      // A verdict the engine could not produce is not a verdict.
      const errored = result.outcomes.some(outcome => outcome.verdict.error);
      verdicts.set(id, { accepted: result.accepted && !errored, reason, errored });
      if (errored) {
        const detail = result.outcomes.find(outcome => outcome.verdict.error)?.verdict.error ?? '';
        line(`    no verdict for ${id}: ${detail.slice(0, 110)}`);
      }
    }

    for (const arm of arms) {
      arm.accepted = arm.perDraw.filter(id => verdicts.get(id)?.accepted).length;
      arm.unmeasured = arm.perDraw.filter(id => verdicts.get(id)?.errored).length;
    }

    // ---- corpus rows -------------------------------------------------------
    //
    // The prompt stored is the one that actually produced the completion, so a
    // row is a faithful record of the draw rather than a tidied one. Where both
    // arms produced the same program, the row keeps the arm that reached it
    // first and says so.
    const armOf = new Map<string, string>();
    for (const arm of arms) for (const id of arm.programs.keys()) if (!armOf.has(id)) armOf.set(id, arm.arm);

    const claimLabel = `${input.className}.${input.member} -> ${input.className}.${input.replacement}`;
    const candidates: { id: string; luau: string; arm: string; accepted: boolean; reason: string }[] = [
      {
        id: 'reference-migration',
        luau: reference,
        arm: 'reference',
        accepted: referenceResult.accepted,
        reason:
          [
            referenceResult.gained.length ? `caused ${referenceResult.gained.join(',')}` : '',
            referenceResult.outstanding.length ? `failed to cause ${referenceResult.outstanding.join(',')}` : '',
          ]
            .filter(Boolean)
            .join('; ') || 'no effect',
      },
      // Programs the engine never ruled on are left out entirely. An unlabelled
      // row is worse than a missing one: it would become a preference-pair
      // negative on the strength of a network timeout.
      ...[...programs]
        .filter(([id]) => !verdicts.get(id)?.errored)
        .map(([id, luau]) => ({
          id,
          luau,
          arm: armOf.get(id) ?? 'unknown',
          accepted: verdicts.get(id)?.accepted ?? false,
          reason: verdicts.get(id)?.reason ?? 'no verdict',
        })),
    ];

    let added = 0;
    for (const candidate of candidates) {
      const key = `${task.id}::${candidate.id}`;
      if (corpus.has(key)) continue;
      const promptForRow = candidate.arm === 'with-note' ? `${note}\n\n${basePrompt}` : basePrompt;
      const row: CorpusRow = {
        key,
        task: task.id,
        candidate: candidate.id,
        prompt: promptForRow,
        completion: candidate.luau.trim(),
        accepted: candidate.accepted,
        reason: candidate.reason,
        turn,
        at: new Date().toISOString(),
        arm: candidate.arm,
        claim: claimLabel,
      };
      corpus.set(key, row);
      appendFileSync(CORPUS, `${JSON.stringify(row)}\n`, 'utf8');
      added += 1;
    }
    rowsAdded += added;

    const at = new Date().toISOString();
    // A zero-draw arm is a rebuild, not a measurement; recording it would
    // inflate the run count in the pooled report without adding a single draw.
    for (const arm of arms.filter(arm => arm.draws - arm.unmeasured > 0)) {
      appendFileSync(
        ARM_HISTORY,
        `${JSON.stringify({
          at,
          task: task.id,
          model: MODEL,
          arm: arm.arm,
          // Net of draws the engine never ruled on, so pooling across runs does
          // not quietly count a Studio outage as a batch of failures.
          draws: arm.draws - arm.unmeasured,
          code: arm.code,
          accepted: arm.accepted,
        } satisfies ArmRecord)}\n`,
        'utf8',
      );
    }

    line();
    line(`  ${task.id}  (this run)`);
    line('    arm            draws  answered  code  unmeasured  distinct  accepted');
    for (const arm of arms) {
      const answered = arm.draws - arm.failed - arm.truncated;
      line(
        `    ${arm.arm.padEnd(14)} ${String(arm.draws).padStart(5)} ${String(answered).padStart(9)} ` +
          `${String(arm.code).padStart(5)} ${String(arm.unmeasured).padStart(11)} ` +
          `${String(arm.distinct).padStart(9)} ${String(arm.accepted).padStart(9)}`,
      );
    }
    line(`    +${String(added)} corpus rows`);

    measurements.push({
      task: task.id,
      claim: claimLabel,
      source: { url: spec.url, via: fetched.via, fetchedAt: fetched.fetchedAt },
      engineEvidence: item.detail,
      referenceMigrationAccepted: referenceResult.accepted,
      shortcutsRejected: shortcuts,
      model: MODEL,
      arms: arms.map(arm => ({
        arm: arm.arm,
        draws: arm.draws,
        failed: arm.failed,
        truncated: arm.truncated,
        notCode: arm.notCode,
        code: arm.code,
        unmeasured: arm.unmeasured,
        distinct: arm.distinct,
        accepted: arm.accepted,
        acceptancePerDraw:
          arm.draws - arm.unmeasured > 0 ? arm.accepted / (arm.draws - arm.unmeasured) : 0,
        acceptancePerCodeDraw:
          arm.code - arm.unmeasured > 0 ? arm.accepted / (arm.code - arm.unmeasured) : 0,
      })),
      corpusRowsAdded: added,
    });
  }

  await session.cleanup();
  await session.close();

  const rows = [...corpus.values()];
  const counts = rebuild(rows);
  const generatedIds = new Set(buildable.map(entry => entry.input.id));
  const fromScrape = rows.filter(row => generatedIds.has(row.task));

  // ---- pooled over every run ever recorded --------------------------------
  const history = readArmHistory();
  const pooled: {
    task: string;
    withNote: { draws: number; accepted: number };
    withoutNote: { draws: number; accepted: number };
    placebo: { draws: number; accepted: number } | null;
    runs: number;
    lift: number;
    fisherP: number;
    /** with-note against the placebo: is the note being read, or just noticed? */
    placeboLift: number | null;
    placeboFisherP: number | null;
  }[] = [];

  for (const taskId of new Set(history.map(record => record.task))) {
    const forTask = history.filter(record => record.task === taskId);
    const sum = (arm: string): { draws: number; accepted: number } =>
      forTask
        .filter(record => record.arm === arm)
        .reduce(
          (total, record) => ({
            draws: total.draws + record.draws,
            accepted: total.accepted + record.accepted,
          }),
          { draws: 0, accepted: 0 },
        );
    const withNote = sum('with-note');
    const withoutNote = sum('without-note');
    const placeboArm = sum('placebo-note');
    if (withNote.draws === 0 || withoutNote.draws === 0) continue;
    const placebo = placeboArm.draws > 0 ? placeboArm : null;
    pooled.push({
      task: taskId,
      withNote,
      withoutNote,
      placebo,
      runs: forTask.filter(record => record.arm === 'with-note').length,
      lift: withNote.accepted / withNote.draws - withoutNote.accepted / withoutNote.draws,
      fisherP: fisherExact(
        withNote.accepted,
        withNote.draws - withNote.accepted,
        withoutNote.accepted,
        withoutNote.draws - withoutNote.accepted,
      ),
      // Against the placebo rather than against nothing. If the note were only
      // making the prompt longer and more urgent, a note with a worthless
      // replacement name would do just as well as the real one.
      placeboLift: placebo ? withNote.accepted / withNote.draws - placebo.accepted / placebo.draws : null,
      placeboFisherP: placebo
        ? fisherExact(
            withNote.accepted,
            withNote.draws - withNote.accepted,
            placebo.accepted,
            placebo.draws - placebo.accepted,
          )
        : null,
    });
  }

  if (pooled.length > 0) {
    line();
    line('  does the scraped note change what the model produces? (pooled over every run)');
    for (const entry of pooled) {
      line(`    ${entry.task}  over ${String(entry.runs)} run(s)`);
      const shown: [string, { draws: number; accepted: number }][] = [
        ['with-note', entry.withNote],
        ['without-note', entry.withoutNote],
        ...(entry.placebo ? ([['placebo-note', entry.placebo]] as [string, { draws: number; accepted: number }][]) : []),
      ];
      for (const [name, arm] of shown) {
        line(
          `      ${name.padEnd(13)} ${String(arm.accepted).padStart(3)}/${String(arm.draws).padEnd(3)} accepted` +
            `  (${(100 * (arm.accepted / arm.draws)).toFixed(1)}%)`,
        );
      }
      line(
        `      note vs none:    ${(100 * entry.lift).toFixed(1)} points,` +
          ` two-sided Fisher exact p = ${formatP(entry.fisherP)}`,
      );
      if (entry.placeboLift !== null && entry.placeboFisherP !== null) {
        line(
          `      note vs placebo: ${(100 * entry.placeboLift).toFixed(1)} points,` +
            ` two-sided Fisher exact p = ${formatP(entry.placeboFisherP)}`,
        );
      }
    }
  }

  writeFileSync(
    MEASUREMENT,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        fetch: { url: spec.url, via: fetched.via, at: fetched.fetchedAt, specRevision: spec.revision },
        claimsScraped: items.length,
        claimsConfirmedByEngine: confirmed.length,
        claimsBuildable: buildable.length,
        rejected: items
          .filter(entry => !entry.proposal)
          .map(entry => ({
            claim: `${String(entry.record.class_name)}.${String(entry.record.member)} -> ${String(entry.record.replacement)}`,
            verdict: entry.verdict,
            detail: entry.detail,
          })),
        droppedAsUnbuildable: unbuildable.map(entry => ({
          claim: `${String(entry.item.record.class_name)}.${String(entry.item.record.member)}`,
          detail: entry.separability.detail,
          // What the engine actually read back, so a refusal can be checked
          // rather than taken on the pipeline's word.
          readback: entry.separability.readback,
        })),
        tasks: measurements,
        pooledAcrossRuns: pooled,
        corpus: { before: corpusBefore, after: corpus.size, fromScrapedClaims: fromScrape.length },
        rebuilt: { sft: counts.sft, dpo: counts.dpo },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const acceptedFromScrape = fromScrape.filter(row => row.accepted).length;
  line();
  line(`  ${String(confirmed.length)}/${String(items.length)} scraped claims survived the engine`);
  line(`  ${String(buildable.length)}/${String(confirmed.length)} of those could be built into a task`);
  line(`  corpus ${String(corpusBefore)} -> ${String(corpus.size)} rows (+${String(rowsAdded)} this run)`);
  line(`  ${String(fromScrape.length)} corpus rows now come from scraped claims, ${String(acceptedFromScrape)} of them accepted`);
  line(`  rebuilt sft ${String(counts.sft)} rows, dpo ${String(counts.dpo)} pairs`);
  line(`  measurement written to ${MEASUREMENT.replace(ROOT, '.')}`);
  line();
  line('  Studio is left with no sandbox; run `npm run playable` to re-stage the demo world.');
  line();
}

// Only when run directly. The statistics below are reported in the submission,
// so they are unit-tested — and a test that imported this module would
// otherwise start a Studio session and a sampling run just by importing it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
