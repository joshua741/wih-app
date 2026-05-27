import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { broadcast } from '../websocket/server';
import { initiateClickToCall } from './voice';
import { v4 as uuidv4 } from 'uuid';

export const apiRouter = Router();

// ─── CONTACTS ────────────────────────────────────────────────────────────────

// GET /api/contacts?pipeline=&stage_id=&search=&limit=&offset=
apiRouter.get('/contacts', async (req: Request, res: Response) => {
  const { pipeline, stage_id, search, limit = '50', offset = '0' } = req.query as Record<string, string>;

  let query = `
    SELECT c.*, ps.name as stage_name, ps.color as stage_color
    FROM contacts c
    LEFT JOIN pipeline_stages ps ON c.stage_id = ps.id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (pipeline) { params.push(pipeline); query += ` AND c.pipeline = $${params.length}`; }
  if (stage_id) { params.push(stage_id); query += ` AND c.stage_id = $${params.length}`; }
  if (search) {
    params.push(`%${search}%`);
    query += ` AND (c.name ILIKE $${params.length} OR c.phone ILIKE $${params.length} OR c.address ILIKE $${params.length})`;
  }

  query += ` ORDER BY c.updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(parseInt(limit, 10), parseInt(offset, 10));

  const result = await pool.query(query, params);
  res.json({ contacts: result.rows, count: result.rowCount });
});

// GET /api/contacts/:id
apiRouter.get('/contacts/:id', async (req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT c.*, ps.name as stage_name, ps.color as stage_color
     FROM contacts c
     LEFT JOIN pipeline_stages ps ON c.stage_id = ps.id
     WHERE c.id = $1`,
    [req.params.id]
  );
  if (!result.rows[0]) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(result.rows[0]);
});

// POST /api/contacts
apiRouter.post('/contacts', async (req: Request, res: Response) => {
  const { phone, name, email, address, city, state, zip, source, pipeline, stage_id, notes } = req.body;
  const result = await pool.query(
    `INSERT INTO contacts (id, phone, name, email, address, city, state, zip, source, pipeline, stage_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [uuidv4(), phone, name, email, address, city, state, zip, source, pipeline || 'seller_inbound', stage_id, notes]
  );
  broadcast('contact:created', result.rows[0]);
  res.status(201).json(result.rows[0]);
});

// PATCH /api/contacts/:id
apiRouter.patch('/contacts/:id', async (req: Request, res: Response) => {
  const allowed = ['name','email','address','city','state','zip','stage_id','pipeline','is_dnc','dnc_reason','human_takeover','takeover_by','ai_active','notes','metadata'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) { res.status(400).json({ error: 'No valid fields' }); return; }

  const sets = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  const vals = updates.map(([, v]) => v);

  const result = await pool.query(
    `UPDATE contacts SET ${sets} WHERE id = $1 RETURNING *`,
    [req.params.id, ...vals]
  );
  if (!result.rows[0]) { res.status(404).json({ error: 'Not found' }); return; }
  broadcast('contact:updated', result.rows[0]);
  res.json(result.rows[0]);
});

// DELETE /api/contacts/:id
apiRouter.delete('/contacts/:id', async (req: Request, res: Response) => {
  await pool.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
  broadcast('contact:deleted', { id: req.params.id });
  res.sendStatus(204);
});

// ─── MESSAGES ────────────────────────────────────────────────────────────────

// GET /api/contacts/:id/messages
apiRouter.get('/contacts/:id/messages', async (req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT m.* FROM messages m
     JOIN conversations cv ON m.conversation_id = cv.id
     WHERE cv.contact_id = $1
     ORDER BY m.created_at ASC`,
    [req.params.id]
  );
  res.json({ messages: result.rows });
});

// POST /api/contacts/:id/messages — manual human reply
apiRouter.post('/contacts/:id/messages', async (req: Request, res: Response) => {
  const { body, sender = 'human' } = req.body as { body: string; sender?: string };
  const contactId = req.params.id;

  const convResult = await pool.query<{ id: string; twilio_number: string }>(
    'SELECT id, twilio_number FROM conversations WHERE contact_id = $1',
    [contactId]
  );
  if (!convResult.rows[0]) { res.status(404).json({ error: 'No conversation' }); return; }
  const { id: conversationId, twilio_number: twilioNumber } = convResult.rows[0];

  const contactResult = await pool.query<{ phone: string }>(
    'SELECT phone FROM contacts WHERE id = $1',
    [contactId]
  );
  const toPhone = contactResult.rows[0]?.phone;
  if (!toPhone) { res.status(404).json({ error: 'Contact not found' }); return; }

  // Send via Twilio
  const twilio = await import('twilio');
  const client = twilio.default(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
  const msg = await client.messages.create({
    to: toPhone,
    from: twilioNumber,
    body,
    statusCallback: `${process.env.WEBHOOK_BASE_URL}/sms/status`,
  });

  const result = await pool.query(
    `INSERT INTO messages (id, conversation_id, contact_id, twilio_sid, direction, body, from_number, to_number, sender, status)
     VALUES ($1,$2,$3,$4,'outbound',$5,$6,$7,$8,'sent') RETURNING *`,
    [uuidv4(), conversationId, contactId, msg.sid, body, twilioNumber, toPhone, sender]
  );

  broadcast('sms:outbound', result.rows[0]);
  res.status(201).json(result.rows[0]);
});

// ─── DEALS ───────────────────────────────────────────────────────────────────

// GET /api/deals?stage_id=&assigned_to=
apiRouter.get('/deals', async (req: Request, res: Response) => {
  const { stage_id, assigned_to } = req.query as Record<string, string>;
  let query = `
    SELECT d.*, c.name, c.phone, c.address, ps.name as stage_name, ps.color as stage_color
    FROM deals d
    JOIN contacts c ON d.contact_id = c.id
    LEFT JOIN pipeline_stages ps ON d.stage_id = ps.id
    WHERE 1=1
  `;
  const params: unknown[] = [];
  if (stage_id) { params.push(stage_id); query += ` AND d.stage_id = $${params.length}`; }
  if (assigned_to) { params.push(assigned_to); query += ` AND d.assigned_to = $${params.length}`; }
  query += ' ORDER BY d.updated_at DESC';

  const result = await pool.query(query, params);
  res.json({ deals: result.rows });
});

// POST /api/deals
apiRouter.post('/deals', async (req: Request, res: Response) => {
  const { contact_id, stage_id, assigned_to, deal_type, property_address, asking_price, arv, repair_estimate, offer_price, motivation_score, notes } = req.body;
  const result = await pool.query(
    `INSERT INTO deals (id, contact_id, stage_id, assigned_to, deal_type, property_address, asking_price, arv, repair_estimate, offer_price, motivation_score, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [uuidv4(), contact_id, stage_id, assigned_to, deal_type, property_address, asking_price, arv, repair_estimate, offer_price, motivation_score, notes]
  );
  broadcast('deal:created', result.rows[0]);
  res.status(201).json(result.rows[0]);
});

// PATCH /api/deals/:id
apiRouter.patch('/deals/:id', async (req: Request, res: Response) => {
  const allowed = ['stage_id','assigned_to','deal_type','property_address','asking_price','arv','repair_estimate','offer_price','motivation_score','notes','metadata'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) { res.status(400).json({ error: 'No valid fields' }); return; }

  const sets = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  const result = await pool.query(
    `UPDATE deals SET ${sets} WHERE id = $1 RETURNING *`,
    [req.params.id, ...updates.map(([, v]) => v)]
  );
  if (!result.rows[0]) { res.status(404).json({ error: 'Not found' }); return; }
  broadcast('deal:updated', result.rows[0]);
  res.json(result.rows[0]);
});

// ─── PIPELINE ────────────────────────────────────────────────────────────────

// GET /api/pipeline/stages
apiRouter.get('/pipeline/stages', async (_req: Request, res: Response) => {
  const result = await pool.query('SELECT * FROM pipeline_stages ORDER BY pipeline, position');
  res.json({ stages: result.rows });
});

// PATCH /api/pipeline/move — move contact to a different stage
// Body: { contactId, stageId }
apiRouter.patch('/pipeline/move', async (req: Request, res: Response) => {
  const { contactId, stageId } = req.body as { contactId: string; stageId: string };
  const result = await pool.query(
    'UPDATE contacts SET stage_id = $1 WHERE id = $2 RETURNING *',
    [stageId, contactId]
  );
  if (!result.rows[0]) { res.status(404).json({ error: 'Not found' }); return; }
  broadcast('contact:stage_changed', { contactId, stageId });
  res.json(result.rows[0]);
});

// ─── STATS ───────────────────────────────────────────────────────────────────

// GET /api/stats
apiRouter.get('/stats', async (_req: Request, res: Response) => {
  const [counts, stageBreakdown, recentActivity] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE pipeline = 'agent_outreach')  AS agent_outreach_total,
        COUNT(*) FILTER (WHERE pipeline = 'seller_inbound')  AS seller_inbound_total,
        COUNT(*) FILTER (WHERE pipeline = 'active_deals')    AS active_deals_total,
        COUNT(*) FILTER (WHERE is_dnc = TRUE)                AS dnc_total,
        COUNT(*) FILTER (WHERE human_takeover = TRUE)        AS human_takeover_total,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24h') AS new_today
      FROM contacts
    `),
    pool.query(`
      SELECT ps.name, ps.color, ps.pipeline, COUNT(c.id) as contact_count
      FROM pipeline_stages ps
      LEFT JOIN contacts c ON c.stage_id = ps.id
      GROUP BY ps.id, ps.name, ps.color, ps.pipeline, ps.position
      ORDER BY ps.pipeline, ps.position
    `),
    pool.query(`
      SELECT m.body, m.direction, m.sender, m.created_at, c.name, c.phone
      FROM messages m
      JOIN contacts c ON m.contact_id = c.id
      ORDER BY m.created_at DESC
      LIMIT 20
    `),
  ]);

  res.json({
    counts: counts.rows[0],
    stageBreakdown: stageBreakdown.rows,
    recentActivity: recentActivity.rows,
  });
});

// ─── CLICK-TO-CALL ───────────────────────────────────────────────────────────

// POST /api/call/initiate
// Body: { contactPhone: string, agent: 'josh' | 'angel' }
apiRouter.post('/call/initiate', async (req: Request, res: Response) => {
  const { contactPhone, agent } = req.body as { contactPhone: string; agent: 'josh' | 'angel' };
  if (!contactPhone || !agent) { res.status(400).json({ error: 'contactPhone and agent required' }); return; }

  const callSid = await initiateClickToCall(contactPhone, agent);

  // Log
  const contactResult = await pool.query<{ id: string }>(
    'SELECT id FROM contacts WHERE phone = $1',
    [contactPhone]
  );
  if (contactResult.rows[0]) {
    await pool.query(
      `INSERT INTO call_logs (id, contact_id, direction, from_number, to_number, forwarded_to, status, initiated_by, twilio_call_sid)
       VALUES ($1,$2,'outbound',$3,$4,$5,'initiated','click_to_call',$6)`,
      [
        uuidv4(),
        contactResult.rows[0].id,
        agent === 'josh' ? process.env.JOSH_PHONE : process.env.ANGEL_PHONE,
        contactPhone,
        contactPhone,
        callSid,
      ]
    );
  }

  broadcast('call:initiated', { contactPhone, agent, callSid });
  res.json({ callSid });
});

// ─── DNC ─────────────────────────────────────────────────────────────────────

// POST /api/contacts/:id/dnc
apiRouter.post('/contacts/:id/dnc', async (req: Request, res: Response) => {
  const { reason } = req.body as { reason?: string };
  const result = await pool.query(
    `UPDATE contacts SET is_dnc = TRUE, dnc_reason = $1, ai_active = FALSE WHERE id = $2 RETURNING *`,
    [reason || 'Manual DNC', req.params.id]
  );
  if (!result.rows[0]) { res.status(404).json({ error: 'Not found' }); return; }
  broadcast('contact:dnc', { id: req.params.id });
  res.json(result.rows[0]);
});

// POST /api/contacts/:id/takeover — assign human takeover
apiRouter.post('/contacts/:id/takeover', async (req: Request, res: Response) => {
  const { agent } = req.body as { agent: 'josh' | 'angel' };
  const result = await pool.query(
    `UPDATE contacts SET human_takeover = TRUE, takeover_by = $1, ai_active = FALSE WHERE id = $2 RETURNING *`,
    [agent, req.params.id]
  );
  if (!result.rows[0]) { res.status(404).json({ error: 'Not found' }); return; }
  broadcast('contact:takeover', { id: req.params.id, agent });
  res.json(result.rows[0]);
});
