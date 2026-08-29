import { TrueForge } from '@truefoundry/trueforge-sdk';
import { MCP_SERVER_NAME } from './spec.js';

/**
 * Registers Placebo's tools with a TrueForge server, idempotently.
 *
 * Doing this in code rather than by clicking through Settings matters more than
 * usual here: *which tools are gated* is a security property, not a preference,
 * and it should be reviewable in a diff.
 */

export interface ToolInfo {
  name: string;
  annotations: Record<string, unknown> | undefined;
}

export interface SetupResult {
  mcpUrl: string;
  tools: ToolInfo[];
  models: string[];
}

export async function setup(params: { client: TrueForge; mcpUrl: string }): Promise<SetupResult> {
  const { client, mcpUrl } = params;

  await client.settings.mcpServers.createOrUpdate({
    manifest: {
      type: 'remote',
      name: MCP_SERVER_NAME,
      url: mcpUrl,
      description:
        'Placebo: read a behavioural contract, predict an effect, propose a patch, and verify what it caused in a live Roblox Studio.',
    },
  });

  return {
    mcpUrl,
    tools: await listTools(client, MCP_SERVER_NAME),
    models: await listModels(client),
  };
}

async function listTools(client: TrueForge, name: string): Promise<ToolInfo[]> {
  const response = await client.mcpServers.listTools(name);
  const data = (response as { data?: unknown }).data;
  const tools = (Array.isArray(data) ? data : []) as {
    name: string;
    annotations?: Record<string, unknown>;
  }[];
  return tools.map(tool => ({ name: tool.name, annotations: tool.annotations }));
}

async function listModels(client: TrueForge): Promise<string[]> {
  const response = await client.models.list();
  const data = (response as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map(entry => (entry as { name?: string; id?: string }).name ?? (entry as { id?: string }).id)
    .filter((name): name is string => typeof name === 'string');
}

/** Which selector bucket the harness will put a tool in, from its annotations. */
export function harnessBucket(annotations: Record<string, unknown> | undefined): string {
  if (annotations?.readOnlyHint === true) return '@read-only';
  if (annotations?.destructiveHint === true) return '@destructive';
  if (annotations?.readOnlyHint === false) return '@write';
  return 'UNANNOTATED';
}

/**
 * Refuses to start when a tool that must pause for a human would not.
 *
 * TrueForge resolves `@write` / `@destructive` from MCP annotations, so an
 * unannotated tool is silently *exempt* from approval. That turns "pauses for a
 * human" into "runs unattended" with no error anywhere — which is exactly what
 * the neighbouring roblox-studio-mcp server does today across all 134 of its
 * tools. Worth a hard stop rather than a warning.
 */
export function assertGated(tools: ToolInfo[], mustBeGated: string[]): void {
  const problems: string[] = [];

  for (const name of mustBeGated) {
    const tool = tools.find(candidate => candidate.name === name);
    if (!tool) {
      problems.push(`${name}: not exposed by the MCP server`);
      continue;
    }
    const bucket = harnessBucket(tool.annotations);
    if (bucket !== '@write' && bucket !== '@destructive') {
      problems.push(`${name}: resolves to ${bucket}, which the harness does not gate`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Tools that must require approval are not gated:\n  ${problems.join('\n  ')}`);
  }
}
