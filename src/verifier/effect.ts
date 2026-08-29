import { effectMatches, type Contract } from './contract.js';
import type { StateVector, StudioSession } from './studio.js';

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
  /** True when the treatment changed nothing at all — the reward-hack signature. */
  inert: boolean;
  realizations: number;
  /** False when realizations disagreed: the patch is timing-dependent. */
  stable: boolean;
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
): Promise<StateVector> {
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

  try {
    for (const realization of contract.realizations) {
      const treatment = await runCondition(session, contract, patchLuau, contract.treatment, realization);

      // An effect must survive every control, so a patch cannot pass by beating
      // only the most permissive one.
      let common: Record<string, [unknown, unknown]> | null = null;
      for (const control of contract.controls) {
        const controlState = await runCondition(session, contract, patchLuau, control.steps, realization);
        const observed = delta(controlState, treatment);
        common =
          common === null
            ? observed
            : Object.fromEntries(Object.entries(common).filter(([key]) => key in observed));
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
      inert: false,
      realizations: 0,
      stable: false,
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
    accepted: missing.length === 0 && collateral.length === 0,
    satisfied,
    missing,
    collateral,
    observed: Object.fromEntries(
      Object.entries(first).map(([key, [before, after]]) => [
        key,
        `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
      ]),
    ),
    inert: perRealization.every(observed => Object.keys(observed).length === 0),
    realizations: perRealization.length,
    stable: signatures.size === 1,
  };
}
