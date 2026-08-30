import { describe, expect, it } from 'vitest';

import {
  MAX_FINDINGS_PER_CHECK,
  OVERLAP_FRACTION,
  analyzeParts,
  isAxisAligned,
  overlapFraction,
  renderDesignReport,
  toRgb255,
  worldAabb,
  type DesignCheckName,
  type DesignReport,
  type LightingRecord,
  type PartRecord,
} from '../src/verifier/design.js';
import { DEFAULT_PART_RGB, PALETTE, paletteEntry } from '../src/verifier/kit.js';

const IDENTITY: PartRecord['rot'] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** A quarter turn about Y: what kit.coin does to stand a cylinder on edge. */
const YAW90: PartRecord['rot'] = [0, 0, 1, 0, 1, 0, -1, 0, 0];

const STYLED: LightingRecord = { atmosphere: true, brightness: 2.6, clockTime: 15.5 };
const DEFAULT_LIGHTING: LightingRecord = { atmosphere: false, brightness: 2, clockTime: 14 };

function rgb01(name: string): PartRecord['color'] {
  const entry = paletteEntry(name);
  if (!entry) throw new Error(`no palette entry ${name}`);
  return [entry.rgb[0] / 255, entry.rgb[1] / 255, entry.rgb[2] / 255];
}

function part(overrides: Partial<PartRecord> & { path: string }): PartRecord {
  return {
    segments: overrides.path.split('/'),
    class: 'Part',
    color: rgb01('sand'),
    material: 'Concrete',
    size: [4, 4, 4],
    pos: [0, 0, 0],
    rot: IDENTITY,
    transparency: 0,
    collide: true,
    ...overrides,
  };
}

/** What kit.ts actually produces, transcribed as records. */
function kitScene(): PartRecord[] {
  return [
    part({ path: 'Ground', role: 'ground', color: rgb01('moss'), material: 'Grass', size: [96, 2, 96], pos: [0, -1, 0] }),
    part({ path: 'Platform', role: 'platform', size: [16, 1, 16], pos: [0, -0.5, 0] }),
    part({
      path: 'Ledge',
      role: 'platform',
      color: rgb01('clay'),
      size: [12, 1, 12],
      pos: [24, 3.5, 0],
    }),
    part({
      path: 'Coin',
      role: 'coin',
      color: rgb01('gold'),
      material: 'Neon',
      size: [0.5, 3, 3],
      rot: YAW90,
      pos: [0, 2, 0],
      collide: false,
    }),
    part({
      path: 'Door',
      role: 'door',
      color: rgb01('teal'),
      material: 'SmoothPlastic',
      size: [6, 8, 1],
      pos: [0, 4, 10],
    }),
    part({
      path: 'Pillar',
      role: 'decor',
      color: rgb01('slate'),
      material: 'Slate',
      size: [2, 6, 2],
      pos: [6, 3, 6],
    }),
  ];
}

/** Instance.new("Part") repeated: the thing the kit exists to prevent. */
function greyBox(count: number): PartRecord[] {
  return Array.from({ length: count }, (_, index) =>
    part({
      path: `Part${String(index)}`,
      color: [DEFAULT_PART_RGB[0] / 255, DEFAULT_PART_RGB[1] / 255, DEFAULT_PART_RGB[2] / 255],
      material: 'Plastic',
      size: [4, 1, 2],
      // Off the grid, because a model naming coordinates by hand does not
      // round them.
      pos: [0.3 + index * 6, 0.5, 0],
    }),
  );
}

function checkOf(report: DesignReport, name: DesignCheckName) {
  const found = report.checks.find(entry => entry.name === name);
  if (!found) throw new Error(`no check ${name}`);
  return found;
}

describe('bounding boxes', () => {
  it('is the part itself when nothing is rotated', () => {
    const box = worldAabb({ size: [4, 2, 6], pos: [1, 1, 1], rot: IDENTITY });
    expect(box.min).toEqual([-1, 0, -2]);
    expect(box.max).toEqual([3, 2, 4]);
  });

  it('swaps the extents a quarter turn moves — the coin case', () => {
    // kit.coin is a 0.5 x 3 x 3 cylinder yawed 90 degrees. Reading Size alone
    // would put its thin axis in the wrong place and make every coin look like
    // it clips whatever it stands over.
    const box = worldAabb({ size: [0.5, 3, 3], pos: [0, 2, 0], rot: YAW90 });
    expect(box.max[0] - box.min[0]).toBeCloseTo(3);
    expect(box.max[1] - box.min[1]).toBeCloseTo(3);
    expect(box.max[2] - box.min[2]).toBeCloseTo(0.5);
  });
});

describe('axis alignment', () => {
  it('accepts identity and quarter turns, rejects anything between', () => {
    expect(isAxisAligned(IDENTITY)).toBe(true);
    expect(isAxisAligned(YAW90)).toBe(true);
    const c = Math.SQRT1_2;
    expect(isAxisAligned([c, 0, c, 0, 1, 0, -c, 0, c])).toBe(false);
  });
});

describe('overlap', () => {
  const unit = { size: [2, 2, 2] as PartRecord['size'], rot: IDENTITY };

  it('is zero for boxes that do not touch', () => {
    const a = worldAabb({ ...unit, pos: [0, 0, 0] });
    const b = worldAabb({ ...unit, pos: [10, 0, 0] });
    expect(overlapFraction(a, b)).toBe(0);
  });

  it('is zero for boxes that meet exactly at a face', () => {
    // A pillar standing on a platform shares a plane with it. Reporting that
    // would fire on every correctly built scene.
    const a = worldAabb({ ...unit, pos: [0, 0, 0] });
    const b = worldAabb({ ...unit, pos: [2, 0, 0] });
    expect(overlapFraction(a, b)).toBe(0);
  });

  it('is one when the smaller box is entirely inside the larger', () => {
    const small = worldAabb({ size: [2, 2, 2], pos: [0, 0, 0], rot: IDENTITY });
    const big = worldAabb({ size: [20, 20, 20], pos: [0, 0, 0], rot: IDENTITY });
    expect(overlapFraction(small, big, 0)).toBeCloseTo(1);
  });

  it('measures against the smaller box, not the larger', () => {
    // Half a small part inside a huge one is half the small part gone. Scaling
    // by the larger box would report it as negligible.
    const small = worldAabb({ size: [2, 2, 2], pos: [0, 0, 0], rot: IDENTITY });
    const big = worldAabb({ size: [20, 20, 20], pos: [10, 0, 0], rot: IDENTITY });
    expect(overlapFraction(small, big, 0)).toBeCloseTo(0.5);
  });
});

describe('a scene built out of the kit', () => {
  const report = analyzeParts({ root: 'PlaceboSandbox', parts: kitScene(), lighting: STYLED });

  it('passes every check', () => {
    expect(report.checks.filter(entry => !entry.pass).map(entry => entry.name)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('reports that the world came from the substrate', () => {
    expect(report.kitParts).toBe(report.parts);
    expect(report.handRolled).toBe(0);
  });

  it('counts variety without the ground plane paying for it', () => {
    // The bootstrap always adds a ground, so counting it would hand a
    // single-colour scene one free colour and one free size.
    expect(report.stats.distinctColors).toBe(5);
    expect(report.stats.distinctSizes).toBe(5);
    expect(report.stats.distinctHeights).toBeGreaterThan(1);
  });
});

describe('a grey box', () => {
  const report = analyzeParts({ root: 'PlaceboSandbox', parts: greyBox(6), lighting: DEFAULT_LIGHTING });

  it('fails on exactly the checks that describe it', () => {
    expect(report.checks.filter(entry => !entry.pass).map(entry => entry.name).sort()).toEqual([
      'default_material_tell',
      'grid_alignment',
      'palette_adherence',
      'scene_lighting',
      'variety',
    ]);
    expect(report.passed).toBe(false);
  });

  it('names the untouched default for what it is', () => {
    const finding = checkOf(report, 'default_material_tell').findings[0];
    expect(finding?.observed).toContain('untouched');
    expect(finding?.observed).toContain('4x1x2');
  });

  it('hands back a repair that is a call, not an adjective', () => {
    const finding = checkOf(report, 'palette_adherence').findings[0];
    expect(finding?.fix).toBe('kit.tint(sandbox.Part0, "sand")');
  });

  it('gives the snapped position rather than saying "off grid"', () => {
    const finding = checkOf(report, 'grid_alignment').findings[0];
    expect(finding?.observed).toContain('0.30');
    expect(finding?.fix).toBe('sandbox.Part0.Position = Vector3.new(0.5, 0.5, 0)');
  });

  it('says the scene is one colour and one size', () => {
    const observed = checkOf(report, 'variety').findings.map(finding => finding.observed);
    expect(observed.some(line => line.includes('one colour'))).toBe(true);
    expect(observed.some(line => line.includes('same size'))).toBe(true);
  });

  it('caps the findings so the report stays feedable to a model', () => {
    const big = analyzeParts({ root: 'r', parts: greyBox(20), lighting: STYLED });
    const palette = checkOf(big, 'palette_adherence');
    expect(palette.findings).toHaveLength(MAX_FINDINGS_PER_CHECK);
    expect(palette.omitted).toBe(20 - MAX_FINDINGS_PER_CHECK);
    expect(palette.inspected).toBe(20);
  });
});

describe('variety', () => {
  it('says nothing about a scene too small for it to mean anything', () => {
    const report = analyzeParts({ root: 'r', parts: greyBox(3), lighting: STYLED });
    expect(checkOf(report, 'variety').pass).toBe(true);
  });

  it('reports colour and size as two independent tells', () => {
    // Deliberate, because they fail for different reasons and a builder can
    // only act on the one it actually has. Varied geometry in a single hue is
    // still a scene where nothing is highlighted; six colours of the same cube
    // is still placeholder geometry.
    const monochrome = Array.from({ length: 6 }, (_, index) =>
      part({ path: `P${String(index)}`, size: [2 + index, 1, 2], pos: [index * 12, 0, 0] }),
    );
    const byColour = checkOf(analyzeParts({ root: 'r', parts: monochrome, lighting: STYLED }), 'variety');
    expect(byColour.findings.map(finding => finding.observed)).toEqual([
      'all 6 parts share one colour',
    ]);

    const uniform = PALETTE.slice(0, 6).map((entry, index) =>
      part({ path: `P${String(index)}`, color: rgb01(entry.name), pos: [index * 12, 0, 0] }),
    );
    const bySize = checkOf(analyzeParts({ root: 'r', parts: uniform, lighting: STYLED }), 'variety');
    expect(bySize.findings.map(finding => finding.observed)).toEqual([
      'all 6 parts are the same size',
    ]);
  });
});

describe('interpenetration', () => {
  const platform = part({ path: 'Platform', role: 'platform', size: [16, 1, 16], pos: [0, -0.5, 0] });

  function sunk(role: string): PartRecord {
    // 13% of this object's volume is inside the platform below it.
    return part({
      path: 'Thing',
      role,
      color: rgb01('gold'),
      material: 'Neon',
      size: [0.5, 3, 3],
      rot: YAW90,
      pos: [0, 1, 0],
      collide: false,
    });
  }

  it('holds a pickup to a stricter bound than scenery', () => {
    const pickup = analyzeParts({ root: 'r', parts: [platform, sunk('coin')], lighting: STYLED });
    expect(checkOf(pickup, 'no_interpenetration').pass).toBe(false);
    expect(checkOf(pickup, 'no_interpenetration').findings[0]?.expected).toContain('cannot reach it');

    // Identical geometry, different role: scenery resting partly in a platform
    // is how scenery is placed.
    const scenery = analyzeParts({ root: 'r', parts: [platform, sunk('decor')], lighting: STYLED });
    expect(checkOf(scenery, 'no_interpenetration').pass).toBe(true);
  });

  it('does not fire on anything sharing space with the ground plane', () => {
    // kit.platform at ground level occupies the same studs as kit.ground by
    // construction, which is what a floor is.
    const ground = part({ path: 'Ground', role: 'ground', color: rgb01('moss'), material: 'Grass', size: [96, 2, 96], pos: [0, -1, 0] });
    const report = analyzeParts({ root: 'r', parts: [ground, platform], lighting: STYLED });
    expect(checkOf(report, 'no_interpenetration').pass).toBe(true);
    expect(checkOf(report, 'no_interpenetration').inspected).toBe(1);
  });

  it('leaves rotated parts alone, because their bounding boxes lie', () => {
    // Two 6x1x0.5 bars at +45 and -45 degrees, crossing at right angles with
    // 0.43 studs of clear air between them. They do not touch, but their
    // axis-aligned bounding boxes share 17% of a bar's volume — so the
    // bounding-box test alone would tell the agent to move working geometry.
    const yaw = (degrees: number): PartRecord['rot'] => {
      const c = Math.cos((degrees * Math.PI) / 180);
      const sn = Math.sin((degrees * Math.PI) / 180);
      return [c, 0, sn, 0, 1, 0, -sn, 0, c];
    };
    const a = part({ path: 'BarA', size: [6, 1, 0.5], pos: [0, 0, 0], rot: yaw(45) });
    const b = part({ path: 'BarB', size: [6, 1, 0.5], pos: [2.6, 0, 2.6], rot: yaw(-45) });

    // The false positive is real: the boxes do overlap even though the parts do not.
    expect(overlapFraction(worldAabb(a), worldAabb(b))).toBeGreaterThan(OVERLAP_FRACTION);

    const report = analyzeParts({ root: 'r', parts: [a, b], lighting: STYLED });
    const overlap = checkOf(report, 'no_interpenetration');
    expect(overlap.pass).toBe(true);
    expect(overlap.inspected).toBe(0);
    expect(overlap.note).toContain('2 rotated part(s) not checked');
  });

  it('still checks the quarter-turn the kit actually uses', () => {
    // kit.coin is yawed 90 degrees, which maps its axes onto world axes — the
    // bounding box is the part, so the test stays exact.
    const coin = part({
      path: 'Coin',
      role: 'coin',
      color: rgb01('gold'),
      material: 'Neon',
      size: [0.5, 3, 3],
      rot: YAW90,
      pos: [0, 1, 0],
      collide: false,
    });
    const report = analyzeParts({ root: 'r', parts: [platform, coin], lighting: STYLED });
    expect(checkOf(report, 'no_interpenetration').inspected).toBe(2);
    expect(checkOf(report, 'no_interpenetration').pass).toBe(false);
  });

  it('ignores invisible volumes, which are meant to sit inside geometry', () => {
    const trigger = part({ path: 'Trigger', size: [4, 4, 4], pos: [0, -0.5, 0], transparency: 1, collide: false });
    const report = analyzeParts({ root: 'r', parts: [platform, trigger], lighting: STYLED });
    expect(checkOf(report, 'no_interpenetration').pass).toBe(true);
    // ...and its colour is not a design choice either.
    expect(checkOf(report, 'palette_adherence').pass).toBe(true);
  });
});

describe('size sanity', () => {
  it('catches a part collapsed to nothing', () => {
    const report = analyzeParts({
      root: 'r',
      parts: [part({ path: 'Thin', size: [4, 0.01, 4] })],
      lighting: STYLED,
    });
    const finding = checkOf(report, 'size_sanity').findings[0];
    expect(finding?.expected).toContain('at least');
    expect(finding?.fix).toContain('Vector3.new(4, 0.2, 4)');
  });

  it('catches a mistyped coordinate that became a size', () => {
    const report = analyzeParts({
      root: 'r',
      parts: [part({ path: 'Huge', size: [4, 4, 9000] })],
      lighting: STYLED,
    });
    expect(checkOf(report, 'size_sanity').findings[0]?.expected).toContain('over');
  });

  it('catches a sliver that renders as a line', () => {
    const report = analyzeParts({
      root: 'r',
      parts: [part({ path: 'Sliver', size: [400, 0.5, 0.5] })],
      lighting: STYLED,
    });
    expect(checkOf(report, 'size_sanity').findings[0]?.observed).toContain('aspect ratio');
  });

  it('leaves a long wall alone', () => {
    const report = analyzeParts({
      root: 'r',
      parts: [part({ path: 'Wall', role: 'wall', size: [128, 8, 1], pos: [0, 4, 0] })],
      lighting: STYLED,
    });
    expect(checkOf(report, 'size_sanity').pass).toBe(true);
  });
});

describe('authored content', () => {
  const ground = part({
    path: 'Ground',
    role: 'ground',
    color: rgb01('moss'),
    material: 'Grass',
    size: [96, 2, 96],
    pos: [0, -1, 0],
  });

  it('does not count the ground plane the bootstrap supplies', () => {
    // withKit runs kit.ground on every world step, so a world containing only
    // the floor is a world where the agent built nothing.
    const report = analyzeParts({ root: 'r', parts: [ground], lighting: STYLED });
    expect(report.authoredParts).toBe(0);
    expect(checkOf(report, 'authored_content').pass).toBe(false);
    expect(checkOf(report, 'authored_content').findings[0]?.observed).toContain('only geometry is the ground');
    expect(report.passed).toBe(false);
  });

  it('is satisfied by one authored part, and says so in the report', () => {
    const report = analyzeParts({
      root: 'r',
      parts: [ground, part({ path: 'Platform', role: 'platform', size: [16, 1, 16], pos: [0, -0.5, 0] })],
      lighting: STYLED,
    });
    expect(report.authoredParts).toBe(1);
    expect(report.passed).toBe(true);
    expect(renderDesignReport(report)).toContain('2 part(s), 1 authored');
  });
});

describe('repair paths', () => {
  function fixFor(name: string): string {
    const report = analyzeParts({
      root: 'r',
      // Off-palette, so the palette check produces a finding to read the path from.
      parts: [part({ path: `Room/${name}`, color: [0.1, 0.9, 0.2] })],
      lighting: STYLED,
    });
    return checkOf(report, 'palette_adherence').findings[0]?.fix ?? '';
  }

  it('uses dot notation only where the name is a legal identifier', () => {
    expect(fixFor('Door')).toBe('kit.tint(sandbox.Room.Door, "moss")');
  });

  it('brackets a name that cannot follow a dot', () => {
    // All three are legal Roblox names and none of them parses after a dot.
    expect(fixFor('My Door')).toBe('kit.tint(sandbox.Room["My Door"], "moss")');
    expect(fixFor('end')).toBe('kit.tint(sandbox.Room["end"], "moss")');
    expect(fixFor('Coin#2')).toBe('kit.tint(sandbox.Room["Coin#2"], "moss")');
    expect(fixFor('2Fast')).toBe('kit.tint(sandbox.Room["2Fast"], "moss")');
  });

  it('escapes a name that would otherwise close the string', () => {
    expect(fixFor('say "hi"')).toBe('kit.tint(sandbox.Room["say \\"hi\\""], "moss")');
  });

  it('does not lose a name containing the path separator', () => {
    // `path` joins on "/", so splitting it back apart would produce two
    // instances that do not exist. The segments are carried instead.
    const report = analyzeParts({
      root: 'r',
      parts: [{ ...part({ path: 'A/B' }), segments: ['A/B'], color: [0.1, 0.9, 0.2] }],
      lighting: STYLED,
    });
    expect(checkOf(report, 'palette_adherence').findings[0]?.fix).toBe('kit.tint(sandbox["A/B"], "moss")');
  });
});

describe('scene lighting', () => {
  it('is not satisfied by an Atmosphere over a stock sky', () => {
    // Qodo's case: a place nobody styled that happens to carry an Atmosphere.
    for (const clockTime of [14, 14.5]) {
      const report = analyzeParts({
        root: 'r',
        parts: kitScene(),
        lighting: { atmosphere: true, brightness: 2, clockTime },
      });
      expect(checkOf(report, 'scene_lighting').pass).toBe(false);
      expect(checkOf(report, 'scene_lighting').findings[0]?.observed).toContain('an Atmosphere, but');
    }
  });

  it('accepts an Atmosphere over a sky somebody moved', () => {
    const report = analyzeParts({
      root: 'r',
      parts: kitScene(),
      lighting: { atmosphere: true, brightness: 2.6, clockTime: 15.5 },
    });
    expect(checkOf(report, 'scene_lighting').pass).toBe(true);
  });

  it('still fails when the sun moved but nothing was added to the sky', () => {
    const report = analyzeParts({
      root: 'r',
      parts: kitScene(),
      lighting: { atmosphere: false, brightness: 2.6, clockTime: 15.5 },
    });
    expect(checkOf(report, 'scene_lighting').pass).toBe(false);
  });
});

describe('colour conversion', () => {
  it('round-trips a palette entry exactly', () => {
    for (const entry of PALETTE) {
      expect(toRgb255(rgb01(entry.name))).toEqual([...entry.rgb]);
    }
  });
});

describe('the rendered report', () => {
  it('shows the verdict, the finding and the repair together', () => {
    const text = renderDesignReport(
      analyzeParts({ root: 'PlaceboSandbox', parts: greyBox(6), lighting: DEFAULT_LIGHTING }),
    );
    expect(text).toContain('PASS  size_sanity');
    expect(text).toContain('FAIL  palette_adherence');
    expect(text).toContain('fix    kit.tint(sandbox.Part0, "sand")');
    expect(text).toContain('design rejected');
  });

  it('rejects an empty world instead of passing it vacuously', () => {
    // Every other check is a statement about parts, so a world with none
    // satisfies all of them. An agent could clear the design gate by building
    // nothing, which is the same hole validate.ts closes for contracts.
    const report = analyzeParts({ root: 'r', parts: [], lighting: STYLED });
    expect(checkOf(report, 'authored_content').pass).toBe(false);
    expect(report.passed).toBe(false);
    expect(renderDesignReport(report)).toContain('design rejected');
  });
});
