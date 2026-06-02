import { test } from 'node:test';
import assert from 'node:assert';
import { parseCsv } from './csv';

test('parses simple rows', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a','b'],['1','2']]);
});

test('handles quoted commas and quoted newlines', () => {
  const rows = parseCsv('name,note\n"Doe, John","line1\nline2"\n');
  assert.deepEqual(rows, [['name','note'],['Doe, John','line1\nline2']]);
});

test('handles escaped double quotes', () => {
  assert.deepEqual(parseCsv('a\n"He said ""hi"""\n'), [['a'],['He said "hi"']]);
});
