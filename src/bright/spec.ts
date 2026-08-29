import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

/**
 * A scraper is a versioned file, not a command someone once ran.
 *
 * Selectors live in `scrapers/*.yaml` next to the code and under version
 * control, so when a vendor reshuffles their markup the repair arrives as a
 * reviewable diff with a bumped revision rather than an edit to a string buried
 * in a source file. `revision` is the count of how many times the web moved
 * underneath us.
 */

export const FieldSpecSchema = z
  .object({
    /** CSS selector applied to the fetched document. */
    selector: z.string().min(1),
    /** Read an attribute instead of the text content. */
    attr: z.string().optional(),
    /** Optional regex; the first capture group, or the whole match, is taken. */
    pattern: z.string().optional(),
    /**
     * What a valid value for this field looks like.
     *
     * This is the field's identity, independent of where it currently sits in
     * the DOM — which is what makes automatic recovery possible when the
     * selector stops matching.
     */
    validator: z.enum(['semver', 'identifier', 'class-name', 'sentence', 'enum']),
    /** Permitted values when `validator` is `enum`. */
    values: z.array(z.string()).optional(),
  })
  .strict();

export type FieldSpec = z.infer<typeof FieldSpecSchema>;

export const ScraperSpecSchema = z
  .object({
    name: z.string().min(1),
    /** Bumped on every repair, so `git log` shows how often the site moved. */
    revision: z.number().int().min(1),
    description: z.string().min(1),
    url: z.string().min(1),
    fetch: z
      .object({
        via: z.enum(['brightdata', 'direct', 'fixture']),
        /** Bright Data zone; ignored by the other fetchers. */
        zone: z.string().optional(),
        /** Local file for `via: fixture`, relative to the fixtures directory. */
        fixture: z.string().optional(),
      })
      .strict(),
    /** The repeating element each record is extracted from. */
    record_selector: z.string().min(1),
    fields: z.record(z.string(), FieldSpecSchema),
    /** Appended by the repairer, so a spec carries its own history. */
    repairs: z
      .array(
        z.object({
          at: z.string(),
          field: z.string(),
          from: z.string(),
          to: z.string(),
          reason: z.string(),
        }),
      )
      .default([]),
  })
  .strict();

export type ScraperSpec = z.infer<typeof ScraperSpecSchema>;

export function loadSpec(path: string): ScraperSpec {
  const parsed = ScraperSpecSchema.safeParse(parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(
      `invalid scraper spec at ${path}:\n${parsed.error.issues
        .map(issue => `  ${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  return parsed.data;
}

/** Writes a repaired spec back, so the fix is committed rather than in memory. */
export function saveSpec(path: string, spec: ScraperSpec): void {
  writeFileSync(path, stringify(spec, { lineWidth: 90 }), 'utf8');
}

const VALIDATORS: Record<FieldSpec['validator'], (value: string, spec: FieldSpec) => boolean> = {
  semver: value => /^\d+\.\d+(\.\d+)?$/.test(value.trim()),
  identifier: value => /^[A-Za-z_][A-Za-z0-9_]{1,63}$/.test(value.trim()),
  'class-name': value => /^[A-Z][A-Za-z0-9]{1,63}$/.test(value.trim()),
  sentence: value => value.trim().length >= 12 && value.trim().length <= 400,
  enum: (value, spec) => (spec.values ?? []).includes(value.trim().toLowerCase()),
};

/** Whether a candidate value could be this field, judged on shape alone. */
export function isValidFor(field: FieldSpec, value: string): boolean {
  return VALIDATORS[field.validator](value, field);
}
