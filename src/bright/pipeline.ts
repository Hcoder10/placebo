import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { isValidFor, saveSpec, type FieldSpec, type ScraperSpec } from './spec.js';

/**
 * Fetch, extract, and repair.
 *
 * The repair step is the point. A scraper that works today is not a pipeline;
 * a pipeline notices when the page moved and puts itself back together. This
 * one recovers *structurally* — each field declares what a valid value looks
 * like, so when a selector stops matching we search the document for elements
 * whose text still satisfies that shape and adopt the best candidate.
 *
 * Recovering on shape rather than on markup has two properties worth having:
 * it is deterministic and therefore testable, and it needs no model, so the
 * data pipeline keeps working when the network or a GPU does not.
 */

export interface FetchResult {
  html: string;
  via: string;
  fetchedAt: string;
  url: string;
}

export async function fetchDocument(
  spec: ScraperSpec,
  fixturesDir: string,
  overrideFixture?: string,
): Promise<FetchResult> {
  const base = { via: spec.fetch.via, fetchedAt: new Date().toISOString(), url: spec.url };

  if (spec.fetch.via === 'fixture' || overrideFixture) {
    const name = overrideFixture ?? spec.fetch.fixture;
    if (!name) throw new Error(`${spec.name}: fetch.via is "fixture" but no fixture is named`);
    const path = join(fixturesDir, name);
    if (!existsSync(path)) throw new Error(`fixture not found: ${path}`);
    return { ...base, via: 'fixture', html: readFileSync(path, 'utf8') };
  }

  if (spec.fetch.via === 'brightdata') {
    const token = process.env.BRIGHTDATA_API_KEY;
    if (!token) throw new Error('BRIGHTDATA_API_KEY is not set');

    const response = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        zone: spec.fetch.zone ?? process.env.BRIGHTDATA_ZONE ?? 'web_unlocker1',
        url: spec.url,
        format: 'raw',
      }),
    });
    if (!response.ok) {
      throw new Error(`Bright Data returned ${String(response.status)}: ${(await response.text()).slice(0, 200)}`);
    }
    return { ...base, html: await response.text() };
  }

  const response = await fetch(spec.url, { headers: { 'user-agent': 'placebo-curriculum/0.1' } });
  if (!response.ok) throw new Error(`${spec.url} returned ${String(response.status)}`);
  return { ...base, html: await response.text() };
}

export type Record_ = Record<string, string>;

export interface ExtractionResult {
  records: Record_[];
  /** Fields whose selector matched nothing, or matched something invalid. */
  brokenFields: string[];
  recordCount: number;
}

function readField(scope: cheerio.Cheerio<AnyNode>, field: FieldSpec): string | null {
  const node = scope.find(field.selector).first();
  if (node.length === 0) return null;
  const raw = field.attr ? node.attr(field.attr) : node.text();
  if (raw === undefined) return null;
  const text = raw.trim().replace(/\s+/g, ' ');
  if (!field.pattern) return text;
  const match = new RegExp(field.pattern).exec(text);
  return match ? (match[1] ?? match[0]) : null;
}

export function extract(spec: ScraperSpec, html: string): ExtractionResult {
  const $ = cheerio.load(html);
  const scopes = $(spec.record_selector);
  const records: Record_[] = [];
  const broken = new Set<string>();

  scopes.each((_, element) => {
    const scope = $(element) as unknown as cheerio.Cheerio<never>;
    const record: Record_ = {};
    for (const [name, field] of Object.entries(spec.fields)) {
      const value = readField(scope, field);
      if (value === null || !isValidFor(field, value)) {
        broken.add(name);
      } else {
        record[name] = value;
      }
    }
    if (Object.keys(record).length > 0) records.push(record);
  });

  return { records, brokenFields: [...broken].sort(), recordCount: scopes.length };
}

export interface RepairProposal {
  field: string;
  from: string;
  to: string;
  /** How many records the candidate selector satisfies the validator on. */
  hits: number;
  reason: string;
}

/**
 * Finds a new selector for a field by looking for its *shape*.
 *
 * Every element inside a record scope is a candidate. We keep the ones whose
 * text validates for the field, then prefer the selector that works across the
 * most records — a field that only resolves on one row is a coincidence, not a
 * column.
 */
export function proposeRepairs(spec: ScraperSpec, html: string, fields: string[]): RepairProposal[] {
  const $ = cheerio.load(html);
  const scopes = $(spec.record_selector).toArray();
  if (scopes.length === 0) return [];

  const quorum = Math.max(1, Math.floor(scopes.length * 0.6));

  // Selectors already doing a job for a field that still works.
  const taken = new Set(
    Object.entries(spec.fields)
      .filter(([name]) => !fields.includes(name))
      .map(([, field]) => field.selector),
  );

  interface Candidate {
    selector: string;
    hits: number;
    /** Mean position within the record, used to disambiguate equal shapes. */
    position: number;
  }

  /** Shape-valid candidate selectors for one field, ranked by document order. */
  function candidatesFor(field: FieldSpec): Candidate[] {
    const hits = new Map<string, number>();
    const positions = new Map<string, number[]>();

    for (const scope of scopes) {
      const leaves = $(scope).find('*').toArray().filter(node => $(node).children().length === 0);

      leaves.forEach((node, index) => {
        const text = $(node).text().trim().replace(/\s+/g, ' ');
        if (!text) return;
        // Apply the field's own pattern before judging the shape. Without this
        // a field like "Released in 0.671" never looks like a semver, and a
        // perfectly recoverable column reads as unrecoverable.
        const extracted = applyPattern(field, text);
        if (extracted === null || !isValidFor(field, extracted)) return;

        for (const selector of candidateSelectors($, node as Element)) {
          hits.set(selector, (hits.get(selector) ?? 0) + 1);
          positions.set(selector, [...(positions.get(selector) ?? []), index]);
        }
      });
    }

    return [...hits.entries()]
      .filter(([selector, count]) => count >= quorum && !taken.has(selector))
      .map(([selector, count]) => ({
        selector,
        hits: count,
        position:
          (positions.get(selector) ?? [0]).reduce((a, b) => a + b, 0) /
          (positions.get(selector)?.length ?? 1),
      }))
      .sort((a, b) => a.position - b.position || b.selector.length - a.selector.length);
  }

  // Assign in the spec's declared field order, and never reuse a selector.
  //
  // Shape alone cannot separate two fields that hold the same kind of value —
  // "member" and "replacement" are both identifiers. Document order can: pages
  // that list fields do so in a stable order, so the k-th field takes the k-th
  // surviving column. This is an assumption, and it is the one that makes
  // same-shaped fields recoverable at all.
  const proposals: RepairProposal[] = [];
  const claimed = new Set<string>();

  for (const name of Object.keys(spec.fields)) {
    if (!fields.includes(name)) continue;
    const field = spec.fields[name];
    if (!field) continue;

    const choice = candidatesFor(field).find(candidate => !claimed.has(candidate.selector));
    if (!choice || choice.selector === field.selector) continue;

    claimed.add(choice.selector);
    proposals.push({
      field: name,
      from: field.selector,
      to: choice.selector,
      hits: choice.hits,
      reason: `${field.validator} shape in ${String(choice.hits)}/${String(scopes.length)} records, column ${String(Math.round(choice.position))}`,
    });
  }

  return proposals;
}

/** The field's pattern applied to raw text, or the text unchanged. */
function applyPattern(field: FieldSpec, text: string): string | null {
  if (!field.pattern) return text;
  const match = new RegExp(field.pattern).exec(text);
  return match ? (match[1] ?? match[0]) : null;
}

/** Stable, reasonably specific selectors for one element. */
function candidateSelectors($: cheerio.CheerioAPI, element: Element): string[] {
  const node = $(element);
  const tag = element.tagName ?? '';
  const out: string[] = [];

  // Data attributes first: they are the most stable thing a page offers.
  const attribs = element.attribs ?? {};
  for (const [key, value] of Object.entries(attribs)) {
    if (key.startsWith('data-') && value) out.push(`[${key}="${value}"]`);
  }

  const className = node.attr('class');
  if (className) {
    for (const part of className.split(/\s+/).filter(Boolean)) {
      out.push(`${tag}.${part}`);
      out.push(`.${part}`);
    }
  }

  return out;
}

/** Applies proposals to the spec, bumps the revision, and records the history. */
export function applyRepairs(spec: ScraperSpec, proposals: RepairProposal[], path: string): ScraperSpec {
  if (proposals.length === 0) return spec;

  const repaired: ScraperSpec = {
    ...spec,
    revision: spec.revision + 1,
    fields: { ...spec.fields },
    repairs: [
      ...spec.repairs,
      ...proposals.map(proposal => ({
        at: new Date().toISOString(),
        field: proposal.field,
        from: proposal.from,
        to: proposal.to,
        reason: proposal.reason,
      })),
    ],
  };

  for (const proposal of proposals) {
    const field = repaired.fields[proposal.field];
    if (field) repaired.fields[proposal.field] = { ...field, selector: proposal.to };
  }

  saveSpec(path, repaired);
  return repaired;
}
