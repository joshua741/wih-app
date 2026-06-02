import { test } from 'node:test';
import assert from 'node:assert';
import { buildFilterSql } from './filterSpec';

test('empty spec -> always-true clause, no params', () => {
  const { clause, params } = buildFilterSql({ combinator: 'AND', conditions: [] }, 1);
  assert.equal(clause, 'TRUE');
  assert.deepEqual(params, []);
});

test('core column "is" uses column directly + param', () => {
  const r = buildFilterSql({ combinator: 'AND', conditions: [
    { field: 'category', operator: 'is', value: 'seller' },
  ]}, 1);
  assert.match(r.clause, /category = \$1/);
  assert.deepEqual(r.params, ['seller']);
});

test('JSONB field "contains" uses data->> + ILIKE', () => {
  const r = buildFilterSql({ combinator: 'AND', conditions: [
    { field: 'City', operator: 'contains', value: 'lub' },
  ]}, 1);
  assert.match(r.clause, /data->>'City' ILIKE \$1/);
  assert.deepEqual(r.params, ['%lub%']);
});

test('OR combinator and is_empty (no param)', () => {
  const r = buildFilterSql({ combinator: 'OR', conditions: [
    { field: 'email_lower', operator: 'not_empty' },
    { field: 'phone_normalized', operator: 'not_empty' },
  ]}, 1);
  assert.match(r.clause, / OR /);
  assert.deepEqual(r.params, []);
});
