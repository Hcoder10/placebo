import type { Contract } from './contract.js';
import { evaluate, type Verdict } from './effect.js';
import type { StudioSession } from './studio.js';
import type { Task } from './task.js';

/**
 * Scores one candidate against every contract in a task.
 *
 * The interesting output is not "did the new requirement pass" — it is the
 * relationship between the new requirement and the ones that already held. A
 * patch that adds a door and silently stops the coin awarding has not extended
 * the game, it has traded one behaviour for another, and only running the old
 * contracts catches that.
 */

export interface ContractOutcome {
  contractId: string;
  requirement: string;
  /** True when this contract was already satisfied before the agent started. */
  wasSatisfied: boolean;
  verdict: Verdict;
}

export interface TaskResult {
  taskId: string;
  mode: Task['mode'];
  /** Contracts the task set out to satisfy that now hold. */
  gained: string[];
  /** Contracts the task set out to satisfy that still do not hold. */
  outstanding: string[];
  /** Contracts that held before and no longer do. The regression set. */
  regressed: string[];
  /** Contracts that held before and still hold. */
  preserved: string[];
  outcomes: ContractOutcome[];
  /**
   * Accepted only when every target contract holds and nothing regressed.
   *
   * Ordering matters here and is deliberate: a patch that gains a behaviour at
   * the cost of an existing one is rejected, not scored as a partial win.
   */
  accepted: boolean;
  /** Total engine runs this candidate cost, as a cost signal for ranking. */
  engineRuns: number;
}

export async function evaluateTask(params: {
  session: StudioSession;
  task: Task;
  contracts: Contract[];
  patchLuau: string;
}): Promise<TaskResult> {
  const { session, task, contracts, patchLuau } = params;

  const outcomes: ContractOutcome[] = [];
  let engineRuns = 0;

  for (const contract of contracts) {
    const verdict = await evaluate({ session, contract, patchLuau });
    engineRuns += verdict.realizations * (1 + contract.controls.length);
    outcomes.push({
      contractId: contract.id,
      requirement: contract.requirement,
      wasSatisfied: task.already_satisfied.includes(contract.id),
      verdict,
    });
  }

  const gained = outcomes
    .filter(o => !o.wasSatisfied && o.verdict.accepted)
    .map(o => o.contractId);
  const outstanding = outcomes
    .filter(o => !o.wasSatisfied && !o.verdict.accepted)
    .map(o => o.contractId);
  const regressed = outcomes
    .filter(o => o.wasSatisfied && !o.verdict.accepted)
    .map(o => o.contractId);
  const preserved = outcomes
    .filter(o => o.wasSatisfied && o.verdict.accepted)
    .map(o => o.contractId);

  return {
    taskId: task.id,
    mode: task.mode,
    gained,
    outstanding,
    regressed,
    preserved,
    outcomes,
    accepted: outstanding.length === 0 && regressed.length === 0,
    engineRuns,
  };
}

/**
 * Ranks candidates lexicographically rather than by a single blended score.
 *
 * A blended score is hackable: enough of one term buys away a failure in
 * another. Strict precedence is not — a candidate that regressed an existing
 * behaviour cannot outrank one that did not, no matter how small its patch is.
 */
export function rankCandidates<T extends { result: TaskResult; patchBytes: number }>(
  candidates: T[],
): T[] {
  return [...candidates].sort((a, b) => {
    const A = a.result;
    const B = b.result;

    // 1. no regressions
    if (A.regressed.length !== B.regressed.length) return A.regressed.length - B.regressed.length;
    // 2. more of the target behaviours gained
    if (A.gained.length !== B.gained.length) return B.gained.length - A.gained.length;
    // 3. stable across realizations
    const stable = (r: TaskResult) => r.outcomes.filter(o => o.verdict.stable).length;
    if (stable(A) !== stable(B)) return stable(B) - stable(A);
    // 4. smaller patch
    if (a.patchBytes !== b.patchBytes) return a.patchBytes - b.patchBytes;
    // 5. cheaper to reach
    return A.engineRuns - B.engineRuns;
  });
}

/**
 * Checks that the task's baseline actually satisfies what it claims.
 *
 * `already_satisfied` defines the regression set, so if the baseline does not
 * really satisfy those contracts the whole notion of "this candidate broke
 * something" is fiction — every candidate will look like it regressed, and the
 * ranking will be meaningless. This caught exactly that on the first extend
 * task written: the declared baseline had no guard and never satisfied the
 * contract it claimed.
 *
 * Verifying it costs one extra pass and turns a silent wrong answer into a
 * loud, specific one.
 */
export async function verifyBaseline(params: {
  session: StudioSession;
  task: Task;
  contracts: Contract[];
}): Promise<{ ok: boolean; problems: string[]; result: TaskResult }> {
  const { session, task, contracts } = params;
  const result = await evaluateTask({ ...params, patchLuau: task.baseline });

  const problems: string[] = [];
  for (const id of task.already_satisfied) {
    const outcome = result.outcomes.find(o => o.contractId === id);
    if (!outcome) {
      problems.push(`${id}: named in already_satisfied but not among the task's contracts`);
    } else if (!outcome.verdict.accepted) {
      const why = outcome.verdict.inert
        ? 'the baseline has no causal effect'
        : [
            outcome.verdict.missing.length ? `missing ${outcome.verdict.missing.join(',')}` : '',
            outcome.verdict.collateral.length ? `collateral ${outcome.verdict.collateral.join(',')}` : '',
          ]
            .filter(Boolean)
            .join('; ');
      problems.push(`${id}: declared already satisfied, but the baseline does not satisfy it (${why})`);
    }
  }

  // The converse is also worth knowing: a target contract the baseline already
  // satisfies means the task asks for something that is already true.
  for (const outcome of result.outcomes) {
    if (!task.already_satisfied.includes(outcome.contractId) && outcome.verdict.accepted) {
      problems.push(
        `${outcome.contractId}: listed as a goal, but the baseline already satisfies it — there is nothing to do`,
      );
    }
  }

  return { ok: problems.length === 0, problems, result };
}
