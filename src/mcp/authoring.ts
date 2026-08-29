import { ContractSchema, type Contract } from '../verifier/contract.js';
import type { StudioSession } from '../verifier/studio.js';
import { auditContract, type ContractAudit } from '../verifier/validate.js';

/**
 * Letting an agent author a game, without letting it grade its own homework.
 *
 * Three things have to be true at once for "describe a game and it builds it"
 * to mean anything:
 *
 *   1. The agent can create the world. Otherwise it can only fill in mechanics
 *      for objects a human placed.
 *   2. The agent can state what each mechanic should do. Otherwise a human
 *      writes every contract and the system does not scale past its author.
 *   3. A spec the agent wrote is not automatically trusted.
 *
 * The third is the one that makes the first two safe. A contract is only
 * accepted after it survives an audit: run it against an empty implementation,
 * and if the effects still appear it is describing the world rather than the
 * code, and every patch would pass it. That is the obvious way to cheat, and it
 * is checked mechanically rather than hoped against.
 *
 * What remains uncheckable is whether the contract describes the game a person
 * wanted. Nothing here decides that, which is why proposed contracts surface for
 * approval.
 */

export interface ProposedContract {
  contract: Contract;
  audit: ContractAudit;
  /** Set when a human has signed off; nothing trains on an unapproved spec. */
  approved: boolean;
  proposedAt: string;
}

export class Authoring {
  private readonly proposals = new Map<string, ProposedContract>();
  /** Luau that rebuilds the authored world, in the order it was authored. */
  private readonly worldSteps: string[] = [];

  /** The root every authored object lives under. */
  constructor(readonly root: string) {}

  /**
   * Records a world-building step and applies it.
   *
   * Kept as an ordered list rather than only applied, because the contracts
   * that follow need a `setup` that reproduces this world from nothing — the
   * verifier rebuilds between conditions, and a world that only exists because
   * someone ran a tool once cannot be rebuilt.
   */
  async build(session: StudioSession, luau: string): Promise<{ ok: boolean; error?: string; steps: number }> {
    try {
      await session.luau(`
local sandbox = workspace:FindFirstChild(${JSON.stringify(this.root)})
if not sandbox then
	sandbox = Instance.new("Folder")
	sandbox.Name = ${JSON.stringify(this.root)}
	sandbox.Parent = workspace
end
${luau}
return "built"
`);
      this.worldSteps.push(luau);
      return { ok: true, steps: this.worldSteps.length };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        steps: this.worldSteps.length,
      };
    }
  }

  /** The accumulated world as one `setup` block a contract can rebuild from. */
  setup(): string {
    return this.worldSteps.join('\n');
  }

  worldStepCount(): number {
    return this.worldSteps.length;
  }

  async reset(session: StudioSession): Promise<void> {
    this.worldSteps.length = 0;
    this.proposals.clear();
    await session.luau(`
local existing = workspace:FindFirstChild(${JSON.stringify(this.root)})
if existing then existing:Destroy() end
return "cleared"
`);
  }

  /**
   * Audits a drafted contract and keeps it only if it survives.
   *
   * `reference` is the implementation the drafter believes satisfies it. Asking
   * for one is deliberate: a contract nobody can satisfy is as useless as one
   * everybody satisfies, and requiring the pair catches both.
   */
  async propose(params: {
    session: StudioSession;
    draft: unknown;
    reference?: string;
  }): Promise<{ accepted: boolean; audit?: ContractAudit; problems: string[] }> {
    const { session, draft, reference } = params;

    const parsed = ContractSchema.safeParse(draft);
    if (!parsed.success) {
      return {
        accepted: false,
        problems: parsed.error.issues.map(
          issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
        ),
      };
    }

    // The contract is written against the world the agent has built so far.
    const contract: Contract = { ...parsed.data, setup: this.setup() };

    const audit = await auditContract({ session, contract, reference });
    if (!audit.usable) {
      return { accepted: false, audit, problems: audit.problems };
    }

    this.proposals.set(contract.id, {
      contract,
      audit,
      approved: false,
      proposedAt: new Date().toISOString(),
    });
    return { accepted: true, audit, problems: [] };
  }

  get(id: string): ProposedContract | undefined {
    return this.proposals.get(id);
  }

  all(): ProposedContract[] {
    return [...this.proposals.values()];
  }

  approve(id: string): boolean {
    const proposal = this.proposals.get(id);
    if (!proposal) return false;
    proposal.approved = true;
    return true;
  }

  /** Contracts a human has signed off on — the only ones worth training on. */
  approved(): Contract[] {
    return this.all()
      .filter(proposal => proposal.approved)
      .map(proposal => proposal.contract);
  }
}
