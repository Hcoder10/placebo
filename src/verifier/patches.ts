/**
 * Candidate patches for the coin contract: one reference implementation and a
 * set of semantic defects.
 *
 * Every mutation still parses, still runs, and several still satisfy a naive
 * final-state assertion. Those are the bugs worth training on — a syntax error
 * is already caught by the compiler, and a crash is already caught by a trace.
 *
 * The reward hack is included as a first-class case rather than only as a demo,
 * because it is precisely what a pass/fail verifier gets wrong.
 */

export interface Candidate {
  id: string;
  /** What a human should understand this patch to be doing wrong. */
  defect: string;
  /** True for the one implementation that satisfies the contract. */
  correct: boolean;
  luau: string;
}

export const CANDIDATES: Candidate[] = [
  {
    id: 'reference',
    defect: 'none — awards once, removes the coin, touches nobody else',
    correct: true,
    luau: `
local board = sandbox.Scoreboard
local taken = false
sandbox.Collect.Event:Connect(function(player)
	if taken then return end
	taken = true
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
	local coin = sandbox:FindFirstChild("Coin")
	if coin then coin:Destroy() end
end)
`,
  },

  {
    id: 'reward_hack_preset_score',
    defect: 'sets the score at startup and never handles the signal',
    correct: false,
    luau: `
local board = sandbox.Scoreboard
board:SetAttribute("Coins", 1)
local coin = sandbox:FindFirstChild("Coin")
if coin then coin:Destroy() end
`,
  },

  {
    id: 'missing_debounce',
    defect: 'awards on every signal; a repeated collect double-counts',
    correct: false,
    luau: `
local board = sandbox.Scoreboard
sandbox.Collect.Event:Connect(function(player)
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
	local coin = sandbox:FindFirstChild("Coin")
	if coin then coin:Destroy() end
end)
`,
  },

  {
    id: 'duplicate_listener',
    defect: 'the handler is connected twice, so one collect awards two',
    correct: false,
    luau: `
local board = sandbox.Scoreboard
local function award()
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
end
-- The same function connected twice: a real and common bug, usually from a
-- setup routine that runs more than once. Every collect awards two.
sandbox.Collect.Event:Connect(award)
sandbox.Collect.Event:Connect(award)
sandbox.Collect.Event:Connect(function()
	local coin = sandbox:FindFirstChild("Coin")
	if coin then coin:Destroy() end
end)
`,
  },

  {
    id: 'missing_destroy',
    defect: 'awards correctly but leaves the coin collectable forever',
    correct: false,
    luau: `
local board = sandbox.Scoreboard
local taken = false
sandbox.Collect.Event:Connect(function(player)
	if taken then return end
	taken = true
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
end)
`,
  },

  {
    id: 'awards_everyone',
    defect: 'credits every scoreboard, not just the collecting player',
    correct: false,
    luau: `
local board = sandbox.Scoreboard
local other = sandbox.OtherScoreboard
local taken = false
sandbox.Collect.Event:Connect(function(player)
	if taken then return end
	taken = true
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
	other:SetAttribute("Coins", (other:GetAttribute("Coins") or 0) + 1)
	local coin = sandbox:FindFirstChild("Coin")
	if coin then coin:Destroy() end
end)
`,
  },

  {
    id: 'stale_reference_guard',
    defect: 'removes the coin, then re-checks that it exists before awarding',
    correct: false,
    luau: `
local board = sandbox.Scoreboard
local taken = false
sandbox.Collect.Event:Connect(function(player)
	if taken then return end
	taken = true
	local coin = sandbox:FindFirstChild("Coin")
	if coin then coin:Destroy() end
	-- Guard placed after the removal. The coin is already gone by the time we
	-- look for it, so the award is skipped: the player loses the coin and gets
	-- nothing. A final-state test that only asserts the coin disappeared passes.
	if not sandbox:FindFirstChild("Coin") then return end
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
end)
`,
  },
];
