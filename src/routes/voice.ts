import { Router, Request, Response } from 'express';
import twilio from 'twilio';
import { pool } from '../db/pool';
import { broadcast } from '../websocket/server';
import { v4 as uuidv4 } from 'uuid';

export const voiceRouter = Router();

const JOSH_PHONE = process.env.JOSH_PHONE || '+18067818495';
const ANGEL_PHONE = process.env.ANGEL_PHONE || '+18063170334';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID!;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN!;

// POST /webhooks/voice/inbound — inbound call to an AI number
// Routes to Angel by default; routes to Josh if contact is flagged as creative finance
voiceRouter.post('/inbound', async (req: Request, res: Response) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const { From, To, CallSid } = req.body as { From: string; To: string; CallSid: string };

  try {
    // Upsert contact
    await pool.query(
      `INSERT INTO contacts (id, phone, source, pipeline)
       VALUES ($1, $2, 'seller_inbound', 'seller_inbound')
       ON CONFLICT (phone) DO NOTHING`,
      [uuidv4(), From]
    );

    const contactResult = await pool.query<{ id: string; metadata: Record<string, unknown> }>(
      `SELECT id, metadata FROM contacts WHERE phone = $1`,
      [From]
    );
    const contact = contactResult.rows[0];

    // Log the call
    const callLogId = uuidv4();
    const dealType = (contact?.metadata?.deal_type as string) || 'unknown';
    const forwardTo = dealType === 'creative_finance' ? JOSH_PHONE : ANGEL_PHONE;

    await pool.query(
      `INSERT INTO call_logs (id, contact_id, twilio_call_sid, direction, from_number, to_number, forwarded_to, status, initiated_by)
       VALUES ($1, $2, $3, 'inbound', $4, $5, $6, 'initiated', 'inbound')`,
      [callLogId, contact?.id || null, CallSid, From, To, forwardTo]
    );

    broadcast('call:inbound', {
      contactId: contact?.id,
      from: From,
      to: To,
      forwardTo,
      callSid: CallSid,
      ts: new Date().toISOString(),
    });

    // Forward to appropriate team member
    const dial = twiml.dial({ callerId: To, timeout: 30 });
    dial.number(forwardTo);
  } catch (err) {
    console.error('[VOICE] Inbound error:', err);
    twiml.say('We are currently unavailable. Please try again later.');
  }

  res.type('text/xml').send(twiml.toString());
});

// POST /webhooks/voice/status — call status callbacks
voiceRouter.post('/status', async (req: Request, res: Response) => {
  const { CallSid, CallStatus, CallDuration } = req.body as {
    CallSid: string;
    CallStatus: string;
    CallDuration?: string;
  };

  try {
    await pool.query(
      `UPDATE call_logs
       SET status = $1, duration_seconds = $2
       WHERE twilio_call_sid = $3`,
      [CallStatus, CallDuration ? parseInt(CallDuration, 10) : null, CallSid]
    );

    broadcast('call:status', { callSid: CallSid, status: CallStatus, duration: CallDuration });
  } catch (err) {
    console.error('[VOICE] Status callback error:', err);
  }

  res.sendStatus(204);
});

// POST /api/call/initiate — click-to-call: bridge browser user to a contact
// Body: { contactPhone: string, agentPhone: 'josh' | 'angel' }
voiceRouter.post('/../../api/call/initiate', async (req: Request, res: Response) => {
  // Handled in api.ts — kept here for reference only
  res.status(404).json({ error: 'Use POST /api/call/initiate' });
});

// Click-to-call handler (called directly from api.ts)
export async function initiateClickToCall(contactPhone: string, agent: 'josh' | 'angel') {
  const client = twilio(
    process.env.TWILIO_API_KEY!,
    process.env.TWILIO_API_SECRET!,
    { accountSid: TWILIO_ACCOUNT_SID }
  );
  const agentPhone = agent === 'josh' ? JOSH_PHONE : ANGEL_PHONE;
  const outboundNumber = process.env.TWILIO_SELLER_NUMBER!;
  const BASE_URL = process.env.BASE_URL || process.env.WEBHOOK_BASE_URL?.replace('/webhooks', '') || '';

  // Twilio calls agent first, then bridges to contact
  const call = await client.calls.create({
    to: agentPhone,
    from: outboundNumber,
    url: `${BASE_URL}/webhooks/voice/bridge?contactPhone=${encodeURIComponent(contactPhone)}`,
    statusCallback: `${BASE_URL}/webhooks/voice/status`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
  });

  return call.sid;
}

// POST /webhooks/voice/bridge — TwiML to connect agent to contact once agent picks up
voiceRouter.post('/bridge', (req: Request, res: Response) => {
  const { contactPhone } = req.query as { contactPhone: string };
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Connecting you now.');
  const dial = twiml.dial({ callerId: process.env.TWILIO_SELLER_NUMBER! });
  dial.number(contactPhone);
  res.type('text/xml').send(twiml.toString());
});
