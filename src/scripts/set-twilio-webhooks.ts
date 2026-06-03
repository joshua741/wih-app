import 'dotenv/config';
import twilio from 'twilio';

// One-shot: point both WIH numbers' inbound SMS webhook at the deployed app.
// SMS delivery-status callbacks are set per-message in the app, so we only set smsUrl here.
async function main() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const key = process.env.TWILIO_API_KEY;
  const secret = process.env.TWILIO_API_SECRET;
  const base = (process.env.WEBHOOK_BASE_URL || '').replace(/\/+$/, '');
  if (!sid || !key || !secret || !base) {
    console.error('Missing TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, or WEBHOOK_BASE_URL');
    process.exit(1);
  }
  const client = twilio(key, secret, { accountSid: sid });
  const smsUrl = `${base}/webhooks/sms`;
  const numbers = [process.env.TWILIO_OUTREACH_NUMBER, process.env.TWILIO_SELLER_NUMBER]
    .filter((n): n is string => Boolean(n));

  for (const phone of numbers) {
    try {
      const found = await client.incomingPhoneNumbers.list({ phoneNumber: phone, limit: 1 });
      if (!found.length) { console.error(`[webhooks] not found in account: ${phone}`); continue; }
      const rec = found[0];
      console.log(`[webhooks] ${phone} before: smsUrl=${rec.smsUrl || '(none)'}`);
      const updated = await client.incomingPhoneNumbers(rec.sid).update({ smsUrl, smsMethod: 'POST' });
      console.log(`[webhooks] ${phone} after:  smsUrl=${updated.smsUrl}`);
    } catch (e) {
      console.error(`[webhooks] failed for ${phone}:`, (e as Error).message);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
