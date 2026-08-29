import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * A behavioural contract: a requirement written as an intervention and its effects.
 *
 * Deliberately not a list of assertions about a final state. It names a
 * treatment, one or more matched controls, and the effects the treatment is
 * supposed to *cause*. Scoring compares the two, so a patch that produces the
 * right end state without the interaction causing it scores zero.
 */

const ExpectedEffectSchema = z
  .object({
    key: z.string().min(1),
    /** `+1` / `-2` for a numeric move, or `true->false` for a transition. */
    change: z.string().regex(/^([+-]\d+(\.\d+)?|\w+\s*->\s*\w+)$/, 'expected "+1" or "true->false"'),
  })
  .strict();

const ControlSchema = z
  .object({
    name: z.string().min(1),
    /** Luau executed in place of the treatment. */
    steps: z.string().min(1),
  })
  .strict();

export const ContractSchema = z
  .object({
    id: z.string().min(1),
    requirement: z.string().min(1),
    /** Luau that builds the world for one branch, from nothing. */
    setup: z.string().min(1),
    /** Luau for the intervention under test. */
    treatment: z.string().min(1),
    controls: z.array(ControlSchema).min(1, 'a contract without a matched control is a unit test'),
    effects: z.array(ExpectedEffectSchema).min(1),
    /** Keys that must be identical under treatment and control. */
    non_effects: z.array(z.string()).default([]),
    /**
     * Realizations of the interaction schedule. Each is passed to the contract
     * as `REALIZATION`, so a contract can vary event timing or ordering and a
     * required effect must hold under all of them.
     */
    realizations: z.array(z.number().int()).default([1]),
  })
  .strict();

export type Contract = z.infer<typeof ContractSchema>;
export type ExpectedEffect = z.infer<typeof ExpectedEffectSchema>;

export function loadContract(path: string): Contract {
  const parsed = ContractSchema.safeParse(parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(
      `invalid contract at ${path}:\n${parsed.error.issues
        .map(issue => `  ${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  return parsed.data;
}

const DELTA = /^([+-]\d+(?:\.\d+)?)$/;
const TRANSITION = /^(\w+)\s*->\s*(\w+)$/;

/** Normalises a state value into the vocabulary contracts are written in. */
function token(value: unknown): string {
  if (value === null || value === undefined) return 'false';
  if (value === true) return 'true';
  if (value === false) return 'false';
  return String(value).toLowerCase();
}

export function effectMatches(effect: ExpectedEffect, before: unknown, after: unknown): boolean {
  const delta = DELTA.exec(effect.change);
  if (delta?.[1]) {
    const want = Number.parseFloat(delta[1]);
    const from = Number(before ?? 0);
    const to = Number(after ?? 0);
    if (Number.isNaN(from) || Number.isNaN(to)) return false;
    return to - from === want;
  }

  const transition = TRANSITION.exec(effect.change);
  if (transition?.[1] && transition[2]) {
    return token(before) === transition[1].toLowerCase() && token(after) === transition[2].toLowerCase();
  }

  return false;
}
