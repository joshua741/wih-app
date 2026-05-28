import twilio from 'twilio';
import { pool } from '../db/pool';
import { broadcast } from '../websocket/server';

const JOSH_PHONE = process.env.JOSH_PHONE ?? '+18067818495';
const ANGEL_PHONE = process.env.ANGEL_PHONE ?? '+18063170334';

const OPT_OUT_PATTERNS = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bquit\b/i,
  /\bcancel\b/i,
  /\bend\b/i,
  /\bopt.?out\b/i,
  /\bremove me\b/i,
  /\bdo not (contact|text|call|message)\b/i,
  /\bno more (texts?|messages?|calls?)\b/i,
  /\btake me off\b/i,
  /\bleave me alone\b/i,
];

const HUMAN_NEEDED_PATTERNS = [
  /\breal person\b/i,
  /\bactual person\b/i,
  /\btalk to (someone|a person|a human)\b/i,
  /\bspeak (with|to) (someone|a person|a human)\b/i,
  /\bare you (a bot|an ai|a robot|automated)\b/i,
  /\bfraud\b/i,
  /\blawsuit\b/i,
  /\blegal action\b/i,
  /\bsue\b/i,
  /\battorney\b/i,
  /\blawyer\b/i,
  /\bfury\b/i,
  /\bfurious\b/i,
  /\bscam\b/i,
  /\breport (you|this)\b/i,
];

export function detectOptOut(body: string): boolean {
  const normalized = body.trim();
  return OPT_OUT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function detectHumanNeeded(body: string): boolean {
  return HUMAN_NEEDED_PATTERNS.some((pattern) => pattern.test(body));
}

export async function checkDNC(contactId: string): Promise<boolean> {
  const result = await pool.query<{ is_dnc: boolean }>(
    `SELECT is_dnc FROM contacts WHERE id = $1`,
    [contactId]
  );
  return result.rows[0]?.is_dnc ?? false;
}

export async function handleOptOut(contactId: string): Promise<void> {
  // Load contact for phone + conversation
  const contactResult = await pool.query<{ phone: string; name: string | null }>(
    `SELECT phone, name FROM contacts WHERE id = $1`,
    [contactId]
  );
  const contact = contactResult.rows[0];
  if (!contact) return;

  const convResult = await pool.query<{ id: string; twilio_number: string }>(
    `SELECT id, twilio_number FROM conversations WHERE contact_id = $1`,
    [contactId]
  );
  const conv = convResult.rows[0];

  // Send the ONE required final opt-out confirmation
  if (conv) {
    const client = twilio(
      process.env.TWILIO_API_KEY!,
      process.env.TWILIO_API_SECRET!,
      { accountSid: process.env.TWILIO_ACCOUNT_SID! }
    );
    try {
      const sent = await client.messages.create({
        to: contact.phone,
        from: conv.twilio_number,
        body: "Got it — you've been removed. Have a good one.",
      });

      const { v4: uuidv4 } = await import('uuid');
      await pool.query(
        `INSERT INTO messages
           (id, conversation_id, contact_id, twilio_sid, direction, body, from_number, to_number, sender, status)
         VALUES ($1,$2,$3,$4,'outbound',$5,$6,$7,'ai','sent')`,
        [
          uuidv4(),
          conv.id,
          contactId,
          sent.sid,
          "Got it — you've been removed. Have a good one.",
          conv.twilio_number,
          contact.phone,
        ]
      );
    } catch (err) {
      console.error('[Compliance] Failed to send opt-out confirmation:', err);
    }
  }

  // Tag DNC, disable AI, close conversation
  await pool.query(
    `UPDATE contacts
     SET is_dnc = TRUE, dnc_reason = 'Opt-out via SMS', ai_active = FALSE
     WHERE id = $1`,
    [contactId]
  );

  if (conv) {
    await pool.query(
      `UPDATE conversations SET status = 'closed' WHERE id = $1`,
      [conv.id]
    );
  }

  broadcast('contact:dnc', { id: contactId, reason: 'Opt-out via SMS' });
  console.log(`[Compliance] DNC set for contact ${contactId}`);
}

export async function handleHumanTakeover(contactId: string, reason: string): Promise<void> {
  // Load contact details
  const contactResult = await pool.query<{
    name: string | null;
    phone: string;
    metadata: Record<string, unknown>;
    pipeline: string;
  }>(
    `SELECT name, phone, metadata, pipeline FROM contacts WHERE id = $1`,
    [contactId]
  );
  const contact = contactResult.rows[0];
  if (!contact) return;

  // Get last inbound message for context
  const lastMsgResult = await pool.query<{ body: string }>(
    `SELECT body FROM messages
     WHERE contact_id = $1 AND direction = 'inbound'
     ORDER BY created_at DESC LIMIT 1`,
    [contactId]
  );
  const lastMsg = lastMsgResult.rows[0]?.body ?? '(no message)';

  // Determine who to notify based on deal type
  const dealType = (contact.metadata?.deal_type as string) ?? null;
  let notifyTo: 'josh' | 'angel' = 'angel'; // default Angel
  if (dealType === 'creative_finance') notifyTo = 'josh';

  // Flag contact: needs human, disable AI
  await pool.query(
    `UPDATE contacts
     SET human_takeover = TRUE, takeover_by = $1, ai_active = FALSE
     WHERE id = $2`,
    [notifyTo, contactId]
  );

  // Update conversation status
  await pool.query(
    `UPDATE conversations SET status = 'human_takeover'
     WHERE contact_id = $1`,
    [contactId]
  );

  broadcast('contact:takeover', { id: contactId, agent: notifyTo, reason });

  // Notify the right person via SMS
  const client = twilio(
    process.env.TWILIO_API_KEY!,
    process.env.TWILIO_API_SECRET!,
    { accountSid: process.env.TWILIO_ACCOUNT_SID! }
  );
  const fromNumber =
    process.env.TWILIO_SELLER_NUMBER ??
    process.env.TWILIO_OUTREACH_NUMBER ??
    '';

  const contactLabel = contact.name ?? contact.phone;
  const notifBody =
    `Lead needs human: ${contactLabel} ${contact.phone} — Reason: ${reason}. Last msg: "${lastMsg.substring(0, 80)}"`;

  const toPhone = notifyTo === 'josh' ? JOSH_PHONE : ANGEL_PHONE;

  try {
    await client.messages.create({
      to: toPhone,
      from: fromNumber,
      body: notifBody,
    });
  } catch (err) {
    console.error('[Compliance] Failed to send human takeover notification:', err);
  }

  console.log(`[Compliance] Human takeover for ${contactId} → ${notifyTo}. Reason: ${reason}`);
}

// Count messages without a stage change (stale progress check)
async function countMessagesWithoutProgress(contactId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM messages
     WHERE contact_id = $1
     AND created_at > (
       SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz)
       FROM contacts WHERE id = $1
     )`,
    [contactId]
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

// Main compliance entry point — call this before processing any inbound message
export async function checkCompliance(
  contactId: string,
  messageBody: string
): Promise<{ blocked: boolean; reason?: string }> {
  // 1. DNC check
  const isDNC = await checkDNC(contactId);
  if (isDNC) return { blocked: true, reason: 'dnc' };

  // 2. Opt-out detection
  if (detectOptOut(messageBody)) {
    await handleOptOut(contactId);
    return { blocked: true, reason: 'opt_out' };
  }

  // 3. Human needed language check
  if (detectHumanNeeded(messageBody)) {
    await handleHumanTakeover(contactId, 'Requested a real person or expressed frustration');
    return { blocked: true, reason: 'human_takeover' };
  }

  // 4. Stale conversation check (10+ messages, no stage progress)
  const staleCount = await countMessagesWithoutProgress(contactId);
  if (staleCount >= 10) {
    await handleHumanTakeover(contactId, `${staleCount} messages with no deal progress`);
    return { blocked: true, reason: 'human_takeover' };
  }

  // 5. Human takeover already flagged (DB state check)
  const contactResult = await pool.query<{ human_takeover: boolean; ai_active: boolean }>(
    `SELECT human_takeover, ai_active FROM contacts WHERE id = $1`,
    [contactId]
  );
  const c = contactResult.rows[0];
  if (c?.human_takeover || !c?.ai_active) {
    return { blocked: true, reason: 'human_takeover_active' };
  }

  return { blocked: false };
}
