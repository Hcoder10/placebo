import { z } from 'zod';

import {
  DEFAULT_PART_MATERIAL,
  DEFAULT_PART_RGB,
  DEFAULT_PART_SIZE,
  GRID_STUDS,
  PALETTE_TOLERANCE_RGB,
  isOnGrid,
  nearestPaletteEntry,
  rgbDistance,
  snapToGrid,
  type KitRole,
} from './kit.js';
import { SANDBOX, type StudioSession } from './studio.js';
import { rootExpression } from './worldstate.js';

/**
 * Verifying what a built world looks like, mechanically.
 *
 * `effect.ts` decides whether a mechanic does what it claims by measuring what
 * the code causes. This does the same job for appearance. It does not ask a
 * model whether a scene is attractive — a judge model grading a builder model
 * is the failure this project exists to avoid — it measures properties that a
 * bad-looking scene provably has and a good-looking one provably does not:
 *
 *   palette adherence      a colour nobody chose is the signature of a default
 *   untouched defaults     Plastic + medium stone grey is `Instance.new("Part")`
 *   grid alignment         geometry that lines up reads as designed
 *   size sanity            degenerate and absurd parts are always bugs
 *   interpenetration       a pickup inside a wall is broken, not stylised
 *   variety                one colour and one size is a grey box by definition
 *   lighting               Roblox's default lighting is flat and everyone knows it
 *
 * None of these says "this is beautiful". Together they say "a person made
 * choices here", which is the difference the harness can actually enforce, and
 * every finding names an instance, what was seen, what was expected and the one
 * call that repairs it — so the report can be handed straight back to the agent
 * as work rather than as a grade.
 *
 * `kit.ts` is what makes several of these checkable at all. Because every kit
 * instance carries a `KitRole` attribute, the interpenetration check can hold a
 * coin to a stricter standard than a pillar: a coin inside a platform cannot be
 * collected, whereas a pillar resting on one is simply a pillar.
 */

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
const Mat3Schema = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
]);

/** One part as the inspection program reports it. Colours arrive in 0-1. */
export const PartRecordSchema = z.object({
  path: z.string(),
  class: z.string(),
  color: Vec3Schema,
  material: z.string(),
  size: Vec3Schema,
  pos: Vec3Schema,
  /** Row-major rotation from the part's CFrame, for a world-space bounding box. */
  rot: Mat3Schema,
  transparency: z.number(),
  collide: z.boolean(),
  role: z.string().optional(),
});

export const LightingRecordSchema = z.object({
  atmosphere: z.boolean(),
  brightness: z.number(),
  clockTime: z.number(),
});

export type PartRecord = z.infer<typeof PartRecordSchema>;
export type LightingRecord = z.infer<typeof LightingRecordSchema>;

export type DesignCheckName =
  | 'palette_adherence'
  | 'default_material_tell'
  | 'grid_alignment'
  | 'size_sanity'
  | 'no_interpenetration'
  | 'variety'
  | 'scene_lighting';

export interface DesignFinding {
  check: DesignCheckName;
  /** Path under the root, e.g. `Coin` or `Room/Door`. */
  instance: string;
  observed: string;
  expected: string;
  /** The single change that repairs it, phrased as something to run. */
  fix: string;
}

export interface DesignCheck {
  name: DesignCheckName;
  pass: boolean;
  /** How many instances this check actually applied to. */
  inspected: number;
  findings: DesignFinding[];
  /** Findings past the cap, dropped so a report stays feedable to a model. */
  omitted: number;
  /** What the check means, so the report explains itself without this file. */
  note: string;
}

export interface DesignStats {
  /** Distinct palette buckets in use, ignoring the bootstrap ground plane. */
  distinctColors: number;
  distinctSizes: number;
  /**
   * Distinct part-top heights, rounded to a stud.
   *
   * Reported, not gated. A deliberately flat layout is a legitimate design, so
   * failing a build for it would be noise — but a builder reading the report
   * can see at a glance that its world is a floor plan.
   */
  distinctHeights: number;
}

export interface DesignReport {
  root: string;
  parts: number;
  /** Parts carrying a `KitRole`: how much of the world came from the substrate. */
  kitParts: number;
  /** Parts built by hand. Not a failure on its own, but it predicts the others. */
  handRolled: number;
  stats: DesignStats;
  checks: DesignCheck[];
  passed: boolean;
}

/** Beyond this a report stops being feedback and starts being a wall of text. */
export const MAX_FINDINGS_PER_CHECK = 12;

/** Roblox's own floor for a part dimension is 0.05; below this nothing reads. */
export const MIN_PART_STUDS = 0.2;
/** Larger than any object in a small game; a mistyped coordinate, not a design. */
export const MAX_PART_STUDS = 512;
/** A part this much longer than it is thin is a sliver, not a shape. */
export const MAX_ASPECT_RATIO = 200;

/** Faces that merely touch must not read as interpenetration. */
export const OVERLAP_TOLERANCE_STUDS = 0.05;
/** Shared volume, as a fraction of the smaller part, before it reads as broken. */
export const OVERLAP_FRACTION = 0.15;
/**
 * Pickups get a stricter bound.
 *
 * A platform clipping a wall is untidy. A coin 5% inside a platform is a
 * mechanic the player cannot reach, which is a different class of problem.
 */
export const OVERLAP_FRACTION_PICKUP = 0.05;
// `satisfies` rather than a bare array: if a role is ever renamed in kit.ts,
// this stops compiling instead of quietly downgrading coins to scenery.
const PICKUP_ROLES = new Set<string>(['coin', 'spawn'] satisfies KitRole[]);
/** The floor. Excluded from overlap and variety, for the reasons given below. */
const GROUND_ROLE: KitRole = 'ground';

/** Below this a scene is too small for variety to mean anything. */
export const VARIETY_MIN_PARTS = 5;

/** A part this transparent is a trigger volume; its colour is not a design choice. */
const INVISIBLE_TRANSPARENCY = 0.95;

export interface Aabb {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * World-space bounding box of a part.
 *
 * For a rotated part this is the tight axis-aligned box around the oriented
 * one, which is exact as a bounding box and conservative as a stand-in for the
 * part's actual volume. That conservatism is in the safe direction here: it can
 * only make the overlap check report a smaller fraction of a larger box, never
 * invent an overlap between parts that do not share space.
 */
export function worldAabb(part: Pick<PartRecord, 'size' | 'pos' | 'rot'>): Aabb {
  const [sx, sy, sz] = part.size;
  const [px, py, pz] = part.pos;
  const r = part.rot;
  const hx = 0.5 * (Math.abs(r[0]) * sx + Math.abs(r[1]) * sy + Math.abs(r[2]) * sz);
  const hy = 0.5 * (Math.abs(r[3]) * sx + Math.abs(r[4]) * sy + Math.abs(r[5]) * sz);
  const hz = 0.5 * (Math.abs(r[6]) * sx + Math.abs(r[7]) * sy + Math.abs(r[8]) * sz);
  return { min: [px - hx, py - hy, pz - hz], max: [px + hx, py + hy, pz + hz] };
}

function boxVolume(box: Aabb): number {
  return (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2]);
}

function axisOverlap(a: Aabb, b: Aabb, axis: 0 | 1 | 2): number {
  return Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]);
}

/**
 * Shared volume as a fraction of the smaller box, or 0 when they only touch.
 *
 * The tolerance is taken off every axis before the volume is computed, so two
 * parts sitting flush — a pillar on a platform, a wall on a floor — score zero
 * rather than a sliver of overlap that would flood the report.
 */
export function overlapFraction(a: Aabb, b: Aabb, tolerance = OVERLAP_TOLERANCE_STUDS): number {
  const ox = axisOverlap(a, b, 0) - tolerance;
  const oy = axisOverlap(a, b, 1) - tolerance;
  const oz = axisOverlap(a, b, 2) - tolerance;
  if (ox <= 0 || oy <= 0 || oz <= 0) return 0;
  const smaller = Math.min(boxVolume(a), boxVolume(b));
  if (smaller <= 0) return 0;
  return (ox * oy * oz) / smaller;
}

/** 0-1 Color3 components as the 0-255 the palette is written in. */
export function toRgb255(color: readonly [number, number, number]): [number, number, number] {
  return [Math.round(color[0] * 255), Math.round(color[1] * 255), Math.round(color[2] * 255)];
}

/** How the agent would refer to this instance in Luau, for the repair hint. */
function luauPath(path: string): string {
  return `sandbox.${path.split('/').join('.')}`;
}

function trim(findings: DesignFinding[]): { findings: DesignFinding[]; omitted: number } {
  if (findings.length <= MAX_FINDINGS_PER_CHECK) return { findings, omitted: 0 };
  return {
    findings: findings.slice(0, MAX_FINDINGS_PER_CHECK),
    omitted: findings.length - MAX_FINDINGS_PER_CHECK,
  };
}

function check(
  name: DesignCheckName,
  note: string,
  inspected: number,
  raw: DesignFinding[],
): DesignCheck {
  const { findings, omitted } = trim(raw);
  return { name, pass: raw.length === 0, inspected, findings, omitted, note };
}

/** Roles whose colour and shape are a styling choice rather than a fixture. */
function isStyled(part: PartRecord): boolean {
  return part.transparency < INVISIBLE_TRANSPARENCY;
}

function fmt(values: readonly number[]): string {
  return values.map(value => (Number.isInteger(value) ? String(value) : value.toFixed(2))).join(', ');
}

/**
 * The whole analysis, over records rather than over a live session.
 *
 * Keeping it pure is what makes it testable without a Studio attached, and it
 * is also what makes the checks arguable: every one of them is a function of a
 * list of parts, so a disputed finding can be reproduced from the record.
 */
export function analyzeParts(params: {
  root: string;
  parts: PartRecord[];
  lighting: LightingRecord;
}): DesignReport {
  const { root, parts, lighting } = params;
  const styled = parts.filter(isStyled);

  // -- palette adherence -----------------------------------------------------
  const paletteFindings: DesignFinding[] = [];
  for (const part of styled) {
    const rgb = toRgb255(part.color);
    const { entry, distance } = nearestPaletteEntry(rgb);
    if (distance <= PALETTE_TOLERANCE_RGB) continue;
    paletteFindings.push({
      check: 'palette_adherence',
      instance: part.path,
      observed: `Color3.fromRGB(${rgb.join(', ')}) in ${part.material}`,
      expected: `one of the kit palette (nearest is ${entry.name}, ${String(Math.round(distance))} off)`,
      fix: `kit.tint(${luauPath(part.path)}, "${entry.name}")`,
    });
  }

  // -- the untouched default -------------------------------------------------
  //
  // The highest-signal check here, and the cheapest. Medium stone grey in
  // Plastic is not a colour anyone picks; it is what an instance looks like
  // when nobody touched it. The default 4x1x2 size is quoted as corroboration
  // when it is also present.
  const defaultFindings: DesignFinding[] = [];
  for (const part of styled) {
    const rgb = toRgb255(part.color);
    const greyed = rgbDistance(rgb, DEFAULT_PART_RGB) <= PALETTE_TOLERANCE_RGB;
    const plastic = part.material === DEFAULT_PART_MATERIAL;
    if (!plastic) continue;
    const defaultSized =
      part.size[0] === DEFAULT_PART_SIZE[0] &&
      part.size[1] === DEFAULT_PART_SIZE[1] &&
      part.size[2] === DEFAULT_PART_SIZE[2];
    defaultFindings.push({
      check: 'default_material_tell',
      instance: part.path,
      observed: greyed
        ? `Instance.new("Part") untouched: Plastic, medium stone grey${defaultSized ? ', 4x1x2' : ''}`
        : 'Plastic, the default material',
      expected: 'a material chosen with the colour (the kit pairs them)',
      fix: `rebuild it with a kit constructor, or kit.tint(${luauPath(part.path)}, "sand")`,
    });
  }

  // -- grid alignment --------------------------------------------------------
  const gridFindings: DesignFinding[] = [];
  for (const part of parts) {
    if (part.pos.every(value => isOnGrid(value))) continue;
    gridFindings.push({
      check: 'grid_alignment',
      instance: part.path,
      observed: `position (${fmt(part.pos)})`,
      expected: `every component a multiple of ${String(GRID_STUDS)}`,
      fix: `${luauPath(part.path)}.Position = Vector3.new(${part.pos.map(snapToGrid).join(', ')})`,
    });
  }

  // -- size sanity -----------------------------------------------------------
  const sizeFindings: DesignFinding[] = [];
  for (const part of parts) {
    const smallest = Math.min(...part.size);
    const largest = Math.max(...part.size);
    if (smallest < MIN_PART_STUDS) {
      sizeFindings.push({
        check: 'size_sanity',
        instance: part.path,
        observed: `size (${fmt(part.size)})`,
        expected: `every axis at least ${String(MIN_PART_STUDS)} studs`,
        fix: `${luauPath(part.path)}.Size = Vector3.new(${part.size.map(v => Math.max(v, MIN_PART_STUDS)).join(', ')})`,
      });
    } else if (largest > MAX_PART_STUDS) {
      sizeFindings.push({
        check: 'size_sanity',
        instance: part.path,
        observed: `size (${fmt(part.size)})`,
        expected: `no axis over ${String(MAX_PART_STUDS)} studs`,
        fix: `shrink ${luauPath(part.path)}; a coordinate was probably mistyped`,
      });
    } else if (largest / smallest > MAX_ASPECT_RATIO) {
      sizeFindings.push({
        check: 'size_sanity',
        instance: part.path,
        observed: `size (${fmt(part.size)}), aspect ratio ${String(Math.round(largest / smallest))}`,
        expected: `aspect ratio under ${String(MAX_ASPECT_RATIO)}`,
        fix: `thicken ${luauPath(part.path)} — at this ratio it renders as a line`,
      });
    }
  }

  // -- interpenetration ------------------------------------------------------
  //
  // The ground plane is excluded on both sides of every pair. It is a floor:
  // a platform laid at ground level shares space with it by construction, and
  // flagging that would fire on every well-built scene the kit produces.
  const solid = parts.filter(part => isStyled(part) && part.role !== GROUND_ROLE);
  const boxes = solid.map(part => ({ part, box: worldAabb(part) }));
  const overlapFindings: DesignFinding[] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (!a || !b) continue;
      const fraction = overlapFraction(a.box, b.box);
      if (fraction <= 0) continue;
      const pickup = PICKUP_ROLES.has(a.part.role ?? '') || PICKUP_ROLES.has(b.part.role ?? '');
      const threshold = pickup ? OVERLAP_FRACTION_PICKUP : OVERLAP_FRACTION;
      if (fraction < threshold) continue;
      const percent = String(Math.round(fraction * 100));
      overlapFindings.push({
        check: 'no_interpenetration',
        instance: a.part.path,
        observed: `${percent}% of its volume is inside ${b.part.path}`,
        expected: pickup
          ? 'a pickup must sit clear of solid geometry or the player cannot reach it'
          : `under ${String(Math.round(threshold * 100))}% shared volume`,
        fix: `move ${luauPath(a.part.path)} clear of ${b.part.path}, or shrink one of them`,
      });
    }
  }

  // -- variety ---------------------------------------------------------------
  //
  // The weakest check here, and worth saying so. Colour and size are gated
  // independently because they fail for different reasons and a builder can
  // only act on the one it actually has — but a scene can be uniform on either
  // axis by intent, so this is the check most likely to argue with a human.
  //
  // Counted over everything except the ground, because the bootstrap always
  // supplies a ground plane and it would otherwise hand a grey box one free
  // colour and one free size.
  const varietyParts = styled.filter(part => part.role !== GROUND_ROLE);
  const colors = new Set<string>();
  const sizes = new Set<string>();
  const heights = new Set<number>();
  for (const part of varietyParts) {
    const rgb = toRgb255(part.color);
    const { entry, distance } = nearestPaletteEntry(rgb);
    colors.add(distance <= PALETTE_TOLERANCE_RGB ? entry.name : `off:${rgb.join(',')}`);
    sizes.add(part.size.map(value => Math.round(value * 2) / 2).join('x'));
    heights.add(Math.round(worldAabb(part).max[1]));
  }
  const stats: DesignStats = {
    distinctColors: colors.size,
    distinctSizes: sizes.size,
    distinctHeights: heights.size,
  };
  const varietyFindings: DesignFinding[] = [];
  if (varietyParts.length >= VARIETY_MIN_PARTS) {
    if (colors.size < 2) {
      varietyFindings.push({
        check: 'variety',
        instance: '<scene>',
        observed: `all ${String(varietyParts.length)} parts share one colour`,
        expected: 'at least two palette colours, with accents reserved for interactables',
        fix: 'kit.tint the interactive objects gold / teal / ember and leave structure in sand and slate',
      });
    }
    if (sizes.size < 2) {
      varietyFindings.push({
        check: 'variety',
        instance: '<scene>',
        observed: `all ${String(varietyParts.length)} parts are the same size`,
        expected: 'objects proportioned to their purpose',
        fix: 'use the kit constructors — a coin, a wall and a platform are not the same shape',
      });
    }
  }

  // -- lighting --------------------------------------------------------------
  const lightingFindings: DesignFinding[] = [];
  if (!lighting.atmosphere) {
    lightingFindings.push({
      check: 'scene_lighting',
      instance: '<Lighting>',
      observed: `no Atmosphere, Brightness ${String(lighting.brightness)}, ClockTime ${String(lighting.clockTime)}`,
      expected: 'a styled sky: default Lighting renders every scene flat',
      fix: 'kit.scene()',
    });
  }

  const checks: DesignCheck[] = [
    check(
      'palette_adherence',
      'every visible part is one of the kit palette colours',
      styled.length,
      paletteFindings,
    ),
    check(
      'default_material_tell',
      'no part is still wearing what Instance.new gave it',
      styled.length,
      defaultFindings,
    ),
    check('grid_alignment', `positions sit on the ${String(GRID_STUDS)}-stud grid`, parts.length, gridFindings),
    check('size_sanity', 'no degenerate, absurd or sliver-thin parts', parts.length, sizeFindings),
    check(
      'no_interpenetration',
      'no part is buried inside another beyond a touching tolerance',
      solid.length,
      overlapFindings,
    ),
    check('variety', 'the scene is not one colour and one size', varietyParts.length, varietyFindings),
    check('scene_lighting', 'the place is not on default Lighting', 1, lightingFindings),
  ];

  return {
    root,
    parts: parts.length,
    kitParts: parts.filter(part => typeof part.role === 'string' && part.role.length > 0).length,
    handRolled: parts.filter(part => !part.role).length,
    stats,
    checks,
    passed: checks.every(entry => entry.pass),
  };
}

/**
 * One Luau program that reports everything the checks need.
 *
 * A round trip per property would be dozens of calls against a bridge that
 * times out whenever Studio loses focus, so this follows `studio.ts` and
 * returns a single JSON payload. The rotation matrix comes along because a
 * bounding box for a rotated part cannot be reconstructed from Position and
 * Size alone, and the coin is rotated by construction.
 */
function inspectLuau(rootExpr: string): string {
  return `
local HttpService = game:GetService("HttpService")
local Lighting = game:GetService("Lighting")

local root = ${rootExpr}
if not root then return HttpService:JSONEncode({ ok = false, reason = "root not found" }) end

local parts = {}

local function walk(inst, prefix)
	for _, child in inst:GetChildren() do
		local path = prefix == "" and child.Name or (prefix .. "/" .. child.Name)
		if child:IsA("BasePart") then
			local px, py, pz, r00, r01, r02, r10, r11, r12, r20, r21, r22 = child.CFrame:GetComponents()
			table.insert(parts, {
				path = path,
				class = child.ClassName,
				color = { child.Color.R, child.Color.G, child.Color.B },
				material = child.Material.Name,
				size = { child.Size.X, child.Size.Y, child.Size.Z },
				pos = { px, py, pz },
				rot = { r00, r01, r02, r10, r11, r12, r20, r21, r22 },
				transparency = child.Transparency,
				collide = child.CanCollide,
				role = child:GetAttribute("KitRole"),
			})
		end
		walk(child, path)
	end
end

walk(root, "")

return HttpService:JSONEncode({
	ok = true,
	parts = parts,
	lighting = {
		atmosphere = Lighting:FindFirstChildOfClass("Atmosphere") ~= nil,
		brightness = Lighting.Brightness,
		clockTime = Lighting.ClockTime,
	},
})
`;
}

/**
 * Inspects a built world and reports how it looks.
 *
 * `root` is a place path in the form `worldstate.ts` already understands, so
 * this works against the harness sandbox or against a subtree of a real game
 * without a second resolver.
 */
export async function inspectDesign(session: StudioSession, root = SANDBOX): Promise<DesignReport> {
  const raw = await session.luau(inspectLuau(rootExpression(root)));
  if (typeof raw !== 'string') throw new Error('design inspection returned no payload');

  const payload = JSON.parse(raw) as { ok?: boolean; reason?: string; parts?: unknown; lighting?: unknown };
  if (!payload.ok) throw new Error(`design inspection failed: ${payload.reason ?? 'unknown'}`);

  // JSONEncode cannot tell an empty array from an empty table, so a world with
  // no parts arrives as `{}` rather than `[]`.
  const rawParts = Array.isArray(payload.parts) ? payload.parts : [];
  const parts = z.array(PartRecordSchema).parse(rawParts);
  const lighting = LightingRecordSchema.parse(payload.lighting);

  return analyzeParts({ root, parts, lighting });
}

/** The report as text: what the CLI prints and what the agent reads back. */
export function renderDesignReport(report: DesignReport): string {
  const lines: string[] = [];
  lines.push(
    `  ${report.root}: ${String(report.parts)} part(s), ${String(report.kitParts)} from the kit, ${String(report.handRolled)} hand-rolled`,
  );
  lines.push(
    `  ${String(report.stats.distinctColors)} colour(s), ${String(report.stats.distinctSizes)} size(s), ${String(report.stats.distinctHeights)} height(s)`,
  );
  for (const entry of report.checks) {
    lines.push(`  ${entry.pass ? 'PASS' : 'FAIL'}  ${entry.name}  (${entry.note})`);
    for (const finding of entry.findings) {
      lines.push(`          ${finding.instance}: ${finding.observed}`);
      lines.push(`              wanted ${finding.expected}`);
      lines.push(`              fix    ${finding.fix}`);
    }
    if (entry.omitted > 0) lines.push(`          ... and ${String(entry.omitted)} more`);
  }
  lines.push(`  ${report.passed ? 'design accepted' : 'design rejected'}`);
  return lines.join('\n');
}
