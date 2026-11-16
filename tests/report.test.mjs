import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { countEntries } from '../src/report.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/report.json', import.meta.url), 'utf8'));

test('countEntries counts each tag, and rollbacks by live state', () => {
  assert.deepEqual(countEntries(fixture()), { found: 2, proposed: 2, did: 2, rolledBack: 1 });
});

test('countEntries of a report with no entries is all zeros', () => {
  assert.deepEqual(countEntries({ entries: [] }), { found: 0, proposed: 0, did: 0, rolledBack: 0 });
  assert.deepEqual(countEntries({}), { found: 0, proposed: 0, did: 0, rolledBack: 0 });
});
