import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Verdict } from '../verifier/effect.js';

/**
 * What happened during one experiment, held in memory and appended to disk.
 *
 * Shared by three readers with different needs: the MCP tools write to it, the
 * orchestrator ranks from it, and the console renders it. Keeping one structure
 * means the thing a human watches and the thing that scores the run cannot
 * drift apart.
 */

export interface Prediction {
  /** Effect keys the agent expects to move, and how. */
  effects: Record<string, string>;
  /** Keys the agent expects to stay put. */
  unchanged: string[];
  at: string;
}

export interface Branch {
  id: string;
  /** Harness thread that owns this branch, when it came from a subagent. */
  threadId?: string;
  patchLuau?: string;
  prediction?: Prediction;
  verdict?: Verdict;
  /** How many times this branch ran the engine. Cost, in the ablation sense. */
  engineRuns: number;
  createdAt: string;
}

export interface RunState {
  runId: string;
  contractId: string;
  status: 'idle' | 'running' | 'waiting' | 'done';
  headline: string;
  branches: Record<string, Branch>;
  /** Pending human approvals, keyed by tool call id. */
  pending: Record<string, { tool: string; args: Record<string, unknown>; requestedAt: string }>;
}

export class Run {
  readonly state: RunState;

  constructor(
    runId: string,
    contractId: string,
    private readonly logPath: string,
  ) {
    this.state = {
      runId,
      contractId,
      status: 'idle',
      headline: 'Idle',
      branches: {},
      pending: {},
    };
    mkdirSync(dirname(logPath), { recursive: true });
  }

  setStatus(status: RunState['status'], headline: string): void {
    this.state.status = status;
    this.state.headline = headline;
    this.append('status', { status, headline });
  }

  branch(id: string, threadId?: string): Branch {
    const existing = this.state.branches[id];
    if (existing) {
      if (threadId && !existing.threadId) existing.threadId = threadId;
      return existing;
    }
    const created: Branch = { id, threadId, engineRuns: 0, createdAt: new Date().toISOString() };
    this.state.branches[id] = created;
    this.append('branch.created', { id, threadId });
    return created;
  }

  recordPrediction(id: string, prediction: Prediction): void {
    this.branch(id).prediction = prediction;
    this.append('prediction', { id, prediction });
  }

  recordPatch(id: string, patchLuau: string): void {
    this.branch(id).patchLuau = patchLuau;
    this.append('patch', { id, bytes: patchLuau.length });
  }

  recordVerdict(id: string, verdict: Verdict): void {
    const branch = this.branch(id);
    branch.verdict = verdict;
    branch.engineRuns += verdict.realizations * 3; // treatment + two controls
    this.append('verdict', { id, accepted: verdict.accepted, stable: verdict.stable });
  }

  private append(kind: string, payload: Record<string, unknown>): void {
    appendFileSync(
      this.logPath,
      `${JSON.stringify({ at: new Date().toISOString(), runId: this.state.runId, kind, ...payload })}\n`,
      'utf8',
    );
  }
}

/**
 * Scores how well a branch predicted its *own* patch.
 *
 * Deliberately compared against what the engine observed, never against the
 * contract. A model that echoes the contract's desired effects back would score
 * perfectly while understanding nothing — the measurement only has content when
 * the patch is wrong, which is exactly when echoing gives the wrong answer.
 */
export function scorePrediction(branch: Branch): {
  scored: boolean;
  correct: number;
  total: number;
  wrong: string[];
  /** True when this branch's patch failed — where the metric actually bites. */
  onFailingPatch: boolean;
} {
  const { prediction, verdict } = branch;
  if (!prediction || !verdict) return { scored: false, correct: 0, total: 0, wrong: [], onFailingPatch: false };

  // Every realization, not just the first: a claim that only holds when events
  // arrive in a friendly order is not an understanding of the patch.
  const runs = verdict.observedAll.length > 0 ? verdict.observedAll : [verdict.observed];
  const wrong: string[] = [];
  let correct = 0;
  let total = 0;

  for (const [key, expected] of Object.entries(prediction.effects)) {
    total += 1;
    const actuals = runs.map(observed => observed[key]);
    const holds = actuals.every(
      actual => actual !== undefined && normalise(actual) === normalise(expected),
    );
    if (holds) {
      correct += 1;
    } else {
      const seen = [...new Set(actuals.map(actual => actual ?? 'no change'))].join(' | ');
      wrong.push(`${key}: said ${expected}, engine says ${seen}`);
    }
  }

  for (const key of prediction.unchanged) {
    total += 1;
    if (runs.every(observed => observed[key] === undefined)) {
      correct += 1;
    } else {
      const seen = [...new Set(runs.map(observed => observed[key]).filter(Boolean))].join(' | ');
      wrong.push(`${key}: said unchanged, engine says ${seen}`);
    }
  }

  return { scored: true, correct, total, wrong, onFailingPatch: !verdict.accepted };
}

/**
 * Puts a predicted change and an observed change into the same vocabulary.
 *
 * Three things have to line up or the metric measures formatting instead of
 * understanding:
 *   - "0 -> 1" and "+1" describe the same numeric move;
 *   - a key that vanished reads as `undefined` from the state diff, but a
 *     contract writes that as `false` (the instance stopped existing);
 *   - quoting and spacing vary between the agent and the engine.
 */
function normalise(value: string): string {
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/\s*->\s*/, '->')
    .replace(/"/g, '');

  // Absence is falsehood, however it was spelled.
  const canonical = trimmed
    .split('->')
    .map(part => (part === 'undefined' || part === 'null' || part === '' ? 'false' : part))
    .join('->');

  const arrow = /^(-?\d+)->(-?\d+)$/.exec(canonical);
  if (arrow?.[1] && arrow[2]) {
    const delta = Number(arrow[2]) - Number(arrow[1]);
    return delta >= 0 ? `+${String(delta)}` : String(delta);
  }
  return canonical;
}
