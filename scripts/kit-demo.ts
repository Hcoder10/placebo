import { StudioSession } from './src/verifier/studio.js';
import { withKit } from './src/verifier/kit.js';
import { inspectDesign, renderDesignReport } from './src/verifier/design.js';

const session = new StudioSession();
await session.connect();

// A small level built entirely through the kit, the way the agent is now told to.
const build = `
kit.spawn(sandbox, 0, 1, 0)
kit.platform(sandbox, 0, 0, 16, 12, 8)
kit.platform(sandbox, 10, 4, 26, 8, 8)
kit.platform(sandbox, -8, 8, 34, 8, 8)
kit.coin(sandbox, 10, 7, 26)
kit.coin(sandbox, -8, 11, 34)
kit.hazard(sandbox, 0, 0, 26, 10, 6)
kit.door(sandbox, -8, 10, 42, "z")
kit.decor(sandbox, 14, 1, 10, "tree")
kit.decor(sandbox, -14, 1, 20, "crystal")
`;

await session.luau(`
local sandbox = workspace:FindFirstChild("PlaceboKitDemo")
if sandbox then sandbox:Destroy() end
sandbox = Instance.new("Folder")
sandbox.Name = "PlaceboKitDemo"
sandbox.Parent = workspace
${withKit(build)}
return "built"
`);

const report = await inspectDesign(session, 'PlaceboKitDemo');
console.log(renderDesignReport(report));
await session.close();
