// Pure rules for outbound first-touch. No IO — unit-testable.
export interface OutreachEligibility {
  ok: boolean;
  reason?: 'dnc' | 'no_phone' | 'already_in_conversation';
}

export function isOutreachEligible(input: {
  isDnc: boolean;
  phone: string | null | undefined;
  hasConversation: boolean;
}): OutreachEligibility {
  if (input.isDnc) return { ok: false, reason: 'dnc' };
  if (!input.phone || !input.phone.trim()) return { ok: false, reason: 'no_phone' };
  if (input.hasConversation) return { ok: false, reason: 'already_in_conversation' };
  return { ok: true };
}

export function buildOpenerInstruction(): string {
  return [
    'Write the FIRST outreach text message to this person — you are reaching out to them; they have not messaged you.',
    'Keep it short (1-2 sentences), natural and human, and open toward your goal without being salesy or pushy.',
    'End with a brief, casual opt-out (e.g. "reply STOP to opt out").',
    'Output ONLY the SMS text — no tags, no preamble, no quotes.',
  ].join(' ');
}
