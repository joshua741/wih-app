import twilio from 'twilio';
import { pool } from '../db/pool';
import { broadcast } from '../websocket/server';

const JOSH_PHONE = process.env.JOSH_PHONE ?? '+18067818495';
const ANGEL_PHONE = process.env.ANGEL_PHONE ?? '+18063170334';

// MAO = (ARV × 0.70) - repairs - $10,000
export function calculateMAO(arv: number, repairs: number): number {
  return arv * 0.7 - repairs - 10_000;
}

export interface DealData {
  askingPrice?: number;
  arv?: number;
  repairEstimate?: number;
  mortgageBalance?: number;
  interestRate?: number;
  isListed?: boolean;
  wantsPassiveIncome?: boolean;
  equityPercent?: number;
}

export type DealClassification = 'cash' | 'creative_finance' | 'dead';

export interface RouteResult {
  assignedTo: 'josh' | 'angel';
  notifyPhone: string;
  notifyBoth?: boolean;
}

export function classifyDeal(dealData: DealData): DealClassification {
  const { askingPrice, arv, repairEstimate = 0, mortgageBalance, interestRate, wantsPassiveIncome, equityPercent } = dealData;

  // Can't classify without ARV
  if (!arv || arv <= 0) return 'dead';

  const mao = calculateMAO(arv, repairEstimate);

  // Cash deal: asking price is at or below MAO
  if (askingPrice !== undefined && askingPrice <= mao) return 'cash';

  // Creative finance signals
  const lowInterestRate = interestRate !== undefined && interestRate < 5;
  const freeAndClearWantsPassive = (!mortgageBalance || mortgageBalance === 0) && wantsPassiveIncome;
  const lowEquity = equityPercent !== undefined && equityPercent < 20;
  const nearRetail = askingPrice !== undefined && askingPrice > mao && askingPrice <= arv * 0.9;

  if (lowInterestRate || freeAndClearWantsPassive || lowEquity || nearRetail) {
    return 'creative_finance';
  }

  // Numbers don't work
  if (askingPrice !== undefined && askingPrice > arv * 0.9) return 'dead';

  return 'dead';
}

export function routeDeal(dealType: string, pipeline?: string): RouteResult {
  // Creative finance → Josh
  if (dealType === 'creative_finance') {
    return { assignedTo: 'josh', notifyPhone: JOSH_PHONE };
  }

  // Cash → Angel
  if (dealType === 'cash') {
    // Tier 1 (sub-70% Zestimate level) — notify both
    // We notify both for cash deals identified in outreach pipeline (higher confidence)
    if (pipeline === 'agent_outreach') {
      return { assignedTo: 'angel', notifyPhone: ANGEL_PHONE, notifyBoth: true };
    }
    return { assignedTo: 'angel', notifyPhone: ANGEL_PHONE };
  }

  // Default unknown → Angel
  return { assignedTo: 'angel', notifyPhone: ANGEL_PHONE };
}

// Listed property filter
// Returns true if AI should skip/not pursue this lead
export function shouldSkipListed(isListed: boolean, dealType: string, pipeline: string): boolean {
  // Cash pipeline: skip listed properties (off-market only)
  if (pipeline === 'seller_inbound' && dealType === 'cash' && isListed) return true;
  // Creative pipeline: pursue listed + sitting — never skip
  return false;
}

export async function sendNotification(
  to: 'angel' | 'josh' | 'both',
  message: string
): Promise<void> {
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID!,
    process.env.TWILIO_AUTH_TOKEN!
  );

  // Use the seller AI number as the from number for notifications
  const fromNumber =
    process.env.TWILIO_SELLER_NUMBER ??
    process.env.TWILIO_OUTREACH_NUMBER ??
    '';

  const recipients: string[] = [];
  if (to === 'angel' || to === 'both') recipients.push(ANGEL_PHONE);
  if (to === 'josh' || to === 'both') recipients.push(JOSH_PHONE);

  await Promise.all(
    recipients.map((phone) =>
      client.messages.create({
        to: phone,
        from: fromNumber,
        body: message,
      }).catch((err) => {
        console.error(`[DealRouting] Failed to notify ${phone}:`, err.message);
      })
    )
  );
}

// Full deal qualification + routing pipeline entry point
export async function processQualifiedDeal(params: {
  contactId: string;
  dealData: DealData;
  pipeline: string;
  propertyAddress?: string;
  notes?: string;
}): Promise<void> {
  const { contactId, dealData, pipeline, propertyAddress, notes } = params;
  const { v4: uuidv4 } = await import('uuid');

  const classification = classifyDeal(dealData);
  if (classification === 'dead') return;

  const routing = routeDeal(classification, pipeline);

  // Check listed filter
  if (dealData.isListed && shouldSkipListed(true, classification, pipeline)) {
    console.log(`[DealRouting] Skipping listed property for contact ${contactId} (cash pipeline)`);
    return;
  }

  // Get the first active_deals stage
  const stageResult = await pool.query<{ id: string }>(
    `SELECT id FROM pipeline_stages WHERE pipeline = 'active_deals' ORDER BY position LIMIT 1`
  );
  const stageId = stageResult.rows[0]?.id ?? null;

  // Create deal record
  const dealResult = await pool.query(
    `INSERT INTO deals
       (id, contact_id, stage_id, assigned_to, deal_type, property_address,
        asking_price, arv, repair_estimate, offer_price, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      uuidv4(),
      contactId,
      stageId,
      routing.assignedTo,
      classification,
      propertyAddress ?? null,
      dealData.askingPrice ?? null,
      dealData.arv ?? null,
      dealData.repairEstimate ?? null,
      dealData.arv ? calculateMAO(dealData.arv, dealData.repairEstimate ?? 0) : null,
      notes ?? null,
    ]
  );

  broadcast('deal:created', dealResult.rows[0]);

  // Notify assigned person(s)
  const contactResult = await pool.query<{ name: string | null; phone: string }>(
    `SELECT name, phone FROM contacts WHERE id = $1`,
    [contactId]
  );
  const contact = contactResult.rows[0];
  const contactLabel = contact?.name ?? contact?.phone ?? 'Unknown';

  const mao = dealData.arv ? calculateMAO(dealData.arv, dealData.repairEstimate ?? 0) : 0;
  const notifyMsg = `New ${classification.replace('_', ' ')} deal: ${contactLabel} (${contact?.phone}). ARV ~$${dealData.arv?.toLocaleString()}, MAO ~$${mao.toLocaleString()}. Check the pipeline.`;

  const notifyTarget = routing.notifyBoth ? 'both' : routing.assignedTo;
  await sendNotification(notifyTarget, notifyMsg);
}

// Export as namespace for ai.ts to import
export const dealRouting = {
  classifyDeal,
  routeDeal,
  sendNotification,
  processQualifiedDeal,
  calculateMAO,
  shouldSkipListed,
};
