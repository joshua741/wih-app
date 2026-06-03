import 'dotenv/config';
import twilio from 'twilio';

// Read-only: list current smsUrl for both WIH Twilio numbers.
(async () => {
  const c = twilio(process.env.TWILIO_API_KEY, process.env.TWILIO_API_SECRET, { accountSid: process.env.TWILIO_ACCOUNT_SID });
  for (const p of [process.env.TWILIO_OUTREACH_NUMBER, process.env.TWILIO_SELLER_NUMBER]) {
    const f = await c.incomingPhoneNumbers.list({ phoneNumber: p, limit: 1 });
    console.log(p, f[0] ? f[0].smsUrl || '(none)' : 'NOT FOUND');
  }
})();
