import twilio from 'twilio';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { broadcast } from '../websocket/server';
import { goalsForPipeline } from '../lib/goals';
import { contactTypeForPipeline, firstStageName } from '../lib/pipelineRouting';
import { isOutreachEligible } from '../lib/outreachRules';
import { generateOpener, Contact } from './ai';

const CAP = 25;
const DELAY_MS = 1500;
const VALID = new Set(['agent_outreach', 'seller_inbound']);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DirRow {
  id: string;
  phone: string | null;
  full_name: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
}

function pipelineNumber(pipeline: string): string | undefined {
  return pipeline === 'agent_outreach'
    ? process.env.TWILIO_OUTREACH_NUMBER
    : process.env.TWILIO_SELLER_NUMBER;
}

// Send the first outreach text to one directory contact.
async function sendOne(d: DirRow, pipeline: string): Promise<void> {
  if (!d.phone) return;
  const goals = goalsForPipeline(pipeline);
  const contactType = contactTypeForPipeline(pipeline);
  const stageName = firstStageName(pipeline);

  // Upsert the pipeline contact (with goals + first stage), keyed by phone.
  await pool.query(
    `INSERT INTO contacts (id, phone, name, email, address, city, state, contact_type, source, pipeline, stage_id, immediate_goal, long_term_goal, goal_owner)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'outreach',$9,(SELECT id FROM pipeline_stages WHERE name=$10),$11,$12,$13)
     ON CONFLICT (phone) DO NOTHING`,
    [uuidv4(), d.phone, d.full_name, d.email, d.address, d.city, d.state, contactType, pipeline, stageName, goals.immediateGoal, goals.longTermGoal, goals.owner]
  );

  const c = (await pool.query<Contact>(
    `SELECT id, phone, name, pipeline, stage_id, human_takeover, ai_active, is_dnc, metadata,
            immediate_goal, long_term_goal, goal_owner, goal_status
     FROM contacts WHERE phone = $1`,
    [d.phone]
  )).rows[0];
  if (!c) return;

  const convCount = await pool.query(`SELECT 1 FROM conversations WHERE contact_id = $1`, [c.id]);
  const elig = isOutreachEligible({ isDnc: c.is_dnc, phone: c.phone, hasConversation: (convCount.rowCount ?? 0) > 0 });
  if (!elig.ok) { console.log(`[OUTREACH] skip ${c.phone}: ${elig.reason}`); return; }

  const opener = await generateOpener(c);
  if (!opener) { console.log(`[OUTREACH] empty opener for ${c.phone}`); return; }

  const from = pipelineNumber(pipeline);
  if (!from) throw new Error('no from number for pipeline');
  const client = twilio(
    process.env.TWILIO_API_KEY!,
    process.env.TWILIO_API_SECRET!,
    { accountSid: process.env.TWILIO_ACCOUNT_SID! }
  );
  const sent = await client.messages.create({
    to: c.phone,
    from,
    body: opener,
    statusCallback: `${process.env.WEBHOOK_BASE_URL}/webhooks/sms/status`,
  });

  const conv = (await pool.query<{ id: string }>(
    `INSERT INTO conversations (id, contact_id, twilio_number, last_message_at, status)
     VALUES ($1,$2,$3,NOW(),'active')
     ON CONFLICT (contact_id) DO UPDATE SET last_message_at = NOW(), twilio_number = EXCLUDED.twilio_number
     RETURNING id`,
    [uuidv4(), c.id, from]
  )).rows[0];

  await pool.query(
    `INSERT INTO messages (id, conversation_id, contact_id, twilio_sid, direction, body, from_number, to_number, sender, status)
     VALUES ($1,$2,$3,$4,'outbound',$5,$6,$7,'ai','sent')`,
    [uuidv4(), conv.id, c.id, sent.sid, opener, from, c.phone]
  );
  await pool.query(`UPDATE directory_contacts SET promoted_to_pipeline = TRUE WHERE id = $1`, [d.id]);

  broadcast('sms:outbound', {
    contactId: c.id, conversationId: conv.id, body: opener,
    from, to: c.phone, sender: 'ai', ts: new Date().toISOString(),
  });
}

// Manual first-touch to a set of directory contacts. Returns the count that will be attempted;
// processes sends in the background, throttled, capped per run.
export async function startOutreach(params: { ids: string[]; pipeline: string }): Promise<{ queued: number }> {
  const { ids, pipeline } = params;
  if (!VALID.has(pipeline)) throw new Error('invalid pipeline');

  const dir = (await pool.query<DirRow>(
    `SELECT id, phone, full_name, email, address, city, state FROM directory_contacts WHERE id = ANY($1)`,
    [ids]
  )).rows;

  const batch = dir.slice(0, CAP);
  if (dir.length > batch.length) {
    console.log(`[OUTREACH] capping at ${CAP}/run; ${dir.length - batch.length} not attempted this run`);
  }

  setImmediate(async () => {
    for (const d of batch) {
      try {
        await sendOne(d, pipeline);
      } catch (e) {
        console.error('[OUTREACH] failed for', d.phone, (e as Error).message);
      }
      await wait(DELAY_MS);
    }
    console.log('[OUTREACH] run complete');
  });

  return { queued: batch.length };
}
