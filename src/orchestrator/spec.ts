export const MCP_SERVER_NAME = 'placebo-tools';

/**
 * The agent that runs the experiment.
 *
 * The parent does not fix anything itself. Its whole job is to fan out N
 * subagents from one identical starting point and rank what comes back — which
 * is exactly what a counterfactual patch group is. TrueForge gives each
 * subagent a clean context with no access to the parent conversation, so the
 * branches are independent by construction rather than by convention.
 *
 * That independence is a *scientific* requirement here, not context economy. If
 * branch B could see branch A's attempt, the comparison between them would
 * measure ordering as much as it measures the patches.
 */

const PARENT_INSTRUCTIONS = `
You run controlled repair experiments on a Roblox mechanic. You do not write
patches yourself.

Procedure:
1. Call contract_get to read the requirement. Note that the expected effects are
   withheld on purpose.
2. Call project_source to read the current, defective implementation.
3. Create exactly {{BRANCHES}} sub-agents with create_sub_agent, named branch_a,
   branch_b, ... Give every one of them the SAME self-contained brief: the
   requirement, the current source, and their own branch id. Do not tell any
   branch what another branch did — they are independent arms of one experiment.
4. When they have all reported, rank them and state which branch you would ship
   and why.

Ranking, in strict order of precedence:
  1. the contract was satisfied
  2. nothing in non_effects moved
  3. the result was stable across all realizations
  4. the patch is smaller
  5. it needed fewer engine runs

Do not merge or publish anything. That is a human decision.
`.trim();

const BRANCH_BRIEF = `
You are one arm of a controlled experiment. Repair this Roblox mechanic.

Work in this order, and do not skip step 2:
1. Call contract_get and project_source.
2. Call predict_effect with your branch id and what YOUR patch will do to world
   state — keys like "Scoreboard.@Coins": "+1", plus the keys you expect not to
   move. Predict what your patch will actually cause, not what the requirement
   asks for. If you think your patch is imperfect, say so in the prediction:
   you are scored on accuracy against the engine, not on optimism.
3. Call patch_propose with your branch id and the Luau.
4. Call causal_verify with your branch id.
5. If it was rejected, you may revise once: predict again, propose again,
   verify again. Then report.

Report back: accepted or not, what the engine observed, and where your
prediction was wrong.

Your patch runs inside a folder called \`sandbox\` which is already in scope.
Write only the wiring for the mechanic.
`.trim();

export function parentAgentSpec(params: { model: string; branches: number }) {
  return {
    model: { name: params.model },
    instructions: PARENT_INSTRUCTIONS.replace('{{BRANCHES}}', String(params.branches)),
    mcp_servers: [
      {
        name: MCP_SERVER_NAME,
        enable_tools: ['@all'],
        // Gating comes from the MCP annotations, not a name list we would have
        // to remember to update.
        //
        // Only @destructive pauses. patch_propose is a @write, but it is scoped
        // to a sandbox folder that is rebuilt from nothing before every
        // condition, so it is reversible by construction — gating it would put
        // an approval prompt in front of every branch and train the operator to
        // click through the one that matters. publish_place is the irreversible
        // step, and it is the one that stops.
        require_approval_for_tools: ['@destructive'],
        preload: true,
      },
    ],
    config: {
      iteration_limit: 60,
      sandbox: { enabled: false, file_downloads: false },
      // The load-bearing setting: branches are subagents.
      dynamic_sub_agents: { enabled: true },
      context_management: {
        compaction: { enabled: true },
        large_tool_response: { enabled: true },
      },
      generative_ui: { enabled: false },
      ask_user_questions: { enabled: false },
    },
  };
}

export const BRANCH_BRIEF_TEXT = BRANCH_BRIEF;
