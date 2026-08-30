import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  curriculumNote,
  DEFAULT_SEEDS,
  generatorInputFor,
  renderBaseline,
  renderContract,
  renderReferenceMigration,
  renderShortcuts,
  renderTask,
  writeGeneratedTask,
  type GeneratorInput,
  type Separability,
} from '../src/bright/tasks.js';
import type { CurriculumItem } from '../src/bright/curriculum.js';
import { fisherExact } from '../src/train/curriculum_train.js';
import { loadContract } from '../src/verifier/contract.js';
import { loadTask } from '../src/verifier/task.js';

const SOURCE = {
  url: 'https://create.roblox.com/docs/reference/engine/deprecations',
  via: 'fixture',
  fetchedAt: '2026-08-29T00:00:00.000Z',
  evidence: 'Humanoid.Health and Humanoid.MaxHealth both resolve in this engine',
};

const INPUT: GeneratorInput = {
  className: 'Humanoid',
  member: 'Health',
  replacement: 'MaxHealth',
  id: 'migrate_humanoid_health',
  order: 'replacement-first',
  source: SOURCE,
};

function confirmedItem(): CurriculumItem {
  return {
    record: { class_name: 'Humanoid', member: 'Health', replacement: 'MaxHealth' },
    verdict: 'confirmed',
    detail: SOURCE.evidence,
    proposal: {
      id: 'migrate_humanoid_health',
      goal: 'Replace Humanoid.Health with Humanoid.MaxHealth, keeping the behaviour identical.',
      deprecated: 'Humanoid.Health',
      replacement: 'Humanoid.MaxHealth',
    },
  };
}

function separable(overrides: Partial<Separability> = {}): Separability {
  return {
    separable: true,
    order: 'replacement-first',
    detail: 'held distinct values simultaneously',
    readback: [],
    ...overrides,
  };
}

describe('generated task and contract', () => {
  it('produces files the existing loaders accept', () => {
    const root = mkdtempSync(join(tmpdir(), 'placebo-curriculum-'));
    const generated = writeGeneratedTask(root, INPUT);

    const { task, contracts } = loadTask(generated.taskPath);
    expect(task.id).toBe('migrate_humanoid_health');
    expect(task.mode).toBe('repair');
    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.controls.length).toBeGreaterThanOrEqual(2);

    // The contract has to survive on its own too: it carries its own setup so
    // it can be run standalone, and the task overrides it with an identical one.
    const standalone = loadContract(generated.contractPath);
    expect(standalone.setup.trim()).toBe(contracts[0]?.setup.trim());
  });

  it('asks for the delta between the two members, not an absolute', () => {
    const contract = loadContract(writeGeneratedTaskInTemp().contractPath);
    const changes = contract.effects.map(effect => effect.change);
    // 100 - 25 and 90 - 40. Stating the absolute would let a patch that never
    // reads the member pass by writing the number the requirement quotes.
    expect(changes).toEqual(['+75', '+50']);
    for (const seed of DEFAULT_SEEDS) {
      expect(contract.setup).not.toContain(`SetAttribute("Value", ${String(seed.high)})`);
    }
  });

  it('gives the two subjects different capacities, so one constant cannot pass both', () => {
    const contract = loadContract(writeGeneratedTaskInTemp().contractPath);
    const deltas = new Set(contract.effects.map(effect => effect.change));
    expect(deltas.size).toBe(contract.effects.length);
  });

  it('starts from an implementation that reads the deprecated member', () => {
    const baseline = renderBaseline(INPUT);
    expect(baseline).toContain('.Health)');
    expect(baseline).not.toContain('MaxHealth');
  });

  it('offers the reference migration as the same code reading the replacement', () => {
    const reference = renderReferenceMigration(INPUT);
    expect(reference).toContain('.MaxHealth)');
    expect(reference.replace(/MaxHealth/g, 'Health')).toBe(renderBaseline(INPUT));
  });

  it('writes the setup identically into the task and the contract', () => {
    // A task overrides its contracts' setup, so the two drifting apart would
    // mean the contract said one thing standalone and another inside the task.
    const contract = renderContract(INPUT);
    const task = renderTask(INPUT, '../../contracts/generated/x.yaml');
    const setupOf = (text: string): string => {
      const start = text.indexOf('setup: |');
      const rest = text.slice(start + 'setup: |'.length);
      const end = rest.search(/\n(?=\S)/);
      return (end === -1 ? rest : rest.slice(0, end)).trim();
    };
    expect(setupOf(task)).toBe(setupOf(contract));
  });

  it('honours the assignment order the engine measured', () => {
    const first = renderContract(INPUT).indexOf('.MaxHealth = 100');
    const second = renderContract(INPUT).indexOf('.Health = 25');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);

    const flipped = renderContract({ ...INPUT, order: 'deprecated-first' });
    expect(flipped.indexOf('.Health = 25')).toBeLessThan(flipped.indexOf('.MaxHealth = 100'));
  });

  it('records where the claim came from in the generated file', () => {
    const contract = renderContract(INPUT);
    expect(contract).toContain(SOURCE.url);
    expect(contract).toContain('fetched via fixture');
    expect(contract).toContain(SOURCE.evidence);
  });
});

describe('the note handed to the model', () => {
  const note = curriculumNote({
    className: 'Humanoid',
    member: 'Health',
    replacement: 'MaxHealth',
    source: { url: SOURCE.url, via: 'fixture' },
  });

  it('names the replacement, which is the whole reason to attach it', () => {
    expect(note).toContain('Humanoid.MaxHealth');
  });

  it('claims only what the engine established', () => {
    // The engine can confirm the members exist. It cannot confirm the page is
    // right that one is deprecated, and the note must not imply otherwise.
    expect(note).toContain('reported deprecated');
    expect(note).toContain('cannot confirm the deprecation');
  });
});

describe('refusing to generate', () => {
  it('drops a claim the engine could not build a separable world for', () => {
    const input = generatorInputFor({
      item: confirmedItem(),
      separability: separable({ separable: false, order: null }),
      source: SOURCE,
    });
    expect(input).toBeNull();
  });

  it('drops a claim the engine never confirmed', () => {
    const item = confirmedItem();
    const rejected: CurriculumItem = {
      record: item.record,
      verdict: 'no-such-replacement',
      detail: 'Humanoid.CollisionSignal does not resolve',
    };
    expect(generatorInputFor({ item: rejected, separability: separable(), source: SOURCE })).toBeNull();
  });

  it('carries the measured assignment order through to the generator', () => {
    const input = generatorInputFor({
      item: confirmedItem(),
      separability: separable({ order: 'deprecated-first' }),
      source: SOURCE,
    });
    expect(input?.order).toBe('deprecated-first');
  });
});

describe('the shortcuts the contract is checked against', () => {
  const shortcuts = renderShortcuts(INPUT);

  it('emits both routes to passing without reading the member', () => {
    expect(shortcuts.map(shortcut => shortcut.name)).toEqual([
      'hardcoded-increment',
      'preset-at-startup',
    ]);
  });

  it('never reads the replacement, or it would be a correct implementation', () => {
    for (const shortcut of shortcuts) {
      expect(shortcut.luau).not.toContain('MaxHealth');
    }
  });

  it('quotes the delta the requirement states, which is the whole temptation', () => {
    expect(shortcuts[0]?.luau).toContain('+ 75');
    expect(shortcuts[0]?.luau).toContain('+ 50');
  });

  it('makes the preset skip the interaction entirely', () => {
    // The reward-hack signature: right final state, no causal link to the
    // signal. It must not connect to anything.
    expect(shortcuts[1]?.luau).not.toContain('Connect');
    expect(shortcuts[1]?.luau).toContain('SetAttribute("Value", 100)');
  });
});

describe('the statistic the arm comparison is reported with', () => {
  // Checked against the standard published values rather than against another
  // run of the same code, because a test that agrees with its own implementation
  // establishes nothing about whether the number is the one it claims to be.
  it('reproduces Fisher’s tea-tasting table', () => {
    expect(fisherExact(3, 1, 1, 3)).toBeCloseTo(0.4857142857, 9);
  });

  it('gives 1 when the two arms are identical', () => {
    expect(fisherExact(8, 8, 8, 8)).toBeCloseTo(1, 9);
  });

  it('is small only when the separation is complete', () => {
    expect(fisherExact(10, 0, 0, 10)).toBeCloseTo(1.082508822e-5, 12);
  });

  it('does not mistake a dozen-draw difference for a finding', () => {
    // 12/16 against 8/16 — the shape of one round of this measurement. The
    // effect is real-looking and the test says it is not yet distinguishable
    // from chance, which is the point of reporting it.
    expect(fisherExact(12, 4, 8, 8)).toBeCloseTo(0.2733697667, 9);
  });
});

function writeGeneratedTaskInTemp(): { taskPath: string; contractPath: string } {
  return writeGeneratedTask(mkdtempSync(join(tmpdir(), 'placebo-curriculum-')), INPUT);
}
