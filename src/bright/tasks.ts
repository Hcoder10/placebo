import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StudioSession } from '../verifier/studio.js';
import type { CurriculumItem } from './curriculum.js';

/**
 * Turning a surviving scraped claim into an engine-verified training task.
 *
 * `curriculum.ts` gets as far as a confirmed claim: the engine agrees that
 * `Class.Member` and `Class.Replacement` both resolve. That is a fact about the
 * engine, and on its own it trains nothing — it is a line in a jsonl file.
 *
 * This module is the step that makes the claim do work. A confirmed deprecation
 * is a *repair task generator*: build a world where the deprecated member is
 * what the current implementation reads, write a behavioural contract that the
 * deprecated read cannot satisfy, and the only way to pass is to use the member
 * the claim points at. The task then goes through exactly the same machinery as
 * a hand-authored one — sampled candidates, engine adjudication,
 * accepted/rejected rows — so a scraped fact ends up in `corpus.jsonl` with the
 * same provenance as everything else.
 *
 * The division of labour is unchanged and is the whole point: the web says
 * *what to work on*, the engine says *what is true*. Every constant this module
 * bakes into a generated world is measured in Studio first
 * (`probeSeparability`), and a claim the engine cannot build a world for
 * produces no task rather than a task resting on an assumption.
 */

/** One subject in a generated world, and what it is seeded with. */
export interface Seed {
  /** Instance name inside the sandbox. */
  subject: string;
  /** Readout wall that displays this subject. */
  readout: string;
  /** Value the deprecated member holds. Also the readout's starting value. */
  low: number;
  /** Value the replacement member holds. */
  high: number;
}

/**
 * Two subjects, seeded differently on purpose.
 *
 * The generated contract states its requirement as a *delta* (`+75`), never as
 * an absolute, and the model never sees the setup. That leaves two ways to pass
 * without reading the member, and they are closed differently.
 *
 * A pair of hardcoded absolutes would work — if they could be found. They are
 * not in the prompt: the requirement quotes deltas, the baseline quotes no
 * numbers, and the setup is never shown, so a patch would have to guess two
 * unrelated values and be right about both. Two subjects rather than one is
 * what makes a single lucky guess insufficient.
 *
 * A hardcoded increment (`current + 75`) is closed by measurement instead: it
 * satisfies realization 1 and overshoots when the signal is fired twice, and
 * the verifier requires every realization.
 */
export const DEFAULT_SEEDS: readonly Seed[] = [
  { subject: 'SubjectA', readout: 'ReadoutA', low: 25, high: 100 },
  { subject: 'SubjectB', readout: 'ReadoutB', low: 40, high: 90 },
] as const;

/** Which member has to be written first for both to keep distinct values. */
export type AssignmentOrder = 'replacement-first' | 'deprecated-first';

export interface Separability {
  /** True when the engine held both members at different values at once. */
  separable: boolean;
  /** The order that worked, or null when neither did. */
  order: AssignmentOrder | null;
  /** One line saying what the engine actually observed. */
  detail: string;
  /** Per-seed readback, so a refusal can be inspected rather than trusted. */
  readback: { subject: string; wantLow: number; gotLow: unknown; wantHigh: number; gotHigh: unknown }[];
}

/**
 * Asks the engine whether a migration task is *constructible* for this claim.
 *
 * `curriculum.ts` established that both members resolve. That is not enough to
 * build a task from: a task needs a world in which reading the deprecated member
 * gives a visibly different answer from reading the replacement, and whether the
 * engine permits that is an empirical question. `Humanoid.MaxHealth` clamps
 * `Humanoid.Health`, so the assignment order decides whether the two end up
 * distinct or identical — and a generator that assumed an order would silently
 * emit a task whose contract the deprecated implementation already satisfies.
 *
 * So the order is measured, both ways, and a claim that separates under neither
 * yields no task at all.
 */
export async function probeSeparability(params: {
  session: StudioSession;
  className: string;
  member: string;
  replacement: string;
  seeds?: readonly Seed[];
}): Promise<Separability> {
  const { session, className, member, replacement } = params;
  const seeds = params.seeds ?? DEFAULT_SEEDS;
  const seedJson = JSON.stringify(
    JSON.stringify(seeds.map(seed => ({ subject: seed.subject, low: seed.low, high: seed.high }))),
  );

  const raw = await session.luau(`
local HttpService = game:GetService("HttpService")
local className, deprecated, replacement = ${JSON.stringify(className)}, ${JSON.stringify(member)}, ${JSON.stringify(replacement)}
local seeds = HttpService:JSONDecode(${seedJson})

-- Only a disposable instance is acceptable here. A service is a singleton owned
-- by the running DataModel, and seeding one to probe a scraped claim would
-- mutate the place the demo is staged in.
local ok, probe = pcall(function() return Instance.new(className) end)
if not ok or not probe then
	return HttpService:JSONEncode({ instantiable = false })
end

local function attempt(order, low, high)
	local first, firstValue, second, secondValue
	if order == "replacement-first" then
		first, firstValue, second, secondValue = replacement, high, deprecated, low
	else
		first, firstValue, second, secondValue = deprecated, low, replacement, high
	end
	pcall(function() probe[first] = firstValue end)
	pcall(function() probe[second] = secondValue end)
	local okLow, gotLow = pcall(function() return probe[deprecated] end)
	local okHigh, gotHigh = pcall(function() return probe[replacement] end)
	return {
		gotLow = okLow and gotLow or nil,
		gotHigh = okHigh and gotHigh or nil,
		held = okLow and okHigh and gotLow == low and gotHigh == high,
	}
end

local out = { instantiable = true, orders = {} }
for _, order in { "replacement-first", "deprecated-first" } do
	local rows, allHeld = {}, true
	for _, seed in seeds do
		local result = attempt(order, seed.low, seed.high)
		allHeld = allHeld and result.held
		table.insert(rows, {
			subject = seed.subject,
			wantLow = seed.low,
			gotLow = result.gotLow,
			wantHigh = seed.high,
			gotHigh = result.gotHigh,
		})
	end
	table.insert(out.orders, { order = order, held = allHeld, rows = rows })
end

probe:Destroy()
return HttpService:JSONEncode(out)
`);

  const parsed =
    typeof raw === 'string'
      ? (JSON.parse(raw) as {
          instantiable: boolean;
          orders?: { order: AssignmentOrder; held: boolean; rows: Separability['readback'] }[];
        })
      : { instantiable: false };

  if (!parsed.instantiable) {
    return {
      separable: false,
      order: null,
      detail: `${className} cannot be built with Instance.new, so there is no disposable subject to seed`,
      readback: [],
    };
  }

  const orders = parsed.orders ?? [];
  const winner = orders.find(entry => entry.held);
  if (!winner) {
    return {
      separable: false,
      order: null,
      detail: `${className}.${member} and ${className}.${replacement} could not hold different values at once in either assignment order`,
      readback: orders[0]?.rows ?? [],
    };
  }

  return {
    separable: true,
    order: winner.order,
    detail: `${className}.${member} and ${className}.${replacement} held distinct values simultaneously (${winner.order})`,
    readback: winner.rows,
  };
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .trim()
    .split('\n')
    .map(line => (line.trim() ? pad + line : ''))
    .join('\n');
}

export interface GeneratorInput {
  className: string;
  member: string;
  replacement: string;
  /** The proposal id from the curriculum item; becomes the task and contract id. */
  id: string;
  order: AssignmentOrder;
  seeds?: readonly Seed[];
  /** Where the claim came from, recorded in the generated file's header. */
  source: { url: string; via: string; fetchedAt: string; evidence: string };
}

function seedsOf(input: GeneratorInput): readonly Seed[] {
  return input.seeds ?? DEFAULT_SEEDS;
}

/** Local variable name for an instance, e.g. `SubjectA` -> `subjectA`. */
function local(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * The Luau that builds the world both the task and its contract run against.
 *
 * Not exported: the task and the contract must be emitted from the same source
 * or they drift, and the only way to guarantee that is for there to be one
 * caller path rather than an API anyone can reach around.
 */
function renderSetup(input: GeneratorInput): string {
  const assignments = (seed: Seed): string =>
    input.order === 'replacement-first'
      ? `${local(seed.subject)}.${input.replacement} = ${String(seed.high)}\n${local(seed.subject)}.${input.member} = ${String(seed.low)}`
      : `${local(seed.subject)}.${input.member} = ${String(seed.low)}\n${local(seed.subject)}.${input.replacement} = ${String(seed.high)}`;

  const [firstWritten, secondWritten] =
    input.order === 'replacement-first'
      ? [input.replacement, input.member]
      : [input.member, input.replacement];

  const subjects = seedsOf(input)
    .map(
      (seed, index) => `local ${local(seed.subject)} = Instance.new("${input.className}")
${local(seed.subject)}.Name = "${seed.subject}"
${local(seed.subject)}.Parent = sandbox
${assignments(seed)}

local ${local(seed.readout)} = kit.tint(kit.wall(sandbox, ${String(-9 + index * 18)}, 0, -14, 6, "x", "${seed.readout}"), "${index === 0 ? 'cream' : 'slate'}")
${local(seed.readout)}:SetAttribute("Value", ${String(seed.low)})`,
    )
    .join('\n\n');

  return `kit.scene()
kit.ground(sandbox, 110)

kit.platform(sandbox, 0, 0, 0, 24, 18, "Deck")
kit.spawn(sandbox, 0, 0, -10, "Spawn")
kit.decor(sandbox, -16, 0, 6, "crystal", "Crystal")
kit.decor(sandbox, 16, 0, 6, "bush", "Bush")

-- The subjects, seeded in the order the engine was measured to accept:
-- ${input.className}.${firstWritten} first, then ${input.className}.${secondWritten}. probeSeparability
-- found this is the order under which both members keep distinct values; the
-- other one collapses them onto the same number.
--
-- Each readout starts at the value the DEPRECATED member holds, which is what
-- makes the required change a delta nothing in the prompt gives away: the model
-- never sees this block, so it cannot learn the absolute a readout has to reach.
${subjects}

local spare = kit.tint(kit.wall(sandbox, 0, 0, 16, 6, "z", "SpareReadout"), "slate")
spare:SetAttribute("Value", 0)

-- Studio's edit mode runs no physics, so the mechanic is driven by an explicit
-- server-authoritative event rather than a physical Touched. The causal
-- structure is identical: something fires, and the world is supposed to move
-- because of it.
local refill = Instance.new("BindableEvent")
refill.Name = "Refill"
refill.Parent = sandbox

-- Built here rather than inside the control, so the control differs from the
-- treatment in the interaction alone and not in the world's structure.
local decoy = Instance.new("BindableEvent")
decoy.Name = "Decoy"
decoy.Parent = sandbox`;
}

/** The handler body shared by the baseline and the reference migration. */
function renderHandler(input: GeneratorInput, memberRead: string): string {
  const locals = seedsOf(input)
    .map(
      seed =>
        `local ${local(seed.subject)} = sandbox.${seed.subject}\nlocal ${local(seed.readout)} = sandbox.${seed.readout}`,
    )
    .join('\n');
  const writes = seedsOf(input)
    .map(seed => `  ${local(seed.readout)}:SetAttribute("Value", ${local(seed.subject)}.${memberRead})`)
    .join('\n');

  return `${locals}

sandbox.Refill.Event:Connect(function()
${writes}
end)`;
}

/** The implementation the task starts from: correct wiring, deprecated read. */
export function renderBaseline(input: GeneratorInput): string {
  return renderHandler(input, input.member);
}

/**
 * The implementation the claim itself proposes.
 *
 * Kept so the pipeline can put the scraped claim's own suggestion through the
 * verifier rather than assuming it works. A confirmed claim whose reference
 * migration the engine then rejects is worth knowing about, and there is no way
 * to find out except by running it.
 */
export function renderReferenceMigration(input: GeneratorInput): string {
  return renderHandler(input, input.replacement);
}

/**
 * Patches the generated contract has to reject, generated alongside it.
 *
 * The contract's two defences — hidden absolutes and repeated realizations —
 * are claims about what it will refuse, and a claim about a verifier is worth
 * exactly as much as a run of the verifier. So the two shortcuts are emitted as
 * code and put through the engine every time the task is built. They are
 * deliberately not written into the corpus: they measure the contract, not the
 * model, and hand-authored negatives are the wrong shape for preference data.
 */
export function renderShortcuts(input: GeneratorInput): { name: string; why: string; luau: string }[] {
  const seeds = seedsOf(input);
  const locals = seeds
    .map(
      seed =>
        `local ${local(seed.readout)} = sandbox.${seed.readout}`,
    )
    .join('\n');

  const increments = seeds
    .map(
      seed =>
        `  ${local(seed.readout)}:SetAttribute("Value", (${local(seed.readout)}:GetAttribute("Value") or 0) + ${String(seed.high - seed.low)})`,
    )
    .join('\n');

  const presets = seeds
    .map(seed => `${local(seed.readout)}:SetAttribute("Value", ${String(seed.high)})`)
    .join('\n');

  return [
    {
      name: 'hardcoded-increment',
      why: 'adds the delta the requirement quotes instead of reading the member; correct once, wrong when the signal repeats',
      luau: `${locals}

sandbox.Refill.Event:Connect(function()
${increments}
end)`,
    },
    {
      name: 'preset-at-startup',
      why: 'writes the right final values without the interaction causing them',
      luau: `${locals}

${presets}`,
    },
  ];
}

export function renderContract(input: GeneratorInput): string {
  const deltas = seedsOf(input).map(seed => ({ ...seed, delta: seed.high - seed.low }));

  const requirement = `When the refill signal fires, every readout must show the value its subject
carries on the member that ${input.className}.${input.member} was superseded by, rather than the one it
carries on ${input.className}.${input.member} itself: ${deltas
    .map(seed => `${seed.readout} rises by exactly ${String(seed.delta)}`)
    .join(', ')}. Firing the signal
again changes nothing further. A run with no signal changes nothing, an
unrelated signal changes nothing, and the spare readout never moves.`;

  return `# GENERATED from a scraped claim that survived engine adjudication.
#
# Source:   ${input.source.url}
#           fetched via ${input.source.via} at ${input.source.fetchedAt}
# Claim:    ${input.className}.${input.member} is deprecated in favour of ${input.className}.${input.replacement}
# Engine:   ${input.source.evidence}
#           ${input.order} assignment keeps the two members distinct
#
# The web supplied the claim. Everything asserted below about the engine was
# measured in it (src/bright/tasks.ts, probeSeparability), and the verdict on
# any implementation is the verifier's, not this file's.
#
# Regenerate with:  npx tsx src/train/curriculum_train.ts
id: ${input.id}
requirement: >-
${indent(requirement, 2)}

setup: |
${indent(renderSetup(input), 2)}

# Fire once per realization. The required effects are idempotent writes, so a
# correct implementation moves each readout by the same delta however many times
# the signal arrives — while an implementation that hardcodes the delta as an
# increment overshoots on the second firing and is rejected.
treatment: |
  for _ = 1, REALIZATION do
    sandbox.Refill:Fire()
  end

controls:
  - name: no_refill
    steps: |
      -- deliberately empty: same world, same elapsed setup, no interaction

  # A real but irrelevant signal, so "did nothing" is distinguishable from
  # "responds to anything at all".
  - name: unrelated_signal
    steps: |
      for _ = 1, REALIZATION do
        sandbox.Decoy:Fire()
      end

effects:
${deltas.map(seed => `  - key: "${seed.readout}.@Value"\n    change: "+${String(seed.delta)}"`).join('\n')}

non_effects:
  - "SpareReadout.@Value"

# Repetitions of the interaction, not variations of the world. A handler that
# sets the readout is idempotent under all three; one that increments is not.
realizations: [1, 2, 3]
`;
}

export function renderTask(input: GeneratorInput, contractRelativePath: string): string {
  const goal = `The refill handler runs, but the readouts never move: it reads
${input.className}.${input.member}, which the deprecation feed reports as superseded, and that is
already the value each readout shows. Rewrite the handler to read the member
that replaced it, so every readout shows its subject's rated capacity instead.
Change nothing else.`;

  return `# GENERATED from a scraped claim that survived engine adjudication.
#
# Source:   ${input.source.url}
#           fetched via ${input.source.via} at ${input.source.fetchedAt}
# Claim:    ${input.className}.${input.member} is deprecated in favour of ${input.className}.${input.replacement}
# Engine:   ${input.source.evidence}
#
# Regenerate with:  npx tsx src/train/curriculum_train.ts
id: ${input.id}
mode: repair
goal: >-
${indent(goal, 2)}

# Byte-identical to the setup in the generated contract, because a task
# overrides its contracts' setup and the two drifting apart would mean the
# contract said one thing standalone and another inside the task. Both come from
# renderSetup, so they cannot drift.
setup: |
${indent(renderSetup(input), 2)}

# The defective implementation: wired correctly, reading the wrong member. That
# is the shape a deprecation actually leaves behind in a codebase.
baseline: |
${indent(renderBaseline(input), 2)}

contracts:
  - ${contractRelativePath}

already_satisfied: []
`;
}

/**
 * The scraped claim, worded the way it is handed to the model.
 *
 * It claims exactly as much as was established and no more. The engine
 * confirmed that both members resolve; it did not, and cannot, confirm that the
 * deprecation is real — that part is the page's word. Overstating it here would
 * put a web assertion into the prompt wearing the engine's authority.
 */
export function curriculumNote(params: {
  className: string;
  member: string;
  replacement: string;
  source: { url: string; via: string };
}): string {
  return [
    `Current API notes, scraped from ${params.source.url} (fetched via ${params.source.via}).`,
    `The engine was asked about each line and confirms both members exist on the class.`,
    `It cannot confirm the deprecation itself — that is the page's claim, not a measurement.`,
    ``,
    `  - ${params.className}.${params.member} is reported deprecated; the replacement is ${params.className}.${params.replacement}.`,
  ].join('\n');
}

/**
 * Asks the engine to confirm a member does NOT resolve on a class.
 *
 * Used to build the placebo arm: a note is only a control if what it points at
 * is genuinely useless, and "genuinely useless" is a measurement like any other.
 * A fabricated member that turned out to exist would quietly become a second
 * treatment arm.
 */
export async function confirmAbsent(params: {
  session: StudioSession;
  className: string;
  member: string;
}): Promise<boolean> {
  const raw = await params.session.luau(`
local HttpService = game:GetService("HttpService")
local ok, probe = pcall(function() return Instance.new(${JSON.stringify(params.className)}) end)
if not ok or not probe then return HttpService:JSONEncode({ resolves = false, built = false }) end
local resolved, value = pcall(function() return probe[${JSON.stringify(params.member)}] end)
probe:Destroy()
return HttpService:JSONEncode({ built = true, resolves = resolved and value ~= nil })
`);
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as { built: boolean; resolves: boolean }) : null;
  return parsed?.built === true && parsed.resolves === false;
}

export interface GeneratedTask {
  id: string;
  taskPath: string;
  contractPath: string;
}

/** Writes the generated task and contract to disk and returns their paths. */
export function writeGeneratedTask(root: string, input: GeneratorInput): GeneratedTask {
  const taskDir = join(root, 'tasks', 'generated');
  const contractDir = join(root, 'contracts', 'generated');
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(contractDir, { recursive: true });

  const contractPath = join(contractDir, `${input.id}.yaml`);
  const taskPath = join(taskDir, `${input.id}.yaml`);

  writeFileSync(contractPath, renderContract(input), 'utf8');
  writeFileSync(taskPath, renderTask(input, `../../contracts/generated/${input.id}.yaml`), 'utf8');

  return { id: input.id, taskPath, contractPath };
}

/** The generator input a confirmed curriculum item plus a separability probe imply. */
export function generatorInputFor(params: {
  item: CurriculumItem;
  separability: Separability;
  source: { url: string; via: string; fetchedAt: string };
}): GeneratorInput | null {
  const { item, separability, source } = params;
  if (!item.proposal || !separability.separable || !separability.order) return null;

  const className = item.record.class_name ?? '';
  const member = item.record.member ?? '';
  const replacement = item.record.replacement ?? '';
  if (!className || !member || !replacement) return null;

  return {
    className,
    member,
    replacement,
    id: item.proposal.id,
    order: separability.order,
    source: { ...source, evidence: item.detail },
  };
}
