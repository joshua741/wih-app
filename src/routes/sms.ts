import { Router, Request, Response } from 'express';
import twilio from 'twilio';
import { pool } from '../db/pool';
import { broadcast } from '../websocket/server';
import { v4 as uuidv4 } from 'uuid';

export const smsRouter = Router();

// POST /webhooks/sms — inbound SMS from Twilio
smsRouter.post('/', async (req: Request, res: Response) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const {
      MessageSid,
      From,
      To,
      Body,
    } = req.body as { MessageSid: string; From: string; To: string; Body: string };

    // 1. Upsert contact
    const contactResult = await pool.query<{ id: string; is_dnc: boolean; human_takeover: boolean; ai_active: boolean }>(
      `INSERT INTO contacts (id, phone, source, pipeline)
       VALUES ($1, $2, 'seller_inbound', 'seller_inbound')
       ON CONFLICT (phone) DO UPDATE SET updated_at = NOW()
       RETURNING id, is_dnc, human_takeover, ai_active`,
      [uuidv4(), From]
    );
    const contact = contactResult.rows[0];

    // 2. DNC check — silently drop
    if (contact.is_dnc) {
      res.type('text/xml').send(twiml.toString());
      return;
    }

    // 3. Upsert conversation
    const convResult = await pool.query<{ id: string }>(
      `INSERT INTO conversations (id, contact_id, twilio_number, last_message_at, status)
       VALUES ($1, $2, $3, NOW(), 'active')
       ON CONFLICT (contact_id) DO UPDATE
         SET last_message_at = NOW(),
             twilio_number = EXCLUDED.twilio_number
       RETURNING id`,
      [uuidv4(), contact.id, To]
    );
    const conversationId = convResult.rows[0].id;

    // 4. Store inbound message
    const msgResult = await pool.query<{ id: string }>(
      `INSERT INTO messages (id, conversation_id, contact_id, twilio_sid, direction, body, from_number, to_number, sender, status)
       VALUES ($1, $2, $3, $4, 'inbound', $5, $6, $7, 'contact', 'received')
       ON CONFLICT (twilio_sid) DO NOTHING
       RETURNING id`,
      [uuidv4(), conversationId, contact.id, MessageSid, Body, From, To]
    );

    const messageId = msgResult.rows[0]?.id;

    // 5. Broadcast to WebSocket clients
    broadcast('sms:inbound', {
      contactId: contact.id,
      conversationId,
      messageId,
      from: From,
      to: To,
      body: Body,
      ts: new Date().toISOString(),
    });

    // 6. Compliance check + AI response
    if (!contact.human_takeover && contact.ai_active) {
      setImmediate(async () => {
        try {
          const { checkCompliance } = await import('../services/compliance');
          const compliance = await checkCompliance(contact.id, Body);
          if (compliance.blocked) return;

          const { handleInboundSMS } = await import('../services/ai');
          await handleInboundSMS({ contactId: contact.id, conversationId, from: From, to: To, body: Body });
        } catch (err) {
          console.error('[SMS] AI handler error:', err);
        }
      });
    }
  } catch (err) {
    console.error('[SMS] Inbound error:', err);
  }

  // Always respond with empty TwiML (AI sends reply separately via REST)
  res.type('text/xml').send(twiml.toString());
});

// POST /webhooks/sms/status — delivery status callbacks
smsRouter.post('/status', async (req: Request, res: Response) => {
  const { MessageSid, MessageStatus, ErrorCode } = req.body as {
    MessageSid: string;
    MessageStatus: string;
    ErrorCode?: string;
  };

  try {
    await pool.query(
      `UPDATE messages SET status = $1, error_code = $2 WHERE twilio_sid = $3`,
      [MessageStatus, ErrorCode || null, MessageSid]
    );

    broadcast('sms:status', { sid: MessageSid, status: MessageStatus, errorCode: ErrorCode });
  } catch (err) {
    console.error('[SMS] Status callback error:', err);
  }

  res.sendStatus(204);
});
