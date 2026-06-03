import { test } from 'node:test';
import assert from 'node:assert';
import { isOutreachEligible, buildOpenerInstruction } from './outreachRules';

test('isOutreachEligible: DNC is not eligible', () => {
  assert.deepEqual(isOutreachEligible({ isDnc: true, phone: '+18065551234', hasConversation: false }), { ok: false, reason: 'dnc' });
});

test('isOutreachEligible: missing phone is not eligible', () => {
  assert.equal(isOutreachEligible({ isDnc: false, phone: null, hasConversation: false }).reason, 'no_phone');
  assert.equal(isOutreachEligible({ isDnc: false, phone: '   ', hasConversation: false }).reason, 'no_phone');
});

test('isOutreachEligible: already in a conversation is not eligible', () => {
  assert.equal(isOutreachEligible({ isDnc: false, phone: '+18065551234', hasConversation: true }).reason, 'already_in_conversation');
});

test('isOutreachEligible: clean contact is eligible', () => {
  assert.deepEqual(isOutreachEligible({ isDnc: false, phone: '+18065551234', hasConversation: false }), { ok: true });
});

test('buildOpenerInstruction frames a first touch and requires opt-out', () => {
  const s = buildOpenerInstruction();
  assert.match(s, /FIRST/);
  assert.match(s, /STOP/);
});
