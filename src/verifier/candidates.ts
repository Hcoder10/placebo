import type { Task } from './task.js';

/**
 * The candidate pool an experiment draws from.
 *
 * These are the ways a Roblox mechanic actually goes wrong — missing guards,
 * duplicated connections, work done in the wrong order, state read after it was
 * destroyed. Every one still parses and still runs; several satisfy a naive
 * final-state assertion. A syntax error is already caught by the compiler and is
 * of no interest here.
 *
 * They exist for two jobs at once: as a calibration set for the verifier, and
 * as the candidate arms of a counterfactual patch group. Because every arm
 * starts from the same world and is labelled by the engine, the accepted and
 * rejected arms of one task form preference pairs with no annotator and no
 * reference implementation involved.
 */

export interface Candidate {
  id: string;
  /** What a reader should understand this candidate to be doing wrong. */
  defect: string;
  /**
   * What a human expected the verdict to be, where a human had an expectation.
   *
   * Undefined means nobody predicted anything -- which is the honest state for
   * a candidate sampled from the model rather than written by hand. The
   * distinction matters because this field is what the calibration harness
   * checks the verifier against: a sampled candidate labelled from the
   * verifier's own verdict would be scored as evidence that the verifier agrees
   * with itself. Leaving it undefined keeps those rows out of the calibration
   * set while still letting them into the training corpus, where the verdict is
   * the label and no prior expectation is needed.
   */
  correct?: boolean;
  luau: string;
}

/** Awards only when there is a coin to take, then removes it. */
const COIN_CORRECT = `
local board = sandbox.Scoreboard
sandbox.Collect.Event:Connect(function()
	local coin = sandbox:FindFirstChild("Coin")
	if not coin then return end
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
	coin:Destroy()
end)
`;

export const COIN_CANDIDATES: Candidate[] = [
  { id: 'correct', defect: 'none', correct: true, luau: COIN_CORRECT },

  {
    id: 'preset_score',
    defect: 'sets the score at startup and handles nothing',
    correct: false,
    luau: `
sandbox.Scoreboard:SetAttribute("Coins", 1)
local coin = sandbox:FindFirstChild("Coin")
if coin then coin:Destroy() end
`,
  },
  {
    id: 'no_guard',
    defect: 'awards on every collect, including ones with no coin left',
    correct: false,
    luau: `
local board = sandbox.Scoreboard
sandbox.Collect.Event:Connect(function()
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
	local coin = sandbox:FindFirstChild("Coin")
	if not coin then return end
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
end
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
sandbox.Collect.Event:Connect(function()
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
sandbox.Collect.Event:Connect(function()
	local coin = sandbox:FindFirstChild("Coin")
	if not coin then return end
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
	other:SetAttribute("Coins", (other:GetAttribute("Coins") or 0) + 1)
	coin:Destroy()
end)
`,
  },
  {
    id: 'stale_reference_guard',
    defect: 'removes the coin, then re-checks that it exists before awarding',
    correct: false,
    luau: `
local board = sandbox.Scoreboard
sandbox.Collect.Event:Connect(function()
	local coin = sandbox:FindFirstChild("Coin")
	if not coin then return end
	coin:Destroy()
	if not sandbox:FindFirstChild("Coin") then return end
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
end)
`,
  },
  {
    id: 'awards_two',
    defect: 'off-by-one: adds two points for one coin',
    correct: false,
    luau: `
local board = sandbox.Scoreboard
sandbox.Collect.Event:Connect(function()
	local coin = sandbox:FindFirstChild("Coin")
	if not coin then return end
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 2)
	coin:Destroy()
end)
`,
  },
  {
    id: 'overwrites_score',
    defect: 'assigns instead of incrementing, so the score never accumulates',
    correct: false,
    luau: `
local board = sandbox.Scoreboard
sandbox.Collect.Event:Connect(function()
	local coin = sandbox:FindFirstChild("Coin")
	if not coin then return end
	board:SetAttribute("Coins", 1)
	coin:Destroy()
end)
`,
  },
  {
    id: 'wrong_board',
    defect: 'awards the wrong scoreboard entirely',
    correct: false,
    luau: `
local other = sandbox.OtherScoreboard
sandbox.Collect.Event:Connect(function()
	local coin = sandbox:FindFirstChild("Coin")
	if not coin then return end
	other:SetAttribute("Coins", (other:GetAttribute("Coins") or 0) + 1)
	coin:Destroy()
end)
`,
  },
  {
    id: 'never_connects',
    defect: 'defines the handler and forgets to connect it',
    correct: false,
    luau: `
local board = sandbox.Scoreboard
local function award()
	local coin = sandbox:FindFirstChild("Coin")
	if not coin then return end
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
	coin:Destroy()
end
`,
  },
  {
    id: 'destroys_only',
    defect: 'removes the coin and never awards anything',
    correct: false,
    luau: `
sandbox.Collect.Event:Connect(function()
	local coin = sandbox:FindFirstChild("Coin")
	if coin then coin:Destroy() end
end)
`,
  },
];

/** Adds the door on top of the working coin mechanic. */
const DOOR_CORRECT = `
local board = sandbox.Scoreboard
local door = sandbox.Door
sandbox.Collect.Event:Connect(function()
	local coin = sandbox:FindFirstChild("Coin")
	if not coin then return end
	local total = (board:GetAttribute("Coins") or 0) + 1
	board:SetAttribute("Coins", total)
	coin:Destroy()
	if total >= 3 then
		door:SetAttribute("Open", true)
	end
end)
`;

export const DOOR_CANDIDATES: Candidate[] = [
  { id: 'adds_door_keeps_coin', defect: 'none', correct: true, luau: DOOR_CORRECT },

  {
    id: 'door_replaces_coin',
    defect: 'rewrites the handler for the door and forgets to award',
    correct: false,
    luau: `
local door = sandbox.Door
local seen = 0
sandbox.Collect.Event:Connect(function()
	seen += 1
	local coin = sandbox:FindFirstChild("Coin")
	if coin then coin:Destroy() end
	if seen >= 3 then
		door:SetAttribute("Open", true)
	end
end)
`,
  },
  {
    id: 'door_opens_immediately',
    defect: 'opens the door on the first collect, not the third',
    correct: false,
    luau: `
local board = sandbox.Scoreboard
local door = sandbox.Door
sandbox.Collect.Event:Connect(function()
	local coin = sandbox:FindFirstChild("Coin")
	if not coin then return end
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
	coin:Destroy()
	door:SetAttribute("Open", true)
end)
`,
  },
  {
    id: 'door_opens_at_startup',
    defect: 'opens the door when the game starts; the end state looks right',
    correct: false,
    luau: `
local board = sandbox.Scoreboard
sandbox.Door:SetAttribute("Open", true)
sandbox.Collect.Event:Connect(function()
	local coin = sandbox:FindFirstChild("Coin")
	if not coin then return end
	board:SetAttribute("Coins", (board:GetAttribute("Coins") or 0) + 1)
	coin:Destroy()
end)
`,
  },
  {
    id: 'door_off_by_one',
    defect: 'opens on the fourth coin, one later than the requirement',
    correct: false,
    luau: `
local board = sandbox.Scoreboard
local door = sandbox.Door
sandbox.Collect.Event:Connect(function()
	local coin = sandbox:FindFirstChild("Coin")
	if not coin then return end
	local total = (board:GetAttribute("Coins") or 0) + 1
	board:SetAttribute("Coins", total)
	coin:Destroy()
	if total > 3 then
		door:SetAttribute("Open", true)
	end
end)
`,
  },
  {
    id: 'door_forgets_coin_guard',
    defect: 'opens the door correctly but double-counts the score',
    correct: false,
    luau: `
local board = sandbox.Scoreboard
local door = sandbox.Door
sandbox.Collect.Event:Connect(function()
	local total = (board:GetAttribute("Coins") or 0) + 1
	board:SetAttribute("Coins", total)
	local coin = sandbox:FindFirstChild("Coin")
	if coin then coin:Destroy() end
	if total >= 3 then
		door:SetAttribute("Open", true)
	end
end)
`,
  },
];

/** The candidate pool appropriate to a task. */
export function candidatesFor(task: Task): Candidate[] {
  // Empty, not "the coin ones", when nothing matches.
  //
  // This used to fall through to COIN_CANDIDATES for any task that was not the
  // door, which is fine while the only tasks are coin and door and quietly
  // wrong the moment there is a third. Running the flywheel on a generated
  // deprecation task injected twelve coin-mechanic programs as its negatives
  // and produced sixty preference pairs teaching the model that coin code is
  // the wrong answer to an API-migration prompt. They were not wrong exactly --
  // the engine did reject them -- which is what makes it the bad kind of bug:
  // every row was correctly labelled and the whole set was meaningless.
  //
  // A task with no hand-authored candidates now contributes none. Sampling from
  // the model supplies its candidates instead, which is where they should come
  // from for anything the author did not anticipate.
  const contracts = task.contracts.join(' ');
  if (contracts.includes('door')) return DOOR_CANDIDATES;
  if (contracts.includes('coin')) return COIN_CANDIDATES;
  return [];
}
