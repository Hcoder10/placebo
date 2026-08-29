import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PART_RGB,
  GRID_STUDS,
  KIT_BRIEF,
  KIT_BOOTSTRAP_LUAU,
  KIT_LIGHTING_RESTORE_LUAU,
  KIT_LUAU,
  PALETTE,
  PALETTE_TOLERANCE_RGB,
  PLAY_SCRIPT_SOURCE,
  isOnGrid,
  luauLongString,
  nearestPaletteEntry,
  paletteEntry,
  playableLuau,
  rgbDistance,
  snapToGrid,
  withKit,
} from '../src/verifier/kit.js';

describe('the palette itself', () => {
  it('keeps every entry further apart than the tolerance that matches them', () => {
    // If two entries were within PALETTE_TOLERANCE_RGB of each other, the
    // adherence check could report a part as "the wrong one of two colours it
    // is equally close to", and its repair hint would be a coin flip.
    for (const a of PALETTE) {
      for (const b of PALETTE) {
        if (a.name === b.name) continue;
        expect(rgbDistance(a.rgb, b.rgb)).toBeGreaterThan(PALETTE_TOLERANCE_RGB * 2);
      }
    }
  });

  it('contains nothing near the colour Instance.new gives a part', () => {
    // The untouched-default check fires on medium stone grey. A palette entry
    // sitting near it would make that check unable to distinguish a styling
    // choice from an instance nobody touched.
    for (const entry of PALETTE) {
      expect(rgbDistance(entry.rgb, DEFAULT_PART_RGB)).toBeGreaterThan(PALETTE_TOLERANCE_RGB * 4);
    }
  });

  it('names an entry for every use a simple game has', () => {
    const names = PALETTE.map(entry => entry.name);
    expect(names).toContain('gold');
    expect(names).toContain('ember');
    expect(names).toContain('teal');
    expect(new Set(names).size).toBe(PALETTE.length);
  });
});

describe('grid arithmetic', () => {
  it('snaps onto the lattice in both directions from zero', () => {
    expect(snapToGrid(0.3)).toBe(0.5);
    expect(snapToGrid(0.2)).toBe(0);
    expect(snapToGrid(-0.3)).toBe(-0.5);
    expect(snapToGrid(7.26)).toBe(7.5);
  });

  it('leaves a coordinate already on the lattice alone', () => {
    for (const value of [0, 0.5, -4, 12.5, -0.5]) {
      expect(snapToGrid(value)).toBe(value);
      expect(isOnGrid(value)).toBe(true);
    }
  });

  it('tolerates float noise but not a genuinely off-grid position', () => {
    // A position that came back through Roblox's float round-trip is on the
    // grid; 0.26 studs off is a model that did arithmetic by hand.
    expect(isOnGrid(3.5 + 1e-7)).toBe(true);
    expect(isOnGrid(3.26)).toBe(false);
  });
});

describe('nearest palette entry', () => {
  it('matches an exact palette colour at zero distance', () => {
    const gold = paletteEntry('gold');
    expect(gold).toBeDefined();
    const nearest = nearestPaletteEntry(gold?.rgb ?? []);
    expect(nearest.entry.name).toBe('gold');
    expect(nearest.distance).toBe(0);
  });

  it('absorbs a one-shade rounding difference', () => {
    const gold = paletteEntry('gold');
    const [r = 0, g = 0, b = 0] = gold?.rgb ?? [];
    const nearest = nearestPaletteEntry([r + 1, g - 1, b + 1]);
    expect(nearest.entry.name).toBe('gold');
    expect(nearest.distance).toBeLessThanOrEqual(PALETTE_TOLERANCE_RGB);
  });

  it('reports the default part grey as far from everything', () => {
    expect(nearestPaletteEntry(DEFAULT_PART_RGB).distance).toBeGreaterThan(PALETTE_TOLERANCE_RGB);
  });
});

describe('the generated Luau', () => {
  it('carries every palette entry exactly as TypeScript declares it', () => {
    // The point of generating the Luau is that design.ts and the kit cannot
    // disagree about what the palette is. This is the test that would fail if
    // someone hand-edited one side.
    for (const entry of PALETTE) {
      expect(KIT_LUAU).toContain(`${entry.name} = { c = Color3.fromRGB(${entry.rgb.join(', ')})`);
      expect(KIT_LUAU).toContain(`Enum.Material.${entry.material}`);
    }
  });

  it('uses the same grid constant the checker does', () => {
    expect(KIT_LUAU).toContain(`local GRID = ${String(GRID_STUDS)}`);
  });

  it('declares exactly one top-level local', () => {
    // The prelude is prepended to every world step, and a contract's setup is
    // those steps concatenated into one block. Luau caps a function at 200
    // locals, so a prelude that leaked names would cap how many steps a build
    // can have.
    const topLevel = KIT_LUAU.split('\n').filter(line => /^local\s/.test(line));
    expect(topLevel).toHaveLength(1);
    expect(topLevel[0]).toContain('local kit =');
  });

  it('exposes a constructor for every object a simple game needs', () => {
    for (const name of ['platform', 'wall', 'door', 'coin', 'chest', 'hazard', 'spawn', 'decor', 'ground']) {
      expect(KIT_LUAU).toContain(`function kit.${name}(`);
      expect(KIT_BRIEF).toContain(`kit.${name}(`);
    }
  });

  it('tags everything it builds with the role design.ts reasons about', () => {
    expect(KIT_LUAU).toContain('inst:SetAttribute("KitRole", spec.role)');
  });

  it('can put back the only thing it changes outside the sandbox', () => {
    // kit.scene() is the kit's single out-of-sandbox side effect, so every
    // property it stashes must have a matching restore.
    for (const key of ['KitPrevAmbient', 'KitPrevOutdoorAmbient', 'KitPrevBrightness', 'KitPrevClockTime']) {
      expect(KIT_LUAU).toContain(key);
      expect(KIT_LIGHTING_RESTORE_LUAU).toContain(key);
    }
    // Both instances kit.scene() adds to Lighting, not just the first one.
    expect(KIT_LIGHTING_RESTORE_LUAU).toContain('atmosphere:Destroy()');
    expect(KIT_LIGHTING_RESTORE_LUAU).toContain('grade:Destroy()');
  });

  it('lights the objects a player is meant to notice', () => {
    // Neon glows, but only a light spills colour onto the floor around it —
    // which is what reads as a game rather than a viewport.
    expect(KIT_LUAU).toContain('kit.light(coin, "gold"');
    expect(KIT_LUAU).toContain('kit.light(pad, "cream"');
    expect(KIT_LUAU).toContain('kit.light(crystal, "teal"');
  });
});

describe('withKit', () => {
  it('puts the kit in scope and the agent code in its own block', () => {
    const wrapped = withKit('local p = kit.coin(sandbox, 0, 0, 0)');
    expect(wrapped.indexOf(KIT_LUAU)).toBe(0);
    // The block is what makes a step behave the same whether it runs alone or
    // concatenated into a contract's setup.
    expect(wrapped).toContain('do\nlocal p = kit.coin(sandbox, 0, 0, 0)\nend');
  });

  it('applies lighting and a floor by default, and skips them on request', () => {
    expect(withKit('-- nothing')).toContain(KIT_BOOTSTRAP_LUAU);
    expect(withKit('-- nothing', { bootstrap: false })).not.toContain(KIT_BOOTSTRAP_LUAU);
  });

  it('leaves the agent code byte-identical', () => {
    const luau = 'local coin = kit.coin(sandbox, 8, 0, 0, "Coin")\ncoin:SetAttribute("Value", 1)';
    expect(withKit(luau)).toContain(luau);
  });
});

describe('long strings', () => {
  it('picks a bracket level the content does not already contain', () => {
    expect(luauLongString('plain').startsWith('[[')).toBe(true);
    expect(luauLongString('a ]] b').startsWith('[=[')).toBe(true);
    expect(luauLongString('a ]] b ]=] c').startsWith('[==[')).toBe(true);
  });

  it('preserves the content, plus the one newline that keeps it safe', () => {
    // A value ending in "]" placed against a closing "]]" would terminate the
    // string a character early, and the level check cannot see that because the
    // terminator does not exist until the two are concatenated.
    const value = 'return x[1]';
    const wrapped = luauLongString(value);
    expect(wrapped).toBe(`[[\n${value}\n]]`);
  });
});

describe('the play layer', () => {
  it('is not part of the kit prelude or its bootstrap', () => {
    // The hard constraint. These are Scripts, and worldstate.ts watches Source,
    // so a play layer present during verification would show up in the causal
    // diff. It has to be a separate step, and this is what keeps it one.
    expect(KIT_LUAU).not.toContain('PlayLayer');
    expect(KIT_LUAU).not.toContain(PLAY_SCRIPT_SOURCE);
    expect(withKit('-- build something')).not.toContain(PLAY_SCRIPT_SOURCE);
    expect(KIT_BOOTSTRAP_LUAU).not.toContain('playable');
  });

  it('debounces every physical trigger', () => {
    // Touched fires many times per contact, and missing_debounce is one of the
    // defects the calibration table rejects. Handing the player the exact bug
    // the verifier catches would be an unforced error.
    expect(PLAY_SCRIPT_SOURCE).toContain('local function ready(part, seconds)');
    for (const guard of [
      'if not ready(part, TOUCH_DEBOUNCE) then return end',
      'if not ready(part, HAZARD_DEBOUNCE) then return end',
      'if not ready(part, PROMPT_DEBOUNCE) then return end',
    ]) {
      expect(PLAY_SCRIPT_SOURCE).toContain(guard);
    }
  });

  it('responds to players rather than to falling scenery', () => {
    expect(PLAY_SCRIPT_SOURCE).toContain("FindFirstChildOfClass(\"Humanoid\")");
    expect(PLAY_SCRIPT_SOURCE).toContain('if not touchedByPlayer(hit) then return end');
  });

  it('dispatches on KitRole, never on instance names', () => {
    expect(PLAY_SCRIPT_SOURCE).toContain('local role = part:GetAttribute("KitRole")');
    // The coin demo's names must not be baked in, or the layer only works for
    // the one world it was written against.
    for (const name of ['"Coin"', '"ChestA"', '"ChestB"', '"Door"', '"Scoreboard"']) {
      expect(PLAY_SCRIPT_SOURCE).not.toContain(name);
    }
  });

  it('only fires events the contracts already verify', () => {
    for (const event of ['event("Collect")', 'event("Use")', 'event("StepOn")']) {
      expect(PLAY_SCRIPT_SOURCE).toContain(event);
    }
    // Output reacts to attributes; it must never set one, or the play layer
    // would be causing the effects the verifier attributes to the mechanic.
    expect(PLAY_SCRIPT_SOURCE).not.toContain('SetAttribute');
  });

  it('installs the accepted patch alongside the triggers', () => {
    // Without this the layer fires events into a world where nothing listens:
    // the patch only ever ran in the command bar during verification.
    const program = playableLuau({ mechanic: 'sandbox.Collect.Event:Connect(function() end)' });
    expect(program).toContain(KIT_LUAU);
    expect(program).toContain('function kit.playable(parent, mechanicSource)');
    expect(program).toContain('sandbox.Collect.Event:Connect(function() end)');
    expect(program).toContain('local sandbox = script.Parent');
  });

  it('attaches nothing to listen with when no patch is supplied', () => {
    expect(playableLuau()).toContain('kit.playable(sandbox, nil)');
  });

  it('targets the sandbox by default and any root on request', () => {
    expect(playableLuau()).toContain('workspace:FindFirstChild("PlaceboSandbox")');
    expect(playableLuau({ root: 'MyGame' })).toContain('workspace:FindFirstChild("MyGame")');
  });
});

describe('the brief the agent reads', () => {
  it('states the ground-relative y convention, which is what models get wrong', () => {
    expect(KIT_BRIEF).toContain('y is the height of the GROUND');
  });

  it('lists every palette name, so the agent never has to guess one', () => {
    for (const entry of PALETTE) {
      expect(KIT_BRIEF).toContain(entry.name);
    }
  });
});
