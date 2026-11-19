import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// The generalization guard: after P1 the machinery is field-agnostic, and the
// only places that may still name the price field or a cent amount in code are
// the price field's own registration, its business entries and templates, the
// order table that copies its value, the report hook that explains a money
// difference, the console's money formatter, and tests/scripts/demo data. A
// new hit anywhere else means a price assumption crept back into shared code.

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Directories holding code, as repository-relative forward-slash prefixes. */
const SCANNED = ['packages', 'apps'];

/** Repository-relative path prefixes that MAY mention the price field. */
const ALLOWED_PREFIXES = [
  // The price field's registration and value codecs.
  'packages/domain/src/registry.ts',
  'packages/domain/src/values.ts',
  'packages/domain/src/money.ts',
  // Price business entries and their templates (the SQL API itself).
  'packages/domain/src/templates.ts',
  'packages/contracts/src/inputs.ts',
  // The price entries' value schema aliases over the generalized int64 codec.
  'packages/contracts/src/primitives.ts',
  'packages/contracts/src/results.ts',
  'packages/storage/migrations/',
  'packages/storage/src/business-entry.ts',
  // The order table copies the price it was struck at.
  'packages/storage/src/case-store.ts',
  'packages/storage/src/verifier-store.ts',
  'packages/storage/src/snapshot-reader.ts',
  'packages/verify/src/reader.ts',
  'packages/verify/src/model.ts',
  'packages/verify/src/export.ts',
  'packages/evidence/src/manifest.ts',
  'packages/evidence/src/checker/model.ts',
  'packages/evidence/src/checker/audit-checks.ts',
  'packages/evidence/src/tools.ts',
  'packages/casework/src/commands.ts',
  // The compiler and replay engine carry the price field's semantics.
  'packages/repair/src/semantics.ts',
  'packages/repair/src/engine.ts',
  // The scripted test double and the price question helper are price-specific
  // by construction: they exist to drive the price field in tests.
  'packages/agent/src/model/protocol-driver.ts',
  'packages/agent/src/tools/basis.ts',
  // The console's money formatting and its demo charter.
  'apps/web/src/lib/labels.ts',
  'packages/console/src/demo.ts',
];

const EXCLUDED_SEGMENTS = [
  `${sep}node_modules${sep}`,
  `${sep}dist${sep}`,
  `${sep}.next${sep}`,
  `${sep}test${sep}`,
  `${sep}scripts${sep}`,
];

const PATTERN = /price_cents|priceCents|\bCents\b/;

/**
 * Code without its comments. Prose may name the price field as an example; only
 * live code makes a price assumption, so the scan strips line and block
 * comments before matching.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

async function sources(dir: string): Promise<string[]> {
  const absolute = join(ROOT, dir);
  const entries = await readdir(absolute, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => /\.(ts|tsx|sql)$/.test(path))
    .filter((path) => !EXCLUDED_SEGMENTS.some((segment) => path.includes(segment)));
}

describe('price coupling whitelist', () => {
  it('names the price field only where the price field is implemented', async () => {
    const offenders: string[] = [];
    for (const dir of SCANNED) {
      for (const path of await sources(dir)) {
        const repositoryPath = relative(ROOT, path).split(sep).join('/');
        if (ALLOWED_PREFIXES.some((prefix) => repositoryPath.startsWith(prefix))) {
          continue;
        }
        const text = code(readFileSync(path, 'utf8'));
        const hit = PATTERN.exec(text);
        if (hit !== null) {
          const line = text.slice(0, hit.index).split('\n').length;
          offenders.push(`${repositoryPath}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
