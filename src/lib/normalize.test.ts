import { test } from 'node:test';
import assert from 'node:assert';
import { normalizePhone, normalizeEmail } from './normalize';

test('normalizePhone keeps last 10 US digits', () => {
  assert.equal(normalizePhone('+1 (806) 781-8495'), '8067818495');
  assert.equal(normalizePhone('806-781-8495'), '8067818495');
  assert.equal(normalizePhone('18067818495'), '8067818495');
});

test('normalizePhone returns null for junk/empty', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('   '), null);
  assert.equal(normalizePhone('123'), null); // too short
});

test('normalizeEmail lowercases and trims, null when empty/invalid', () => {
  assert.equal(normalizeEmail('  Josh@Example.COM '), 'josh@example.com');
  assert.equal(normalizeEmail('notanemail'), null);
  assert.equal(normalizeEmail(''), null);
});
