import { effectMatches, type Contract } from './contract.js';
import type { ConditionResult, StateVector, StudioSession } from './studio.js';

/**
 * Scoring a candidate patch by what it *caused*.
 *
 * For each realization:
 *     build a fresh world -> apply the patch -> run the treatment  -> state_t
 *     build a fresh world -> apply the patch -> run each control   -> state_c
 *     effect = state_t - state_c
 *
 * Comparing against a matched control rather than against the pre-state is the
 * whole point. A patch that awards the coin at startup moves the world exactly
 * as much with the interaction as without it, so its causal effect is empty and
 * it fails — even though its final state satisfies a naive assertion.
 */

export interface Verdict {
  accepted: boolean;
  /** Required effects the patch actually caused, under every realization. */
  satisfied: string[];
  /** Required effects that did not hold. */
  missing: string[];
  /** Keys the contract said must not move, that moved anyway. */
  collateral: string[];
  /** What the treatment changed relative to control, for display. */
  observed: Record<string, string>;
  /**
   * The same diff for every realization.
   *
   * A prediction judged against realization 1 alone lets a timing-dependent
   * patch look well-understood: "missing debounce" awards exactly +1 the first
   * time and only misbehaves under repetition. Scoring across all of them holds
   * a prediction to the same standard as a required effect.
   */
  observedAll: Record<string, string>[];
  /** True when the treatment changed nothing at all — the reward-hack signature. */
  inert: boolean;
  realizations: number;
  /** False when realizations disagreed: the patch is timing-dependent. */
  stable: boolean;
  /**
   * False when treatment and control did not start from the same world.
   *
   * Rebuilding the sandbox does not reset everything a patch can touch: a
   * connection to a service, a spawned task, or a global survives the folder
   * being destroyed. Rather than asserting isolation, this measures it — the
   * pre-interaction states of every condition must match, or the comparison
   * between them is meaningless and the verdict is withheld.
   */
  isolated: boolean;
  /** Conditions whose world stopped changing before the round limit. */
  settled: boolean;
  /**
   * Effects dropped because the controls disagreed about them.
   *
   * Silently discarding these would let a badly matched control erase a real
   * effect, so they are surfaced as a contract-design problem instead.
   */
  droppedByControlDisagreement: string[];
  error?: string;
}

/** Keys whose value differs between the control world and the treatment world. */
export function delta(control: StateVector, treatment: StateVector): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const key of [...new Set([...Object.keys(control), ...Object.keys(treatment)])].sort()) {
    const before = control[key];
    const after = treatment[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      out[key] = [before, after];
    }
  }
  return out;
}

async function runCondition(
  session: StudioSession,
  contract: Contract,
  patchLuau: string,
  interaction: string,
  realization: number,
): Promise<ConditionResult> {
  return session.runCondition({
    setup: contract.setup,
    patch: patchLuau,
    interaction,
    realization,
  });
}

export async function evaluate(params: {
  session: StudioSession;
  contract: Contract;
  patchLuau: string;
}): Promise<Verdict> {
  const { session, contract, patchLuau } = params;

  const perRealization: Record<string, [unknown, unknown]>[] = [];
  const dropped = new Set<string>();
  let isolated = true;
  let settled = true;

  try {
    for (const realization of contract.realizations) {
      const treatmentRun = await runCondition(session, contract, patchLuau, contract.treatment, realization);
      const treatment = treatmentRun.post;
      settled &&= treatmentRun.settled;

      // An effect must survive every control, so a patch cannot pass by beating
      // only the most permissive one.
      //
      // Agreement is on the (before, after) pair, not just the key. Two controls
      // that both show "Coins moved" but disagree about the baseline do not
      // establish a well-defined effect — keeping the key and taking the first
      // control's values would silently report one arbitrary control's view as
      // the causal effect.
      let common: Record<string, [unknown, unknown]> | null = null;
      for (const control of contract.controls) {
        const controlRun = await runCondition(session, contract, patchLuau, control.steps, realization);
        settled &&= controlRun.settled;

        // The integrity check: both conditions must have begun identically.
        if (JSON.stringify(controlRun.pre) !== JSON.stringify(treatmentRun.pre)) {
          isolated = false;
        }

        const observed = delta(controlRun.post, treatment);
        if (common === null) {
          common = observed;
          continue;
        }
        const agreed: Record<string, [unknown, unknown]> = {};
        for (const [key, pair] of Object.entries(common)) {
          if (key in observed && JSON.stringify(observed[key]) === JSON.stringify(pair)) {
            agreed[key] = pair;
          } else if (key in observed) {
            dropped.add(key);
          }
        }
        common = agreed;
      }
      perRealization.push(common ?? {});
    }
  } catch (error) {
    return {
      accepted: false,
      satisfied: [],
      missing: contract.effects.map(effect => effect.key),
      collateral: [],
      observed: {},
      observedAll: [],
      inert: false,
      realizations: 0,
      stable: false,
      isolated: false,
      settled: false,
      droppedByControlDisagreement: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const first = perRealization[0] ?? {};

  const satisfied: string[] = [];
  const missing: string[] = [];
  for (const expected of contract.effects) {
    // A required effect must hold under EVERY realization. A patch that works
    // only when events arrive in a friendly order has not implemented the
    // requirement, it has been lucky.
    const holds = perRealization.every(observed => {
      const pair = observed[expected.key];
      return pair !== undefined && effectMatches(expected, pair[0], pair[1]);
    });
    (holds ? satisfied : missing).push(expected.key);
  }

  const collateral = [
    ...new Set(
      perRealization.flatMap(observed => contract.non_effects.filter(key => key in observed)),
    ),
  ].sort();

  const signatures = new Set(
    perRealization.map(observed =>
      [...contract.effects.map(effect => effect.key), ...contract.non_effects]
        .map(key => `${key}=${JSON.stringify(observed[key])}`)
        .join('|'),
    ),
  );

  return {
    // A verdict is only meaningful if the conditions were comparable and the
    // world had stopped moving when we looked at it.
    accepted: missing.length === 0 && collateral.length === 0 && isolated && settled,
    satisfied,
    missing,
    collateral,
    observed: renderDiff(first),
    observedAll: perRealization.map(renderDiff),
    inert: perRealization.every(observed => Object.keys(observed).length === 0),
    realizations: perRealization.length,
    stable: signatures.size === 1,
    isolated,
    settled,
    droppedByControlDisagreement: [...dropped].sort(),
  };
}

/**
 * Human- and comparison-friendly rendering of one realization's diff.
 *
 * Property keys belonging to an instance that stopped existing are dropped.
 * Destroying a part vanishes every property it had, so a single destruction
 * arrives as `exists:Coin`, `Coin.Anchored`, `Coin.CanCollide` and
 * `Coin.Transparency` — one event reported four times. That inflates apparent
 * effect size and, worse, buries a genuine collateral change among derived
 * noise. The existence key already carries the information.
 */
function renderDiff(observed: Record<string, [unknown, unknown]>): Record<string, string> {
  const destroyed = new Set(
    Object.entries(observed)
      .filter(([key, [, after]]) => key.startsWith('exists:') && (after === undefined || after === null))
      .map(([key]) => key.slice('exists:'.length)),
  );

  return Object.fromEntries(
    Object.entries(observed)
      .filter(([key]) => {
        const dot = key.indexOf('.');
        if (dot === -1) return true;
        return !destroyed.has(key.slice(0, dot));
      })
      .map(([key, [before, after]]) => [key, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`]),
  );
}
