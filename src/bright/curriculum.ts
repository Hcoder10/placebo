import type { StudioSession } from '../verifier/studio.js';
import type { Record_ } from './pipeline.js';

/**
 * The web proposes what changed; the engine decides what is true.
 *
 * Scraped pages are a rich source of *candidate* work — an API was deprecated,
 * a method was replaced — and a completely untrustworthy source of fact. Docs
 * go stale, pages describe unreleased features, and a scraper that has just
 * repaired itself may have latched onto the wrong column.
 *
 * So nothing scraped becomes a training task until the running engine confirms
 * it. Each claim is checked against a live Roblox Studio: does the class exist,
 * does the deprecated member still resolve on it, does the suggested
 * replacement resolve. A claim that fails is not an error — it is the pipeline
 * working, and it is dropped with a reason.
 */

export type Adjudication =
  | 'confirmed'
  | 'already-removed'
  | 'no-such-class'
  | 'not-instantiable'
  | 'no-such-replacement';

export interface CurriculumItem {
  record: Record_;
  verdict: Adjudication;
  /** Why the engine reached that verdict, in one line. */
  detail: string;
  /** Present only for confirmed items: the task this claim justifies. */
  proposal?: {
    id: string;
    goal: string;
    deprecated: string;
    replacement: string;
  };
}

/**
 * Asks the live engine about one claim.
 *
 * Runs entirely inside a pcall: a fictional class name from a bad scrape must
 * come back as a verdict, not as a thrown error that stops the batch.
 */
async function adjudicate(session: StudioSession, record: Record_): Promise<CurriculumItem> {
  const className = record.class_name ?? '';
  const member = record.member ?? '';
  const replacement = record.replacement ?? '';

  const raw = await session.luau(`
local HttpService = game:GetService("HttpService")
local className, member, replacement = ${JSON.stringify(className)}, ${JSON.stringify(member)}, ${JSON.stringify(replacement)}

-- Three ways a class can be reachable, and they are not interchangeable:
-- a creatable Instance, a singleton service, or an abstract base that cannot
-- be built at all. Reporting an abstract class as "does not exist" would be a
-- wrong answer dressed as a confident one.
local probe, kind = nil, nil

local okInstance, made = pcall(function() return Instance.new(className) end)
if okInstance and made then
	probe, kind = made, "instance"
else
	local okService, service = pcall(function() return game:GetService(className) end)
	if okService and service then
		probe, kind = service, "service"
	end
end

if not probe then
	return HttpService:JSONEncode({ classExists = false, instantiable = false })
end

local function resolves(name)
	local ok, value = pcall(function() return (probe :: any)[name] end)
	return ok and value ~= nil
end

local result = {
	classExists = true,
	instantiable = true,
	kind = kind,
	memberExists = resolves(member),
	replacementExists = resolves(replacement),
}
-- Services are singletons owned by the DataModel; destroying one would take
-- the place down with it.
if kind == "instance" then
	probe:Destroy()
end
return HttpService:JSONEncode(result)
`);

  const parsed =
    typeof raw === 'string'
      ? (JSON.parse(raw) as {
          classExists: boolean;
          instantiable?: boolean;
          kind?: string;
          memberExists?: boolean;
          replacementExists?: boolean;
        })
      : { classExists: false };

  if (!parsed.classExists) {
    return {
      record,
      verdict: 'not-instantiable',
      detail: `${className} is neither creatable nor a service — abstract, or the scrape read the wrong column`,
    };
  }
  if (!parsed.memberExists) {
    return {
      record,
      verdict: 'already-removed',
      detail: `${className}.${member} no longer resolves — the deprecation already completed`,
    };
  }
  if (!parsed.replacementExists) {
    return {
      record,
      verdict: 'no-such-replacement',
      detail: `${className}.${replacement} does not resolve, so there is nothing to migrate to`,
    };
  }

  return {
    record,
    verdict: 'confirmed',
    detail: `${className}.${member} and ${className}.${replacement} both resolve in this engine`,
    proposal: {
      id: `migrate_${className.toLowerCase()}_${member.toLowerCase()}`,
      goal: `Replace ${className}.${member} with ${className}.${replacement}, keeping the behaviour identical.`,
      deprecated: `${className}.${member}`,
      replacement: `${className}.${replacement}`,
    },
  };
}

export async function buildCurriculum(params: {
  session: StudioSession;
  records: Record_[];
}): Promise<CurriculumItem[]> {
  const items: CurriculumItem[] = [];
  for (const record of params.records) {
    items.push(await adjudicate(params.session, record));
  }
  return items;
}
