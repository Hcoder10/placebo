import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Drives a live Roblox Studio through the roblox-studio-mcp bridge.
 *
 * Every branch of an experiment must start from a byte-identical world, so this
 * class does **not** use the bridge's `place_snapshot` / `place_restore` pair.
 * Measured behaviour of `place_restore` (see scripts/probe-restore-fidelity.ts):
 *
 *     attribute on part          NOT reverted
 *     attribute on service       NOT reverted
 *     property on part           NOT reverted
 *     instance created after     NOT removed
 *     instance deleted after     restored
 *
 * It reports `ok: true` regardless, so a verifier trusting it would silently
 * compare a treatment against a control that began in a different state.
 *
 * Instead each branch rebuilds its world from nothing inside a scoped
 * container. Determinism by construction beats determinism by promise, and it
 * removes the dependency on a mechanism we cannot audit from outside.
 */

/** Everything the harness builds lives here and nowhere else. */
export const SANDBOX = 'PlaceboSandbox';

/** Canonical observation of the sandbox world. */
export type StateVector = Record<string, unknown>;

export interface StudioConfig {
  url?: string;
  /** Fails fast rather than hanging a demo on a dead bridge. */
  timeoutMs?: number;
}

export class StudioSession {
  private client: Client | null = null;

  constructor(private readonly config: StudioConfig = {}) {}

  private get url(): string {
    return this.config.url ?? process.env.STUDIO_MCP_URL ?? 'http://localhost:3000/mcp';
  }

  async connect(): Promise<{ token: string; placeId: string }> {
    const client = new Client({ name: 'placebo-verifier', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
    this.client = client;

    const connected = (await this.call('session_connect')) as {
      success?: boolean;
      data?: { token?: string; place_id?: string };
    };
    if (!connected?.success) {
      throw new Error(
        `no Roblox Studio session. Open Studio and click "Studio Bridge MCP" -> Connect. (${JSON.stringify(connected).slice(0, 200)})`,
      );
    }
    return { token: connected.data?.token ?? '', placeId: connected.data?.place_id ?? '' };
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  /** Raw tool call against the bridge. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.client) throw new Error('not connected');
    const result = await this.client.callTool({ name, arguments: args });
    const content = (result.content as { type: string; text?: string }[] | undefined) ?? [];
    const text = content.find(part => part.type === 'text')?.text ?? '';
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /**
   * Runs Luau in Studio and returns its value.
   *
   * The bridge reports script errors inside a successful envelope, so failures
   * are raised here rather than being read as an empty result.
   */
  async luau(code: string, attempts = 3): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.luauOnce(code);
      } catch (error) {
        lastError = error;
        // Studio throttles its scheduler when the window loses focus, which
        // surfaces as a bridge timeout rather than an error. Retrying costs a
        // few seconds and rescues a run that would otherwise report a false
        // rejection.
        if (!String(error).includes('timed out')) throw error;
        await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
      }
    }
    throw lastError;
  }

  private async luauOnce(code: string): Promise<unknown> {
    const out = (await this.call('execution_run_luau', { code })) as {
      success?: boolean;
      data?: { value?: unknown; error?: string };
      error?: { message?: string };
    };
    if (out?.success === false) {
      throw new Error(`luau failed: ${out.error?.message ?? JSON.stringify(out).slice(0, 200)}`);
    }
    if (out?.data?.error) {
      throw new Error(`luau error: ${out.data.error}`);
    }
    return out?.data?.value;
  }

  /**
   * Runs one complete experimental condition in a single round trip.
   *
   * Reset, build, patch, interact and observe are one Luau program rather than
   * five tool calls. That is not just a speed optimisation:
   *
   *   - the bridge is HTTP long-polling against a Studio plugin, and Roblox
   *     Studio throttles its scheduler hard when the window is unfocused, so
   *     every extra round trip is another chance to hit the 30s timeout;
   *   - a condition that is one program cannot be interleaved with anything
   *     else, which is what makes treatment and control genuinely comparable.
   */
  async runCondition(params: {
    setup: string;
    patch: string;
    interaction: string;
    realization: number;
  }): Promise<StateVector> {
    const { setup, patch, interaction, realization } = params;

    const raw = await this.luau(`
local HttpService = game:GetService("HttpService")
local REALIZATION = ${String(realization)}

-- fresh world, built from nothing
local existing = workspace:FindFirstChild(${JSON.stringify(SANDBOX)})
if existing then existing:Destroy() end
local sandbox = Instance.new("Folder")
sandbox.Name = ${JSON.stringify(SANDBOX)}
sandbox.Parent = workspace

do
${setup}
end

do
${patch}
end

do
${interaction}
end

-- Let deferred work land before observing.
--
-- Roblox signals do not run their handlers synchronously: BindableEvent:Fire
-- and friends resume connections at the next scheduler point. When each step
-- was its own round trip the network latency hid this, and collapsing the
-- condition into one program exposed it — every patch looked inert because we
-- observed the world before a single handler had run.
for _ = 1, 4 do
	task.wait()
end

local WATCHED = { "Transparency", "Anchored", "CanCollide" }
local state = {}

local function record(inst, path)
	state["exists:" .. path] = true
	for _, prop in WATCHED do
		local ok, value = pcall(function() return inst[prop] end)
		if ok and value ~= nil then
			state[path .. "." .. prop] = tostring(value)
		end
	end
	for key, value in pairs(inst:GetAttributes()) do
		state[path .. ".@" .. key] = value
	end
end

local function walk(inst, path)
	for _, child in inst:GetChildren() do
		local childPath = path == "" and child.Name or (path .. "/" .. child.Name)
		record(child, childPath)
		walk(child, childPath)
	end
end

walk(sandbox, "")
return HttpService:JSONEncode(state)
`);

    if (typeof raw !== 'string') return {};
    try {
      return JSON.parse(raw) as StateVector;
    } catch {
      return {};
    }
  }

  /** Leaves the place as we found it. */
  async cleanup(): Promise<void> {
    await this.luau(`
local existing = workspace:FindFirstChild(${JSON.stringify(SANDBOX)})
if existing then existing:Destroy() end
return "clean"
`);
  }
}
