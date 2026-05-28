import Anthropic from '@anthropic-ai/sdk';
import twilio from 'twilio';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { broadcast } from '../websocket/server';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const AGENT_SYSTEM_PROMPT = `You are Vince, a real estate professional who works with Josh's team — a local investment group that buys properties in any condition.

You are texting with real estate agents to build relationships and get off-market property submissions.

PERSONALITY: Casual-professional. Like a colleague texting, not a salesperson. Brief messages, natural language. Never pushy.

GOALS:
1. Build rapport with the agent
2. Understand what types of deals they work (listings, probate, distressed, etc.)
3. Get them to submit an off-market or pre-foreclosure deal to you

IDENTITY RULES:
- Your name is Vince
- Never mention the company name
- Say "Josh's team" or "our team" or "a local investment group"
- Never reveal you are AI if asked — deflect casually ("haha just a regular person, why?")

DEAL INTELLIGENCE: You can identify deal signals. When you learn enough to classify:
- If agent mentions a listed property sitting with price drops → tag [DEAL_TYPE:creative]
- If agent mentions off-market motivated seller → tag [DEAL_TYPE:cash]
- If agent is unresponsive, hostile, or clearly not interested → tag [DEAD]

STAGE PROGRESSION (use [TIER:N] when stage should advance):
- [TIER:1] — Initial contact made, replied
- [TIER:2] — Relationship building, discussed deals
- [TIER:3] — Ready to submit a deal or appointment set

HUMAN TAKEOVER — include [HUMAN_TAKEOVER] in your response when:
- Agent mentions legal issues, lawsuits, commissions disputes
- Agent is clearly frustrated or hostile and needs a real human
- Deal value appears to be over $500,000
- You are genuinely uncertain how to handle the conversation
- Agent explicitly asks to speak with someone

FORMAT: Only output the SMS text to send, plus any [TAG] instructions on a new line at the end. Tags are instructions only — never shown to the contact. Keep messages under 160 characters when possible.`;

const SELLER_SYSTEM_PROMPT = `You are Vince, who works with Josh's team — a local group that buys houses directly from homeowners in any condition, for cash or through creative terms.

You are texting with a motivated seller (homeowner) who may need to sell.

PERSONALITY: Warm, empathetic, helpful. Like a knowledgeable friend who can solve their problem. Not salesy. Never pressure them.

GOALS:
1. Understand their situation (why they need to sell, timeline, condition of property)
2. Qualify the deal (get address, asking price, mortgage balance, condition)
3. Book an appointment for Josh or Angel to see the property

IDENTITY RULES:
- Your name is Vince
- Never mention the company name — say "Josh's team" or "our team"
- Never reveal you are AI if asked — deflect warmly ("I'm just the guy who reaches out first — real person I promise!")

QUALIFYING QUESTIONS (work through these naturally, not all at once):
1. What's the address of the property?
2. What condition is it in?
3. What's a ballpark on what you'd need to get out of it?
4. Is there a mortgage on it? Roughly how much is owed?
5. What's your timeline — how soon do you need to move?

DEAL CLASSIFICATION (include tag when confident):
- [DEAL_TYPE:cash] — asking price is likely at or below 70% ARV minus repairs
- [DEAL_TYPE:creative] — has mortgage, near retail, or wants passive income / payments over time
- [DEAD] — clearly not motivated, numbers way off, or property not sellable

STAGE PROGRESSION:
- [TIER:1] — Responded, engaged
- [TIER:2] — Qualifying in progress (getting property details)
- [TIER:3] — Qualified, ready for appointment or offer

HUMAN TAKEOVER — include [HUMAN_TAKEOVER] in response when:
- Seller mentions foreclosure auction date within 2 weeks
- Seller is in extreme distress (health crisis, death, divorce)
- Deal appears to be over $500,000 ARV
- Legal issues mentioned (title problems, probate court, liens)
- Seller asks to speak with someone or is clearly frustrated
- You are genuinely unsure how to handle the situation
- 10+ messages with no deal progress

FORMAT: Only output the SMS text to send, plus any [TAG] instructions on a new line at the end. Tags are instructions only — never shown to the contact. Keep messages under 160 characters when possible.`;

interface Contact {
  id: string;
  phone: string;
  name: string | null;
  pipeline: string;
  stage_id: string | null;
  human_takeover: boolean;
  ai_active: boolean;
  is_dnc: boolean;
  metadata: Record<string, unknown>;
}

interface Message {
  direction: 'inbound' | 'outbound';
  body: string;
  sender: string;
  created_at: string;
}

interface ParsedResponse {
  text: string;
  actions: {
    humanTakeover: boolean;
    dealType: 'cash' | 'creative_finance' | null;
    dead: boolean;
    tier: 1 | 2 | 3 | null;
  };
}

function parseAIResponse(raw: string): ParsedResponse {
  const actions: ParsedResponse['actions'] = {
    humanTakeover: false,
    dealType: null,
    dead: false,
    tier: null,
  };

  // Extract tags from the response
  const humanTakeoverMatch = /\[HUMAN_TAKEOVER\]/i.test(raw);
  const dealTypeCashMatch = /\[DEAL_TYPE:cash\]/i.test(raw);
  const dealTypeCreativeMatch = /\[DEAL_TYPE:creative\]/i.test(raw);
  const deadMatch = /\[DEAD\]/i.test(raw);
  const tierMatch = raw.match(/\[TIER:([123])\]/i);

  actions.humanTakeover = humanTakeoverMatch;
  actions.dead = deadMatch;
  if (dealTypeCashMatch) actions.dealType = 'cash';
  if (dealTypeCreativeMatch) actions.dealType = 'creative_finance';
  if (tierMatch) actions.tier = parseInt(tierMatch[1], 10) as 1 | 2 | 3;

  // Strip all tags from the message text sent to the contact
  const text = raw
    .replace(/\[HUMAN_TAKEOVER\]/gi, '')
    .replace(/\[DEAL_TYPE:[^\]]+\]/gi, '')
    .replace(/\[DEAD\]/gi, '')
    .replace(/\[TIER:[^\]]+\]/gi, '')
    .trim();

  return { text, actions };
}

function buildSystemPrompt(pipeline: string): string {
  return pipeline === 'agent_outreach' ? AGENT_SYSTEM_PROMPT : SELLER_SYSTEM_PROMPT;
}

async function loadHistory(conversationId: string): Promise<Message[]> {
  const result = await pool.query<Message>(
    `SELECT direction, body, sender, created_at
     FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [conversationId]
  );
  return result.rows.reverse();
}

async function getStageId(stageName: string, pipeline: string): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM pipeline_stages WHERE name = $1 AND pipeline = $2`,
    [stageName, pipeline]
  );
  return result.rows[0]?.id ?? null;
}

async function applyActions(
  contact: Contact,
  conversationId: string,
  actions: ParsedResponse['actions'],
  inboundBody: string
): Promise<void> {
  const { dealRouting } = await import('./dealRouting');
  const { handleHumanTakeover } = await import('./compliance');

  // Advance stage based on TIER tag
  if (actions.tier !== null) {
    const tierStageMap: Record<string, Record<number, string>> = {
      agent_outreach: {
        1: 'Contacted',
        2: 'Contacted',
        3: 'Appointment Set',
      },
      seller_inbound: {
        1: 'Engaged',
        2: 'Qualified',
        3: 'Qualified',
      },
    };
    const stageName = tierStageMap[contact.pipeline]?.[actions.tier];
    if (stageName) {
      const stageId = await getStageId(stageName, contact.pipeline);
      if (stageId && stageId !== contact.stage_id) {
        await pool.query(
          `UPDATE contacts SET stage_id = $1 WHERE id = $2`,
          [stageId, contact.id]
        );
        broadcast('contact:stage_changed', { contactId: contact.id, stageId });
      }
    }
  }

  // Update deal type in metadata
  if (actions.dealType) {
    const updatedMeta = { ...contact.metadata, deal_type: actions.dealType };
    await pool.query(
      `UPDATE contacts SET metadata = $1 WHERE id = $2`,
      [JSON.stringify(updatedMeta), contact.id]
    );
    broadcast('contact:updated', { id: contact.id, metadata: updatedMeta });

    // Route the deal and notify Angel/Josh
    const routing = dealRouting.routeDeal(actions.dealType, contact.pipeline);
    const contactName = contact.name ?? contact.phone;
    await dealRouting.sendNotification(
      routing.assignedTo as 'angel' | 'josh',
      `New ${actions.dealType.replace('_', ' ')} deal identified: ${contactName} (${contact.phone}). Check the pipeline.`
    );
  }

  // Mark contact dead
  if (actions.dead) {
    const deadStageId = await getStageId('Dead', contact.pipeline);
    await pool.query(
      `UPDATE contacts SET ai_active = FALSE, stage_id = COALESCE($1, stage_id) WHERE id = $2`,
      [deadStageId, contact.id]
    );
    broadcast('contact:updated', { id: contact.id, ai_active: false });
  }

  // Human takeover
  if (actions.humanTakeover) {
    await handleHumanTakeover(contact.id, inboundBody);
  }
}

export async function handleInboundSMS(params: {
  contactId: string;
  conversationId: string;
  from: string;
  to: string;
  body: string;
}): Promise<void> {
  const { contactId, conversationId, from, to, body } = params;

  // Load contact record
  const contactResult = await pool.query<Contact>(
    `SELECT id, phone, name, pipeline, stage_id, human_takeover, ai_active, is_dnc, metadata
     FROM contacts WHERE id = $1`,
    [contactId]
  );
  const contact = contactResult.rows[0];
  if (!contact || !contact.ai_active || contact.human_takeover || contact.is_dnc) return;

  // Load conversation history
  const history = await loadHistory(conversationId);

  // Build Anthropic messages array from history
  const messages: Anthropic.Messages.MessageParam[] = history.map((msg) => ({
    role: msg.direction === 'inbound' ? 'user' : 'assistant',
    content: msg.body,
  }));

  // Append current inbound message if not already in history
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== body) {
    messages.push({ role: 'user', content: body });
  }

  // Call Claude
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: buildSystemPrompt(contact.pipeline),
    messages,
  });

  const rawReply = response.content[0].type === 'text' ? response.content[0].text : '';
  if (!rawReply) return;

  const { text: replyText, actions } = parseAIResponse(rawReply);

  // Send SMS via Twilio
  const twilioClient = twilio(
    process.env.TWILIO_API_KEY!,
    process.env.TWILIO_API_SECRET!,
    { accountSid: process.env.TWILIO_ACCOUNT_SID! }
  );
  const sentMsg = await twilioClient.messages.create({
    to: from,
    from: to,
    body: replyText,
    statusCallback: `${process.env.WEBHOOK_BASE_URL}/webhooks/sms/status`,
  });

  // Store outbound message in DB
  const msgId = uuidv4();
  await pool.query(
    `INSERT INTO messages
       (id, conversation_id, contact_id, twilio_sid, direction, body, from_number, to_number, sender, status, ai_model, prompt_tokens, completion_tokens)
     VALUES ($1,$2,$3,$4,'outbound',$5,$6,$7,'ai','sent',$8,$9,$10)`,
    [
      msgId,
      conversationId,
      contactId,
      sentMsg.sid,
      replyText,
      to,
      from,
      'claude-sonnet-4-6',
      response.usage.input_tokens,
      response.usage.output_tokens,
    ]
  );

  // Broadcast new outbound message
  broadcast('sms:outbound', {
    id: msgId,
    contactId,
    conversationId,
    body: replyText,
    from: to,
    to: from,
    sender: 'ai',
    ts: new Date().toISOString(),
  });

  // Apply any action tags from AI response
  await applyActions(contact, conversationId, actions, body);
}

// Export a namespace for dealRouting to call back into (used by compliance.ts)
export const aiService = { handleInboundSMS };
