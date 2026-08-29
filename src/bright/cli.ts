import { join } from 'node:path';
import { StudioSession } from '../verifier/studio.js';
import { buildCurriculum } from './curriculum.js';
import { applyRepairs, extract, fetchDocument, proposeRepairs } from './pipeline.js';
import { loadSpec } from './spec.js';

/**
 * The data pipeline, end to end.
 *
 *   npx tsx src/bright/cli.ts                                  # normal run
 *   npx tsx src/bright/cli.ts --break                          # simulate a redesign
 *   npx tsx src/bright/cli.ts --break --repair                 # and recover from it
 *   npx tsx src/bright/cli.ts --adjudicate                      # let the engine rule on it
 *
 * `--break` points the fetcher at a fixture of the same page after a redesign:
 * same information, none of the original selectors. `--repair` then recovers
 * the fields by shape and writes the fixed spec back to disk, so the repair is
 * a commit rather than a runtime patch.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const SPEC_PATH = process.env.PLACEBO_SCRAPER ?? join(ROOT, 'scrapers', 'roblox-deprecations.yaml');
const FIXTURES = join(ROOT, 'fixtures');

async function main(): Promise<void> {
  const broken = process.argv.includes('--break');
  const repair = process.argv.includes('--repair');

  let spec = loadSpec(SPEC_PATH);
  process.stdout.write(`\nscraper ${spec.name}  revision ${String(spec.revision)}\n`);
  process.stdout.write(`  ${spec.url}\n`);

  const fetched = await fetchDocument(
    spec,
    FIXTURES,
    broken ? 'roblox-deprecations-v2-redesigned.html' : undefined,
  );
  process.stdout.write(
    `  fetched via ${fetched.via}${broken ? '  (simulating a site redesign)' : ''}\n\n`,
  );

  let result = extract(spec, fetched.html);
  report(result);

  if (result.brokenFields.length > 0 && repair) {
    process.stdout.write(`\n  repairing ${result.brokenFields.join(', ')} by shape...\n`);
    const proposals = proposeRepairs(spec, fetched.html, result.brokenFields);

    if (proposals.length === 0) {
      process.stdout.write(`  no candidate matched the expected shapes; a human is needed here.\n\n`);
      process.exitCode = 1;
      return;
    }

    for (const proposal of proposals) {
      process.stdout.write(
        `    ${proposal.field.padEnd(15)} ${proposal.from}  ->  ${proposal.to}   (${proposal.reason})\n`,
      );
    }

    spec = applyRepairs(spec, proposals, SPEC_PATH);
    process.stdout.write(`\n  spec written back at revision ${String(spec.revision)}\n\n`);

    result = extract(spec, fetched.html);
    report(result);
  }

  if (result.brokenFields.length > 0) {
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\n  ${String(result.records.length)} records extracted\n`);

  if (!process.argv.includes('--adjudicate')) {
    process.stdout.write(`  (pass --adjudicate to have the engine rule on them)\n\n`);
    return;
  }

  // Nothing scraped becomes a task until the running engine confirms it.
  const session = new StudioSession();
  await session.connect();
  const items = await buildCurriculum({ session, records: result.records });
  await session.close();

  process.stdout.write(`\n  the engine adjudicates:\n\n`);
  for (const item of items) {
    const mark = item.verdict === 'confirmed' ? 'CONFIRMED' : 'DROPPED';
    process.stdout.write(
      `    ${mark.padEnd(10)} ${String(item.record.class_name)}.${String(item.record.member)}\n` +
        `               ${item.detail}\n`,
    );
  }

  const confirmed = items.filter(item => item.proposal);
  process.stdout.write(
    `\n  ${String(confirmed.length)}/${String(items.length)} claims survived the engine and became tasks:\n`,
  );
  for (const item of confirmed) {
    process.stdout.write(`    ${item.proposal?.id}: ${item.proposal?.goal}\n`);
  }
  process.stdout.write('\n');
}

function report(result: ReturnType<typeof extract>): void {
  process.stdout.write(
    `  ${String(result.records.length)}/${String(result.recordCount)} records extracted` +
      (result.brokenFields.length > 0
        ? `   BROKEN FIELDS: ${result.brokenFields.join(', ')}\n`
        : `   all fields healthy\n`),
  );
  for (const record of result.records.slice(0, 4)) {
    process.stdout.write(`    ${JSON.stringify(record)}\n`);
  }
}

await main();
