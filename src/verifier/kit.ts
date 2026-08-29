/**
 * A substrate for scenes that look built rather than assembled.
 *
 * The rest of this project refuses to ask a model to be *correct* — it asks the
 * model to write code and then measures what that code causes. This file does
 * the same thing to appearance: it refuses to ask a 20B model to have taste.
 *
 * The failure mode is specific and mechanical. A model reaching for
 * `Instance.new("Part")` gets a 4x1x2 stud slab of medium stone grey in
 * Plastic, sitting at whatever fractional position it happened to name. Ten of
 * those is a grey box, and no amount of prompting reliably fixes it, because
 * "make it look nice" is not a property a small model can evaluate about its
 * own output.
 *
 * So the default is moved instead of the model. `kit` is injected into scope
 * ahead of every world-building call, and every constructor in it already
 * decides the things that make a simple Roblox scene read as designed:
 *
 *   one palette         eight colours that share a temperature story, not a
 *                       rainbow. Every object in the world is one of these.
 *   paired materials    colour and material travel together, so a scene cannot
 *                       end up as flat plastic with a texture bolted on.
 *   real proportions    a wall is 8 studs tall because a Roblox character is
 *                       5, a platform is 16 wide because that is a jump.
 *   ground-relative y   every constructor takes the height of the floor the
 *                       object stands on and lifts the object itself. A model
 *                       that says y = 0 gets something resting on the ground
 *                       rather than something half-buried in it.
 *   grid snap           positions land on a `GRID_STUDS` lattice, so geometry
 *                       lines up without the model doing arithmetic.
 *   lighting            `kit.scene()` replaces Roblox's default flat lighting
 *                       with an afternoon sun, an Atmosphere and a restrained
 *                       grade. Default Lighting is the single largest "nobody
 *                       touched this" tell, and it costs one call to fix.
 *
 * Every instance is tagged with a `KitRole` attribute. That is not decoration:
 * `design.ts` uses it to check the right thing per object — a coin buried
 * inside a platform is a broken pickup, whereas a bush overlapping the ground
 * is how bushes work.
 *
 * The palette and the grid are declared here, once, in TypeScript, and the Luau
 * is generated from them. `design.ts` imports the same declarations, so the
 * checker and the substrate cannot drift apart.
 */

/** Positions are snapped to this lattice, in studs. */
export const GRID_STUDS = 0.5;

/**
 * How far a colour may sit from a palette entry and still count as that entry,
 * as Euclidean distance in 0-255 RGB.
 *
 * The nearest two palette entries are 32 apart, so 8 cannot confuse one for
 * another, and it is loose enough that a colour arriving through a float
 * round-trip matches exactly. It is deliberately not a "close enough" budget:
 * anything genuinely off-palette is tens of units away.
 */
export const PALETTE_TOLERANCE_RGB = 8;

/** What `Instance.new("Part")` produces, unmodified. The thing we are detecting. */
export const DEFAULT_PART_RGB: readonly [number, number, number] = [163, 162, 165];
export const DEFAULT_PART_SIZE: readonly [number, number, number] = [4, 1, 2];
export const DEFAULT_PART_MATERIAL = 'Plastic';

export interface PaletteEntry {
  readonly name: string;
  readonly rgb: readonly [number, number, number];
  /**
   * The material this colour is normally seen in.
   *
   * Pairing them is what stops a scene from turning into eight hues of the same
   * plastic. A constructor may override the material where the object's
   * identity demands it (a crystal is Neon whatever colour it is), and that is
   * fine — `design.ts` verifies colour against the palette and flags the
   * untouched default material, but never requires a specific pairing.
   */
  readonly material: string;
  /** What the colour is for, quoted to the agent in `KIT_BRIEF`. */
  readonly use: string;
}

/**
 * Warm sandstone ground, cool structure, and two saturated accents reserved for
 * the things the player interacts with.
 *
 * The accent discipline is doing most of the work. Structure is desaturated and
 * earthy; gold, teal and ember appear only on coins, goals and hazards. That is
 * why a scene built from this kit reads legibly at a glance — colour means
 * "this one matters", not "this one was next in the list".
 *
 * Every entry is far from `DEFAULT_PART_RGB`, deliberately: a palette that
 * contained a grey near Roblox's default would make the untouched-default check
 * unable to fire.
 */
export const PALETTE: readonly PaletteEntry[] = [
  { name: 'sand', rgb: [232, 211, 169], material: 'Concrete', use: 'floors and platforms' },
  { name: 'clay', rgb: [200, 106, 75], material: 'Concrete', use: 'a second platform tone, ledges' },
  { name: 'slate', rgb: [62, 74, 91], material: 'Slate', use: 'walls, pillars, structure' },
  { name: 'moss', rgb: [111, 155, 92], material: 'Grass', use: 'ground, foliage' },
  { name: 'gold', rgb: [242, 193, 78], material: 'Neon', use: 'coins and pickups' },
  { name: 'teal', rgb: [63, 184, 175], material: 'SmoothPlastic', use: 'doors, goals, anything friendly' },
  { name: 'ember', rgb: [226, 87, 76], material: 'Neon', use: 'hazards and danger' },
  { name: 'cream', rgb: [246, 241, 228], material: 'SmoothPlastic', use: 'spawns, highlights, light sources' },
];

/** The roles `kit` tags its instances with, and that `design.ts` reasons about. */
export const KIT_ROLES = [
  'ground',
  'platform',
  'wall',
  'door',
  'coin',
  'chest',
  'hazard',
  'spawn',
  'decor',
] as const;

export type KitRole = (typeof KIT_ROLES)[number];

/** Rounds a coordinate onto the stud lattice the kit builds on. */
export function snapToGrid(value: number): number {
  return Math.round(value / GRID_STUDS) * GRID_STUDS;
}

/** True when a coordinate already sits on the lattice, within float noise. */
export function isOnGrid(value: number, epsilon = 1e-3): boolean {
  return Math.abs(value - snapToGrid(value)) <= epsilon;
}

export function paletteEntry(name: string): PaletteEntry | undefined {
  return PALETTE.find(entry => entry.name === name);
}

/** Distance between two colours in 0-255 RGB space. */
export function rgbDistance(a: readonly number[], b: readonly number[]): number {
  const dr = (a[0] ?? 0) - (b[0] ?? 0);
  const dg = (a[1] ?? 0) - (b[1] ?? 0);
  const db = (a[2] ?? 0) - (b[2] ?? 0);
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** The palette entry a colour is closest to, and how far off it is. */
export function nearestPaletteEntry(rgb: readonly number[]): { entry: PaletteEntry; distance: number } {
  let best: { entry: PaletteEntry; distance: number } | undefined;
  for (const entry of PALETTE) {
    const distance = rgbDistance(rgb, entry.rgb);
    if (!best || distance < best.distance) best = { entry, distance };
  }
  if (!best) throw new Error('the palette is empty');
  return best;
}

/** The palette, as the Luau table literal the kit closes over. */
function paletteLuau(): string {
  return PALETTE.map(
    entry =>
      `\t\t${entry.name} = { c = Color3.fromRGB(${entry.rgb.join(', ')}), m = Enum.Material.${entry.material} },`,
  ).join('\n');
}

/**
 * The kit itself, as Luau.
 *
 * Exactly one top-level local (`kit`) is declared, with everything else closed
 * over inside the initialiser. That matters because this prelude is prepended
 * to every world-building step, and a contract's `setup` is those steps
 * concatenated into a single block: Luau caps a function at 200 locals, so a
 * prelude that leaked a dozen names would put a ceiling on how many steps a
 * build could have.
 */
export const KIT_LUAU = `local kit = (function()
	local Lighting = game:GetService("Lighting")

	local P = {
${paletteLuau()}
	}

	local GRID = ${String(GRID_STUDS)}
	-- Tolerant of a missing coordinate on purpose: a small model that calls
	-- kit.coin(sandbox, 8, 0) should get a coin at z = 0, not a build failure
	-- three tool calls deep.
	local function snap(v) return math.round((v or 0) / GRID) * GRID end

	-- Names have to be stable across rebuilds, because a contract's setup
	-- replays these steps into a fresh sandbox and its treatment refers to
	-- instances by name. A counter over the parent's existing children is
	-- deterministic given the same build order, which is the property that
	-- matters here.
	local function uniqueName(parent, base)
		if not parent:FindFirstChild(base) then return base end
		local n = 2
		while parent:FindFirstChild(base .. n) do n += 1 end
		return base .. n
	end

	-- Every constructor funnels through here. That single choke point is what
	-- lets design.ts assume anything at all: one place decides the colour, the
	-- material, the grid snap, the surface finish and the KitRole tag.
	local function make(parent, spec)
		local inst = Instance.new(spec.class or "Part")
		inst.Name = uniqueName(parent, spec.label)
		inst.Size = Vector3.new(spec.sx, spec.sy, spec.sz)
		inst.CFrame = CFrame.new(snap(spec.x), snap(spec.y), snap(spec.z)) * (spec.rot or CFrame.identity)
		inst.Anchored = true
		inst.CanCollide = spec.collide ~= false
		-- Studs and inlets are the oldest amateur tell in Roblox.
		inst.TopSurface = Enum.SurfaceType.Smooth
		inst.BottomSurface = Enum.SurfaceType.Smooth
		local style = P[spec.tint] or P.cream
		inst.Color = style.c
		inst.Material = spec.material or style.m
		if spec.shape then inst.Shape = spec.shape end
		if spec.transparency then inst.Transparency = spec.transparency end
		inst:SetAttribute("KitRole", spec.role)
		inst.Parent = parent
		return inst
	end

	local kit = {}
	kit.grid = GRID
	kit.snap = snap
	kit.palette = P

	-- Recolour to a palette entry, taking that entry's material with it. Colour
	-- and material move together or a scene drifts into flat plastic.
	function kit.tint(inst, name)
		local style = P[name]
		if not style then return inst end
		inst.Color = style.c
		inst.Material = style.m
		return inst
	end

	function kit.light(part, name, brightness, range)
		local light = Instance.new("PointLight")
		light.Color = (P[name] or P.cream).c
		light.Brightness = brightness or 2
		light.Range = range or 14
		light.Shadows = true
		light.Parent = part
		return light
	end

	-- The single largest visual difference available, and the one a model never
	-- thinks to make. Default Lighting renders everything flat and slightly
	-- blue; an afternoon sun plus a little haze gives depth for free.
	--
	-- This is the only thing the kit touches outside the sandbox root, so the
	-- previous values are stashed on Lighting itself (attributes survive the
	-- sandbox folder being destroyed) and KIT_LIGHTING_RESTORE_LUAU puts them
	-- back. Stashing happens once, so re-running this never overwrites the
	-- backup with the kit's own values.
	function kit.scene()
		if Lighting:GetAttribute("KitScene") ~= true then
			Lighting:SetAttribute("KitPrevAmbient", Lighting.Ambient)
			Lighting:SetAttribute("KitPrevOutdoorAmbient", Lighting.OutdoorAmbient)
			Lighting:SetAttribute("KitPrevBrightness", Lighting.Brightness)
			Lighting:SetAttribute("KitPrevClockTime", Lighting.ClockTime)
			Lighting:SetAttribute("KitScene", true)
		end
		Lighting.Ambient = Color3.fromRGB(70, 74, 88)
		Lighting.OutdoorAmbient = Color3.fromRGB(126, 122, 112)
		Lighting.Brightness = 2.6
		Lighting.ClockTime = 15.5
		-- Renderer-dependent tuning: these are no-ops or errors depending on the
		-- place's lighting technology, and none of them is worth failing a build
		-- over.
		pcall(function()
			Lighting.ExposureCompensation = 0.25
			Lighting.ShadowSoftness = 0.35
			Lighting.GeographicLatitude = 12
		end)
		local atmosphere = Lighting:FindFirstChild("KitAtmosphere")
		if not atmosphere then
			atmosphere = Instance.new("Atmosphere")
			atmosphere.Name = "KitAtmosphere"
			atmosphere.Parent = Lighting
		end
		atmosphere.Density = 0.32
		atmosphere.Offset = 0.1
		atmosphere.Color = Color3.fromRGB(214, 205, 190)
		atmosphere.Decay = Color3.fromRGB(92, 104, 120)
		atmosphere.Glare = 0.2
		atmosphere.Haze = 1.4
		-- A restrained grade on top. Contrast and saturation this low are barely
		-- nameable in a screenshot and unmistakable in motion; pushed further
		-- they read as a filter, which is its own kind of amateur.
		local grade = Lighting:FindFirstChild("KitColorCorrection")
		if not grade then
			grade = Instance.new("ColorCorrectionEffect")
			grade.Name = "KitColorCorrection"
			grade.Parent = Lighting
		end
		grade.Brightness = 0
		grade.Contrast = 0.12
		grade.Saturation = 0.15
		grade.TintColor = Color3.fromRGB(255, 250, 244)
		grade.Enabled = true
		return atmosphere
	end

	-- A floor, so the game is not a handful of slabs floating in the void.
	-- Idempotent: the bootstrap runs it on every world step.
	function kit.ground(parent, size, name)
		local existing = parent:FindFirstChild(name or "Ground")
		if existing then return existing end
		return make(parent, {
			role = "ground", label = name or "Ground", tint = "moss",
			sx = size or 96, sy = 2, sz = size or 96,
			x = 0, y = -1, z = 0,
		})
	end

	-- y is the height you STAND ON, not the centre. Every constructor below
	-- follows the same rule, which is what stops a small model from producing a
	-- world where everything is sunk halfway into the floor.
	function kit.platform(parent, x, y, z, width, depth, name)
		return make(parent, {
			role = "platform", label = name or "Platform", tint = "sand",
			sx = width or 16, sy = 1, sz = depth or 16,
			x = x, y = (y or 0) - 0.5, z = z,
		})
	end

	-- axis "x" runs the wall along X, "z" along Z. y is the base.
	function kit.wall(parent, x, y, z, length, axis, name)
		local run = length or 16
		local alongZ = axis == "z" or axis == "Z"
		return make(parent, {
			role = "wall", label = name or "Wall", tint = "slate",
			sx = alongZ and 1 or run, sy = 8, sz = alongZ and run or 1,
			x = x, y = (y or 0) + 4, z = z,
		})
	end

	function kit.door(parent, x, y, z, axis, name)
		local alongZ = axis == "z" or axis == "Z"
		return make(parent, {
			role = "door", label = name or "Door", tint = "teal",
			sx = alongZ and 1 or 6, sy = 8, sz = alongZ and 6 or 1,
			x = x, y = (y or 0) + 4, z = z,
		})
	end

	-- A cylinder stood on edge, hovering two studs off the ground: the shape
	-- everyone already reads as a collectable. A grey brick with a Touched
	-- handler does not read as anything.
	function kit.coin(parent, x, y, z, name)
		local coin = make(parent, {
			role = "coin", label = name or "Coin", tint = "gold",
			shape = Enum.PartType.Cylinder,
			rot = CFrame.Angles(0, math.rad(90), 0),
			sx = 0.5, sy = 3, sz = 3,
			x = x, y = (y or 0) + 2, z = z,
			collide = false,
		})
		-- Neon makes the coin glow; the light makes the coin light the floor
		-- under it. Kept dim and short-range on purpose: a dozen bright coins
		-- exceed Roblox's visible-light budget and start flickering.
		kit.light(coin, "gold", 1.2, 8)
		return coin
	end

	-- A container that reads as openable at a glance: waist-high, wooden, and
	-- wider than it is deep, so it faces the player rather than sitting as a
	-- neutral cube. Lockable mechanics are common enough in simple games to
	-- earn a constructor rather than being hand-rolled every time.
	function kit.chest(parent, x, y, z, name)
		return make(parent, {
			role = "chest", label = name or "Chest", tint = "clay",
			material = Enum.Material.WoodPlanks,
			sx = 4, sy = 3, sz = 3,
			x = x, y = (y or 0) + 1.5, z = z,
		})
	end

	function kit.hazard(parent, x, y, z, width, depth, name)
		return make(parent, {
			role = "hazard", label = name or "Hazard", tint = "ember",
			sx = width or 6, sy = 1, sz = depth or 6,
			x = x, y = (y or 0) + 0.5, z = z,
		})
	end

	function kit.spawn(parent, x, y, z, name)
		local pad = make(parent, {
			role = "spawn", label = name or "Spawn", tint = "cream",
			class = "SpawnLocation",
			sx = 6, sy = 1, sz = 6,
			x = x, y = (y or 0) + 0.5, z = z,
		})
		pad.Neutral = true
		pad.Duration = 0
		kit.light(pad, "cream", 1.5, 12)
		return pad
	end

	-- Vertical interest is what separates a scene from a floor plan, and it is
	-- the thing a model laying out coordinates never adds on its own.
	function kit.decor(parent, x, y, z, kind, name)
		if kind == "bush" then
			return make(parent, {
				role = "decor", label = name or "Bush", tint = "moss",
				shape = Enum.PartType.Ball,
				sx = 3, sy = 3, sz = 3,
				x = x, y = (y or 0) + 1.5, z = z,
				collide = false,
			})
		end
		if kind == "crystal" then
			local crystal = make(parent, {
				role = "decor", label = name or "Crystal", tint = "teal",
				material = Enum.Material.Neon, transparency = 0.1,
				sx = 1.5, sy = 5, sz = 1.5,
				x = x, y = (y or 0) + 2.5, z = z,
				collide = false,
			})
			kit.light(crystal, "teal", 3, 16)
			return crystal
		end
		return make(parent, {
			role = "decor", label = name or "Pillar", tint = "slate",
			sx = 2, sy = 6, sz = 2,
			x = x, y = (y or 0) + 3, z = z,
		})
	end

	return kit
end)()`;

/**
 * Puts the place's lighting back.
 *
 * The kit's one out-of-sandbox side effect deserves an explicit undo — this
 * project's whole posture is that a tool pointed at content you care about
 * leaves it as it found it.
 */
export const KIT_LIGHTING_RESTORE_LUAU = `local Lighting = game:GetService("Lighting")
if Lighting:GetAttribute("KitScene") ~= true then return "nothing to restore" end
local function put(property, key)
	local value = Lighting:GetAttribute(key)
	if value ~= nil then Lighting[property] = value end
end
put("Ambient", "KitPrevAmbient")
put("OutdoorAmbient", "KitPrevOutdoorAmbient")
put("Brightness", "KitPrevBrightness")
put("ClockTime", "KitPrevClockTime")
local atmosphere = Lighting:FindFirstChild("KitAtmosphere")
if atmosphere then atmosphere:Destroy() end
local grade = Lighting:FindFirstChild("KitColorCorrection")
if grade then grade:Destroy() end
for _, key in { "KitScene", "KitPrevAmbient", "KitPrevOutdoorAmbient", "KitPrevBrightness", "KitPrevClockTime" } do
	Lighting:SetAttribute(key, nil)
end
return "lighting restored"`;

/**
 * Lighting and a floor, applied whether or not the agent thought to ask.
 *
 * Both calls are idempotent, so running this ahead of every world step costs
 * nothing and removes the two omissions that most reliably make a build look
 * unfinished. This is the substrate argument at its bluntest: the model does
 * not get the chance to forget.
 */
export const KIT_BOOTSTRAP_LUAU = 'kit.scene()\nkit.ground(sandbox)';

export interface WithKitOptions {
  /** Apply lighting and a ground plane before the agent's code runs. */
  bootstrap?: boolean;
}

/**
 * Wraps a world-building step so `kit` is in scope for it.
 *
 * The agent's own code goes inside a `do ... end` block. That is not cosmetic:
 * `Authoring` executes each step on its own but replays them concatenated when
 * a contract rebuilds the world, so an unscoped step could reference a local
 * from an earlier step during the replay and fail during the live build. The
 * block makes both paths behave identically, and keeps each step's locals out
 * of the 200-local budget of the concatenated setup.
 */
export function withKit(luau: string, options: WithKitOptions = {}): string {
  const bootstrap = options.bootstrap === false ? '' : `${KIT_BOOTSTRAP_LUAU}\n`;
  return `${KIT_LUAU}\n${bootstrap}do\n${luau}\nend`;
}

/**
 * The kit's API, as the agent is told about it.
 *
 * Written as a flat list of call signatures with the y-convention stated twice,
 * because that convention is the single thing a small model gets wrong most
 * often and the one that produces the most obviously broken-looking world.
 */
export const KIT_BRIEF = `A \`kit\` table is already in scope. Build with it instead of Instance.new —
it handles colour, material, proportion, grid alignment and lighting for you.

  kit.platform(sandbox, x, y, z, width, depth, name)  -- y is the surface you stand on
  kit.wall(sandbox, x, y, z, length, axis, name)      -- axis "x" or "z", 8 studs tall
  kit.door(sandbox, x, y, z, axis, name)
  kit.coin(sandbox, x, y, z, name)                    -- hovers above y, already reads as a coin
  kit.chest(sandbox, x, y, z, name)                   -- a container, for lockable mechanics
  kit.hazard(sandbox, x, y, z, width, depth, name)
  kit.spawn(sandbox, x, y, z, name)
  kit.decor(sandbox, x, y, z, kind, name)             -- kind "pillar" | "bush" | "crystal"
  kit.ground(sandbox, size, name)
  kit.tint(instance, colour)                          -- ${PALETTE.map(entry => entry.name).join(' | ')}
  kit.light(part, colour, brightness, range)

In every constructor, y is the height of the GROUND the object stands on. The
kit lifts the object itself, so y = 0 puts something on the floor, never inside
it. Positions snap to a ${String(GRID_STUDS)}-stud grid.

Each constructor returns the instance, so attach Attributes to it as usual:

  local coin = kit.coin(sandbox, 8, 0, 0, "Coin")
  coin:SetAttribute("Value", 1)

Colours: ${PALETTE.map(entry => `${entry.name} (${entry.use})`).join(', ')}.
Use kit.tint to recolour; do not invent colours, and do not set Color or
Material by hand — the build is checked against this palette.`;
