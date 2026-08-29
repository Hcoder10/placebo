import type { Contract } from './contract.js';
import { evaluate } from './effect.js';
import type { StudioSession } from './studio.js';

/**
 * Is this contract worth anything?
 *
 * The moment a model is allowed to draft its own contracts, causal verification
 * risks becoming a model grading its own homework: write a requirement you
 * already satisfy, satisfy it, declare success. That failure is not hypothetical
 * — it is the obvious strategy.
 *
 * Two mechanical checks close most of it, and neither needs a judge model:
 *
 *   **Triviality.** Run the contract against an empty implementation. If the
 *   effects still appear, the contract is describing the world rather than the
 *   code, and any patch would "pass" it.
 *
 *   **Control separation.** A control must be capable of *not* producing the
 *   effect. If treatment and control are indistinguishable even for a correct
 *   implementation, the contract cannot discriminate and is measuring nothing.
 *
 * What this does NOT check is whether the contract describes the game the human
 * actually wanted. Nothing mechanical can. That judgement stays with a person,
 * which is why drafted contracts are presented for approval rather than adopted.
 */

export interface ContractAudit {
  contractId: string;
  usable: boolean;
  /** Effects that appear even with no implementation at all. */
  trivialEffects: string[];
  problems: string[];
  notes: string[];
}

/** An implementation that does nothing, used to expose contracts that need none. */
const EMPTY_PATCH = '-- deliberately empty: nothing should satisfy a contract by itself';

export async function auditContract(params: {
  session: StudioSession;
  contract: Contract;
  /**
   * An implementation believed to satisfy the contract, when one exists.
   *
   * Supplying it enables the stronger check: a contract that rejects a genuinely
   * correct implementation is broken in the opposite direction, and that is
   * worth catching before it trains anything.
   */
  reference?: string;
}): Promise<ContractAudit> {
  const { session, contract, reference } = params;
  const problems: string[] = [];
  const notes: string[] = [];

  // 1. Triviality: with no code, the effects must not happen.
  const empty = await evaluate({ session, contract, patchLuau: EMPTY_PATCH });

  const trivialEffects = empty.error ? [] : empty.satisfied;
  if (empty.error) {
    problems.push(`could not run the contract against an empty implementation: ${empty.error}`);
  } else if (trivialEffects.length > 0) {
    problems.push(
      `satisfied with no implementation at all (${trivialEffects.join(', ')}) — the contract describes the world, not the code`,
    );
  } else {
    notes.push('non-trivial: an empty implementation does not satisfy it');
  }

  // 2. The contract must be able to fail for a reason it can articulate.
  if (contract.effects.length === 0) {
    problems.push('declares no effects, so there is nothing for a patch to cause');
  }
  if (contract.controls.length === 0) {
    problems.push('has no matched control, so it can only assert final state');
  }

  // 3. If a reference implementation is offered, the contract must accept it.
  if (reference) {
    const good = await evaluate({ session, contract, patchLuau: reference });
    if (good.error) {
      problems.push(`the reference implementation could not be evaluated: ${good.error}`);
    } else if (!good.accepted) {
      problems.push(
        `rejects a reference implementation believed correct (missing ${JSON.stringify(good.missing)}, collateral ${JSON.stringify(good.collateral)}) — the contract is too strict or its treatment does not provoke the behaviour`,
      );
    } else {
      notes.push('accepts a reference implementation');
      if (!good.stable) {
        notes.push('the reference passes but is timing-dependent across realizations');
      }
    }
  } else {
    notes.push('no reference implementation supplied; only triviality was checked');
  }

  return {
    contractId: contract.id,
    usable: problems.length === 0,
    trivialEffects,
    problems,
    notes,
  };
}
