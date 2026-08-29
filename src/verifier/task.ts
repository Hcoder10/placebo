import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { loadContract, type Contract } from './contract.js';

/**
 * A task is what you actually ask an agent to do.
 *
 * Three modes, one mechanism:
 *
 *   build   — nothing exists yet. Write the mechanic from scratch and prove the
 *             interaction causes the behaviour.
 *   extend  — something works. Add a new behaviour, and keep the old ones.
 *   repair  — something is broken. Fix it without breaking its neighbours.
 *
 * The only structural difference between them is which contracts must hold and
 * what the starting implementation is. `extend` is the interesting one: a patch
 * that satisfies the new contract while breaking an existing one is a
 * regression, and the causal verifier already measures the old contracts, so
 * detecting that costs nothing extra.
 */

export const TaskSchema = z
  .object({
    id: z.string().min(1),
    mode: z.enum(['build', 'extend', 'repair']),
    /** What the agent is being asked for, in one line. */
    goal: z.string().min(1),
    /**
     * Luau that builds the world every contract shares.
     *
     * Contracts in a multi-contract task must run against the *same* world, or
     * a patch written for one would fail to resolve instances in another. A
     * contract may still carry its own setup for standalone use; the task's
     * wins when both are present.
     */
    setup: z.string().min(1),
    /**
     * The implementation the agent starts from.
     *
     * Empty for `build`. For `extend` it is the working mechanic that must
     * survive. For `repair` it is the defective one.
     */
    baseline: z.string().default(''),
    /** Contract files, relative to the task file. */
    contracts: z.array(z.string().min(1)).min(1),
    /**
     * Contracts that already hold before the agent touches anything.
     *
     * These define the regression set. A patch that breaks one of them has made
     * the project worse, however well it satisfies the new requirement.
     */
    already_satisfied: z.array(z.string()).default([]),
  })
  .strict();

export type Task = z.infer<typeof TaskSchema>;

export interface LoadedTask {
  task: Task;
  /** Contracts with the task's shared setup applied. */
  contracts: Contract[];
}

export function loadTask(path: string): LoadedTask {
  const parsed = TaskSchema.safeParse(parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(
      `invalid task at ${path}:\n${parsed.error.issues
        .map(issue => `  ${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('\n')}`,
    );
  }

  const task = parsed.data;
  const base = dirname(path);

  const contracts = task.contracts.map(relative => {
    const contract = loadContract(join(base, relative));
    // The task owns the world so every contract sees the same instances.
    return { ...contract, setup: task.setup };
  });

  const known = new Set(contracts.map(contract => contract.id));
  const unknown = task.already_satisfied.filter(id => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`task ${task.id}: already_satisfied names unknown contracts: ${unknown.join(', ')}`);
  }

  return { task, contracts };
}
