import { join } from 'node:path';
import { loadContract } from './contract.js';
import { evaluate } from './effect.js';
import { CANDIDATES } from './patches.js';
import { StudioSession } from './studio.js';

/**
 * Scores every candidate patch against the contract, in a live Roblox Studio.
 *
 *   npm run verify
 *   npm run verify -- --json
 *
 * The reference must be ACCEPTED and every defect REJECTED. A defect that slips
 * through means the contract is too weak — that is what this table is for, and
 * it has already caught two weak contracts today.
 */

const ROOT = join(import.meta.dirname, '..', '..');

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');
  const contract = loadContract(join(ROOT, 'contracts', 'coin_awards_once.yaml'));

  const session = new StudioSession();
  const attached = await session.connect();

  const rows: Record<string, unknown>[] = [];
  for (const candidate of CANDIDATES) {
    const verdict = await evaluate({ session, contract, patchLuau: candidate.luau });
    rows.push({
      case: candidate.id,
      expected: candidate.correct ? 'ACCEPT' : 'REJECT',
      got: verdict.accepted ? 'ACCEPT' : 'REJECT',
      defect: candidate.defect,
      ...verdict,
    });
  }

  await session.close();

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ contract: contract.id, results: rows }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`\nStudio place ${attached.placeId || '(unsaved)'}, session ${attached.token.slice(0, 8)}\n`);
  process.stdout.write(`contract: ${contract.id}  (${contract.realizations.length} realizations, ${String(contract.controls.length)} controls)\n`);
  process.stdout.write(`  ${contract.requirement.trim()}\n\n`);
  process.stdout.write(`  ${'case'.padEnd(26)} ${'want'.padEnd(7)} ${'got'.padEnd(7)} ${'stable'.padEnd(7)} why\n`);
  process.stdout.write(`  ${'-'.repeat(26)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(40)}\n`);

  let agreed = 0;
  for (const row of rows) {
    const ok = row.got === row.expected;
    agreed += ok ? 1 : 0;
    const why = row.error
      ? `error: ${String(row.error).slice(0, 38)}`
      : row.inert
        ? 'no causal effect (identical to control)'
        : (row.missing as string[]).length || (row.collateral as string[]).length
          ? [
              (row.missing as string[]).length ? `missing ${JSON.stringify(row.missing)}` : '',
              (row.collateral as string[]).length ? `collateral ${JSON.stringify(row.collateral)}` : '',
            ]
              .filter(Boolean)
              .join('; ')
          : `caused ${JSON.stringify(Object.keys(row.observed as object))}`;

    process.stdout.write(
      `  ${String(row.case).padEnd(26)} ${String(row.expected).padEnd(7)} ${String(row.got).padEnd(7)} ${String(row.stable).padEnd(7)} ${why}${ok ? '' : '   <-- DISAGREES'}\n`,
    );
  }

  process.stdout.write(`\n  ${String(agreed)}/${String(rows.length)} cases scored as expected\n\n`);
  if (agreed !== rows.length) process.exitCode = 1;
}

await main();
