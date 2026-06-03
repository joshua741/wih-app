import { test } from 'node:test';
import assert from 'node:assert';
import { cleanTags, categorize, ALL_CATEGORIES } from './categorize';

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

test('ALL_CATEGORIES includes the known label set', () => {
  assert.ok(ALL_CATEGORIES.includes('seller'));
  assert.ok(ALL_CATEGORIES.includes('pml'));
  assert.ok(ALL_CATEGORIES.includes('uncategorized'));
  assert.equal(ALL_CATEGORIES.length, 12);
});

test('categorize: Possible Exit Strategy value maps to label', () => {
  assert.equal(categorize({ 'Possible Exit Strategy': 'In House (Rent To Own)' }, []).category, 'rto_tenant');
  assert.equal(categorize({ 'Possible Exit Strategy': 'Wholesale (Sub 2)' }, []).category, 'seller');
});

test('categorize: a contact can hold multiple labels', () => {
  const r = categorize({ 'Name of Title Company': 'ABC Title' }, ['seller']);
  assert.ok(r.categories.includes('seller'));
  assert.ok(r.categories.includes('title_agent'));
  assert.ok(r.categories.length >= 2);
});

test('categorize: wrong number tag is junk', () => {
  assert.equal(categorize({ 'First Name': 'Joe', 'Email': 'a@b.com' }, ['wrong number']).isJunk, true);
});
