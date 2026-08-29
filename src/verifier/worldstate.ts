import type { StudioSession } from './studio.js';

/**
 * Snapshot and restore an arbitrary subtree of a real place.
 *
 * This exists because the bridge's own `place_restore` does not restore. Its
 * measured behaviour (scripts/probe-restore-fidelity.ts) is that it re-adds
 * deleted instances and reverts nothing else — not attributes, not properties,
 * not instances created after the snapshot — while returning `ok: true`. A
 * verifier built on it silently compares a treatment against a control that
 * began somewhere else.
 *
 * Rebuilding a world from nothing sidesteps that, and is what Placebo does for
 * its own fixtures. It is not an option for *your* game: you cannot reconstruct
 * an existing place between every condition. So an experiment on real content
 * needs a restore that actually restores.
 *
 * What this covers, stated plainly because the gap is the whole point:
 *
 *   instances created after the snapshot   removed
 *   instances deleted after the snapshot   recreated, with class, props, attrs
 *   attributes changed                     reverted (all attributes enumerate)
 *   properties changed                     reverted, for the WATCHED list below
 *   properties outside that list           NOT reverted
 *
 * Roblox exposes no runtime reflection for "every writable property", so the
 * property list is curated rather than exhaustive. `verifyRestoreFidelity`
 * measures the result instead of trusting this comment.
 */

/**
 * Properties worth tracking on a real place.
 *
 * Chosen for what gameplay actually mutates. Widening it costs snapshot time on
 * every condition, so it is deliberately a list and not "everything".
 */
export const WATCHED_PROPERTIES = [
  'Name',
  // Script bodies. Fixing a bug in someone's game usually means editing a
  // script, so a restore that does not put Source back leaves the place
  // permanently modified by an experiment — the worst possible failure for a
  // tool pointed at content you care about.
  'Source',
  'Anchored',
  'CanCollide',
  'CanTouch',
  'Transparency',
  'Size',
  'Position',
  'Orientation',
  'Color',
  'Material',
  'Enabled',
  'Visible',
  'Text',
  'Value',
  'Health',
  'MaxHealth',
  'WalkSpeed',
  'JumpPower',
  'BrickColor',
  'Locked',
  'Massless',
  'Reflectance',
] as const;

const WATCHED_LUA = `{ ${WATCHED_PROPERTIES.map(p => `"${p}"`).join(', ')} }`;

/**
 * Luau that captures a subtree.
 *
 * Identity is the path from the root. A renamed instance therefore reads as a
 * delete plus a create, which restores correctly even though it costs an extra
 * rebuild — the alternative, tracking by reference, does not survive an
 * instance being destroyed and recreated by a patch.
 */
function snapshotLua(rootPath: string): string {
  return `
local HttpService = game:GetService("HttpService")
local WATCHED = ${WATCHED_LUA}

local root = ${rootPath}
if not root then return HttpService:JSONEncode({ ok = false, reason = "root not found" }) end

local nodes = {}

local function capture(inst, path)
	local props = {}
	for _, name in WATCHED do
		local ok, value = pcall(function() return inst[name] end)
		if ok and value ~= nil then
			props[name] = tostring(value)
		end
	end
	local attrs = {}
	for key, value in pairs(inst:GetAttributes()) do
		attrs[key] = { t = typeof(value), v = tostring(value) }
	end
	table.insert(nodes, {
		path = path,
		class = inst.ClassName,
		name = inst.Name,
		props = props,
		attrs = attrs,
	})
end

local function walk(inst, prefix)
	for _, child in inst:GetChildren() do
		local path = prefix == "" and child.Name or (prefix .. "/" .. child.Name)
		capture(child, path)
		walk(child, path)
	end
end

-- The root itself, not just its children. Walking from the children leaves the
-- root's own attributes and properties uncaptured, so a patch that sets an
-- attribute on the container survives a restore — measured, not theorised.
capture(root, "")
walk(root, "")
return HttpService:JSONEncode({ ok = true, nodes = nodes })
`;
}

/**
 * Luau that puts a subtree back.
 *
 * Order matters: remove extras first (so a recreated instance does not collide
 * with a leftover of the same name), then recreate what is missing parent-first,
 * then revert values on whatever survived.
 */
function restoreLua(rootPath: string, snapshotJson: string): string {
  return `
local HttpService = game:GetService("HttpService")
local snapshot = HttpService:JSONDecode(${JSON.stringify(snapshotJson)})
local root = ${rootPath}
if not root then return HttpService:JSONEncode({ ok = false, reason = "root not found" }) end

local wanted = {}
for _, node in snapshot.nodes do
	wanted[node.path] = node
end

local function resolve(path)
	local current = root
	for segment in string.gmatch(path, "[^/]+") do
		current = current and current:FindFirstChild(segment)
		if not current then return nil end
	end
	return current
end

-- Values arrive as strings; put back the types that matter.
local function decode(entry)
	local t, v = entry.t, entry.v
	if t == "number" then return tonumber(v) end
	if t == "boolean" then return v == "true" end
	return v
end

local removed, recreated, reverted = 0, 0, 0

-- 1. anything created since the snapshot
local present = {}
-- The root is never a candidate for removal: collection starts at its children.
local function collect(inst, prefix)
	for _, child in inst:GetChildren() do
		local path = prefix == "" and child.Name or (prefix .. "/" .. child.Name)
		table.insert(present, { inst = child, path = path })
		collect(child, path)
	end
end
collect(root, "")
-- deepest first, so removing a parent does not invalidate a queued child
table.sort(present, function(a, b) return #a.path > #b.path end)
for _, entry in present do
	if not wanted[entry.path] and entry.inst.Parent then
		entry.inst:Destroy()
		removed += 1
	end
end

-- 2. anything deleted since the snapshot, shallowest first so parents exist
local missing = {}
for path, node in wanted do
	if not resolve(path) then table.insert(missing, node) end
end
table.sort(missing, function(a, b) return #a.path < #b.path end)
for _, node in missing do
	local parentPath = string.match(node.path, "^(.*)/[^/]+$")
	local parent = parentPath and resolve(parentPath) or root
	if parent then
		local ok, inst = pcall(function() return Instance.new(node.class) end)
		if ok and inst then
			inst.Name = node.name
			inst.Parent = parent
			recreated += 1
		end
	end
end

-- 3. values on whatever survived
for path, node in wanted do
	local inst = resolve(path)
	if inst then
		for name, value in pairs(node.props) do
			pcall(function()
				if tostring(inst[name]) ~= value then
					-- Only assign where a string round-trips cleanly; geometry and
					-- colour types are recreated above rather than coerced here.
					if type(inst[name]) == "number" then
						inst[name] = tonumber(value)
					elseif type(inst[name]) == "boolean" then
						inst[name] = value == "true"
					elseif type(inst[name]) == "string" then
						inst[name] = value
					end
					reverted += 1
				end
			end)
		end
		local live = inst:GetAttributes()
		for key, entry in pairs(node.attrs) do
			local want = decode(entry)
			if live[key] ~= want then
				inst:SetAttribute(key, want)
				reverted += 1
			end
		end
		for key in pairs(live) do
			if node.attrs[key] == nil then
				inst:SetAttribute(key, nil)
				reverted += 1
			end
		end
	end
end

return HttpService:JSONEncode({ ok = true, removed = removed, recreated = recreated, reverted = reverted })
`;
}

export interface WorldSnapshot {
  rootPath: string;
  json: string;
  nodeCount: number;
}

export interface RestoreReport {
  ok: boolean;
  removed: number;
  recreated: number;
  reverted: number;
  reason?: string;
}

/** Luau expression resolving the subtree root, e.g. `workspace.MyGame`. */
export function rootExpression(path: string): string {
  const segments = path.split('.').filter(Boolean);
  const [head, ...rest] = segments;
  if (!head) throw new Error('empty root path');
  const base = head === 'workspace' || head === 'game' ? head : `workspace:FindFirstChild("${head}")`;
  return rest.reduce((acc, segment) => `(${acc} and ${acc}:FindFirstChild("${segment}"))`, base);
}

export async function snapshotWorld(session: StudioSession, rootPath: string): Promise<WorldSnapshot> {
  const raw = await session.luau(snapshotLua(rootExpression(rootPath)));
  if (typeof raw !== 'string') throw new Error('snapshot returned no payload');
  const parsed = JSON.parse(raw) as { ok: boolean; reason?: string; nodes?: unknown[] };
  if (!parsed.ok) throw new Error(`snapshot failed: ${parsed.reason ?? 'unknown'}`);
  return { rootPath, json: raw, nodeCount: (parsed.nodes ?? []).length };
}

export async function restoreWorld(
  session: StudioSession,
  snapshot: WorldSnapshot,
): Promise<RestoreReport> {
  const raw = await session.luau(restoreLua(rootExpression(snapshot.rootPath), snapshot.json));
  if (typeof raw !== 'string') return { ok: false, removed: 0, recreated: 0, reverted: 0 };
  return JSON.parse(raw) as RestoreReport;
}
