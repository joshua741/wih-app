import { test } from 'node:test';
import assert from 'node:assert';
import { cleanTags, categorize } from './categorize';

test('cleanTags splits, lowercases, trims, dedupes', () => {
  assert.deepEqual(cleanTags('Lubbock, rent to own buyer ,Lubbock'), ['lubbock', 'rent to own buyer']);
  assert.deepEqual(cleanTags(''), []);
});

test('categorize: tag wins first (rto)', () => {
  const r = categorize({}, ['rent to own buyer']);
  assert.equal(r.category, 'rto_tenant');
  assert.ok(r.categories.includes('rto_tenant'));
});

test('categorize: insurance tag variants map to insurance_agent', () => {
  assert.equal(categorize({}, ['insurance-agent']).category, 'insurance_agent');
  assert.equal(categorize({}, ['insurance agent']).category, 'insurance_agent');
});

test('categorize: field-cluster inference when no tag (title company)', () => {
  const r = categorize({ 'Name of Title Company': 'ABC Title' }, []);
  assert.equal(r.category, 'title_agent');
});

test('categorize: defaults to uncategorized', () => {
  assert.equal(categorize({}, []).category, 'uncategorized');
});

test('categorize: junk flag from landline tag', () => {
  assert.equal(categorize({}, ['landline']).isJunk, true);
});

test('categorize: junk when no name and no email', () => {
  assert.equal(categorize({ 'First Name': '', 'Last Name': '', 'Email': '' }, []).isJunk, true);
});
