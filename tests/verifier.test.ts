import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { scorePrediction, type Branch } from '../src/mcp/runstate.js';
import { ContractSchema, effectMatches, loadContract } from '../src/verifier/contract.js';
import { delta, type Verdict } from '../src/verifier/effect.js';

const CONTRACT_PATH = join(import.meta.dirname, '..', 'contracts', 'coin_awards_once.yaml');

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    accepted: false,
    satisfied: [],
    missing: [],
    collateral: [],
    observed: {},
    observedAll: [],
    inert: false,
    realizations: 1,
    stable: true,
    isolated: true,
    settled: true,
    droppedByControlDisagreement: [],
    ...overrides,
  };
}

function branch(overrides: Partial<Branch> = {}): Branch {
  return { id: 'b', engineRuns: 0, createdAt: new Date().toISOString(), ...overrides };
}

describe('expected effects', () => {
  it('matches a numeric delta regardless of the absolute values', () => {
    const effect = { key: 'Scoreboard.@Coins', change: '+1' };
    expect(effectMatches(effect, 0, 1)).toBe(true);
    expect(effectMatches(effect, 7, 8)).toBe(true);
    expect(effectMatches(effect, 0, 2)).toBe(false);
    expect(effectMatches(effect, 1, 0)).toBe(false);
  });

  it('treats a vanished instance as a transition to false', () => {
    const effect = { key: 'exists:Coin', change: 'true->false' };
    expect(effectMatches(effect, true, undefined)).toBe(true);
    expect(effectMatches(effect, true, null)).toBe(true);
    expect(effectMatches(effect, true, true)).toBe(false);
  });

  it('does not treat a missing baseline as zero for a decrement', () => {
    // undefined -> 0 must not read as "-1" just because absence coerces to 0.
    expect(effectMatches({ key: 'k', change: '-1' }, undefined, 0)).toBe(false);
  });
});

describe('state delta', () => {
  it('reports only keys that differ between control and treatment', () => {
    const observed = delta({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 });
    expect(Object.keys(observed).sort()).toEqual(['b', 'c']);
    expect(observed.b).toEqual([2, 3]);
    expect(observed.c).toEqual([undefined, 4]);
  });

  it('is empty when the two worlds are identical — the reward-hack signature', () => {
    expect(delta({ a: 1, 'exists:Coin': true }, { a: 1, 'exists:Coin': true })).toEqual({});
  });
});

describe('contract validation', () => {
  it('loads the shipped contract', () => {
    const contract = loadContract(CONTRACT_PATH);
    expect(contract.id).toBe('coin_awards_once');
    expect(contract.controls.length).toBeGreaterThanOrEqual(1);
    expect(contract.realizations.length).toBeGreaterThan(1);
  });

  it('refuses a contract with no matched control', () => {
    // A contract without a control is a unit test wearing a costume: it can
    // only assert final state, which is exactly what this project exists to
    // stop relying on.
    const parsed = ContractSchema.safeParse({
      id: 'x',
      requirement: 'y',
      setup: 'local a = 1',
      treatment: 'local b = 1',
      controls: [],
      effects: [{ key: 'k', change: '+1' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses an unparseable expected change', () => {
    const parsed = ContractSchema.safeParse({
      id: 'x',
      requirement: 'y',
      setup: 'local a = 1',
      treatment: 'local b = 1',
      controls: [{ name: 'c', steps: 'local c = 1' }],
      effects: [{ key: 'k', change: 'sort of increases' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown top-level keys rather than ignoring them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'placebo-contract-'));
    const path = join(dir, 'c.yaml');
    writeFileSync(
      path,
      [
        'id: x',
        'requirement: y',
        'setup: "local a = 1"',
        'treatment: "local b = 1"',
        'controls: [{name: c, steps: "local c = 1"}]',
        'effects: [{key: k, change: "+1"}]',
        'realisations: [1, 2]', // misspelled; must not be silently dropped
      ].join('\n'),
      'utf8',
    );
    expect(() => loadContract(path)).toThrow();
  });
});

describe('prediction scoring', () => {
  it('credits a prediction that matches the engine', () => {
    // The contract vocabulary has to be supplied: a key is only a legitimate
    // thing to predict if the engine reported it or the contract is about it.
    const scored = scorePrediction(
      branch({
        prediction: { effects: { 'S.@Coins': '+1' }, unchanged: ['O.@Coins'], at: '' },
        verdict: verdict({ observed: { 'S.@Coins': '0 -> 1' }, observedAll: [{ 'S.@Coins': '0 -> 1' }] }),
      }),
      ['S.@Coins', 'O.@Coins'],
    );
    expect(scored.correct).toBe(2);
    expect(scored.total).toBe(2);
    expect(scored.invalidKeys).toEqual([]);
  });

  it('accepts "0 -> 1" and "+1" as the same claim', () => {
    const scored = scorePrediction(
      branch({
        prediction: { effects: { k: '0 -> 1' }, unchanged: [], at: '' },
        verdict: verdict({ observed: { k: '0 -> 1' }, observedAll: [{ k: '0 -> 1' }] }),
      }),
      ['k'],
    );
    expect(scored.correct).toBe(1);
  });

  it('fails a claim that only holds in the first realization', () => {
    // "missing debounce" awards +1 the first time and more on repetition. A
    // prediction judged on realization 1 alone would look correct.
    const scored = scorePrediction(
      branch({
        prediction: { effects: { 'S.@Coins': '+1' }, unchanged: [], at: '' },
        verdict: verdict({
          observed: { 'S.@Coins': '0 -> 1' },
          observedAll: [{ 'S.@Coins': '0 -> 1' }, { 'S.@Coins': '0 -> 2' }],
          stable: false,
        }),
      }),
    );
    expect(scored.correct).toBe(0);
    expect(scored.wrong[0]).toContain('0 -> 1 | 0 -> 2');
  });

  it('penalises predicting movement that never happened — the inert case', () => {
    const scored = scorePrediction(
      branch({
        prediction: {
          effects: { 'S.@Coins': '+1', 'exists:Coin': 'true->false' },
          unchanged: [],
          at: '',
        },
        verdict: verdict({ observed: {}, observedAll: [{}], inert: true }),
      }),
    );
    expect(scored.correct).toBe(0);
    expect(scored.total).toBe(2);
  });

  it('penalises a key the agent said would not move', () => {
    const scored = scorePrediction(
      branch({
        prediction: { effects: {}, unchanged: ['O.@Coins'], at: '' },
        verdict: verdict({
          observed: { 'O.@Coins': '0 -> 1' },
          observedAll: [{ 'O.@Coins': '0 -> 1' }],
        }),
      }),
    );
    expect(scored.correct).toBe(0);
    expect(scored.wrong[0]).toContain('said unchanged');
  });

  it('reports nothing until both a prediction and a verdict exist', () => {
    expect(scorePrediction(branch()).scored).toBe(false);
    expect(scorePrediction(branch({ verdict: verdict() })).scored).toBe(false);
  });

  it('does not credit a predicted key that is not part of the state vocabulary', () => {
    // Found by auditing a real model's output: a branch predicted
    // unchanged: ["sandbox.Coin"], which is not a state key. An invented key is
    // absent from every diff, so under naive scoring it always counted correct.
    const scored = scorePrediction(
      branch({
        prediction: { effects: {}, unchanged: ['sandbox.Coin'], at: '' },
        verdict: verdict({ observed: {}, observedAll: [{}] }),
      }),
      ['Scoreboard.@Coins', 'exists:Coin'],
    );
    expect(scored.correct).toBe(0);
    expect(scored.invalidKeys).toEqual(['sandbox.Coin']);
  });

  it('penalises an effect the engine caused that the prediction never mentioned', () => {
    // The other farmable case: predict one easy effect, stay silent about the
    // rest, and score 100%.
    const scored = scorePrediction(
      branch({
        prediction: { effects: { 'Scoreboard.@Coins': '+1' }, unchanged: [], at: '' },
        verdict: verdict({
          observed: { 'Scoreboard.@Coins': '0 -> 1', 'exists:Coin': 'true -> undefined' },
          observedAll: [{ 'Scoreboard.@Coins': '0 -> 1', 'exists:Coin': 'true -> undefined' }],
        }),
      }),
      ['Scoreboard.@Coins', 'exists:Coin'],
    );
    expect(scored.correct).toBe(1);
    expect(scored.total).toBe(2);
    expect(scored.missed).toEqual(['exists:Coin']);
  });

  it('still scores a complete, accurate prediction perfectly', () => {
    const scored = scorePrediction(
      branch({
        prediction: {
          effects: { 'Scoreboard.@Coins': '+1', 'exists:Coin': 'true->false' },
          unchanged: [],
          at: '',
        },
        verdict: verdict({
          observed: { 'Scoreboard.@Coins': '0 -> 1', 'exists:Coin': 'true -> undefined' },
          observedAll: [{ 'Scoreboard.@Coins': '0 -> 1', 'exists:Coin': 'true -> undefined' }],
        }),
      }),
      ['Scoreboard.@Coins', 'exists:Coin'],
    );
    expect(scored.correct).toBe(2);
    expect(scored.total).toBe(2);
    expect(scored.missed).toEqual([]);
  });

  it('flags whether the score was earned on a failing patch', () => {
    const onFailing = scorePrediction(
      branch({
        prediction: { effects: {}, unchanged: [], at: '' },
        verdict: verdict({ accepted: false, observedAll: [{}] }),
      }),
    );
    expect(onFailing.onFailingPatch).toBe(true);
  });
});

describe('change formats a model actually writes', () => {
  const parse = (change: string) =>
    ContractSchema.shape.effects.element.shape.change.safeParse(change).success;

  it('accepts the forms that were being rejected', () => {
    // Every one of these was refused with
    // `effects.0.change: expected "+1" or "true->false"` while meaning exactly
    // what it looks like.
    expect(parse('"locked"->"unlocked"')).toBe(true);
    expect(parse('100->90')).toBe(true);
    expect(parse('+ 1')).toBe(true);
    expect(parse('1.5->2.5')).toBe(true);
    expect(parse('nil->Part')).toBe(true);
  });

  it('still accepts the original forms', () => {
    expect(parse('+1')).toBe(true);
    expect(parse('-10')).toBe(true);
    expect(parse('true->false')).toBe(true);
    expect(parse('true -> false')).toBe(true);
  });

  it('still refuses the ambiguous ones', () => {
    // A bare unsigned number could mean "increases by one" or "ends up as
    // one". Guessing would silently score the wrong thing, so it stays
    // refused -- a rejected contract is recoverable, a misread one is not.
    expect(parse('1')).toBe(false);
    expect(parse('increases by one')).toBe(false);
    expect(parse('')).toBe(false);
    expect(parse('->false')).toBe(false);
  });

  it('matches quoted and unquoted state identically', () => {
    const effect = { key: 'Chest.@State', change: '"locked"->"unlocked"' };
    expect(effectMatches(effect, 'locked', 'unlocked')).toBe(true);
    expect(effectMatches(effect, '"locked"', '"unlocked"')).toBe(true);
    expect(effectMatches(effect, 'locked', 'locked')).toBe(false);
  });

  it('reads a delta whose sign is separated from its digits', () => {
    expect(effectMatches({ key: 'S.@P', change: '+ 1' }, 0, 1)).toBe(true);
    expect(effectMatches({ key: 'S.@P', change: '+ 1' }, 0, 2)).toBe(false);
  });
});
