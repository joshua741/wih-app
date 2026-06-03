# Vince Conversation Core — Live Inbound SMS

**Date:** 2026-06-03
**Status:** Approved design — ready for implementation plan
**Owner:** Joshua
**Milestone:** 1 of the three-engine north star ([[build-north-star]]). Proves the shared conversation loop that agent outreach, seller outreach, and disposition all sit on top of.

---

## Purpose

Make Vince actually hold a live SMS conversation. A real person texts one of the two Twilio numbers, Vince replies via Claude in the correct persona, the contact lands in the correct pipeline with a stage, and compliance (opt-out), human-takeover, and deal-routing all fire. Today the code for this is ~built but unproven: the database has **0 messages**, the Twilio numbers were never pointed at the app, and an inbound-routing bug forces every contact into the seller pipeline.

## Background — verified current state

- **Railway env is fully provisioned** (confirmed 2026-06-03): `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_AUTH_TOKEN`, `TWILIO_OUTREACH_NUMBER`, `TWILIO_SELLER_NUMBER`, `JOSH_PHONE`, `ANGEL_PHONE`, and `WEBHOOK_BASE_URL` (set to the bare app URL `https://web-production-bcdba.up.railway.app`, no `/webhooks` suffix, no trailing slash).
- Because both credential styles are set, both Twilio client constructions in the code work — the earlier "credential mismatch" concern is **not** a runtime blocker.
- `ai.ts` already selects the system prompt from `contact.pipeline` (`agent_outreach` → agent persona, else seller persona), parses Vince's `[TAG]`s, advances stages, routes deals, and triggers human-takeover. `compliance.ts` handles opt-out / human-needed / DNC. `routes/sms.ts` receives the webhook, upserts contact + conversation + message, and kicks off the AI reply via `setImmediate`.
- **The gaps that keep it from working:** (1) `routes/sms.ts` hardcodes new contacts to `pipeline = 'seller_inbound'` regardless of which number was texted, so agent-number texts get the seller persona; (2) the Twilio numbers' webhooks are not pointed at the app; (3) no `Dead` pipeline stage is seeded, so `[DEAD]` tagging has no stage to move to; (4) `routes/api.ts` builds a manual-reply status callback as `${WEBHOOK_BASE_URL}/sms/status`, missing the `/webhooks` segment.

## Scope (this milestone)

### 1. Inbound pipeline routing (`src/routes/sms.ts` + a small helper)
- Add a pure helper `pipelineForNumber(toNumber)` → `'agent_outreach'` when `toNumber === process.env.TWILIO_OUTREACH_NUMBER`, otherwise `'seller_inbound'`. (Default to seller for any unknown number.)
- On inbound, for a **new** contact, set `pipeline`, `source` (= the pipeline), and `contact_type` (`agent_outreach` → `'agent'`, else `'seller'`) from the helper, and set `stage_id` to that pipeline's **first** stage (`New Agent Lead` for agent, `New Lead` for seller) so the contact appears on the board immediately.
- For an **existing** contact (ON CONFLICT), do not change their pipeline/stage — only bump `updated_at` (current behavior).
- The conversation continues to store `twilio_number = To`, and Vince already picks his persona from `contact.pipeline`, so this single fix corrects the persona problem end-to-end.

### 2. Seed a `Dead` stage per outreach pipeline (`src/db/schema.sql`)
- Add `('Dead', 'agent_outreach', 99, '#64748b')` and `('Dead', 'seller_inbound', 99, '#64748b')` to the seed `INSERT ... ON CONFLICT (name) DO NOTHING`.
- Note: `pipeline_stages.name` is globally `UNIQUE`, so both rows cannot be literally named `Dead`. Use distinct names `Dead (Agent)` and `Dead (Seller)`, and update the dead-handling lookup in `ai.ts` accordingly (it currently calls `getStageId('Dead', contact.pipeline)`), OR change the lookup to find a stage whose pipeline matches and whose name starts with `Dead`. Chosen approach: seed names `Dead (Agent)` / `Dead (Seller)` and change `ai.ts` dead-handling to look up the dead stage by `pipeline` + name pattern so it stays correct. Idempotent via `ON CONFLICT (name) DO NOTHING`. Re-applied on deploy by the existing `npm run migrate`.

### 3. Webhook URL fix (`src/routes/api.ts`)
- Change the manual-reply status callback from `${process.env.WEBHOOK_BASE_URL}/sms/status` to `${process.env.WEBHOOK_BASE_URL}/webhooks/sms/status`, matching the actual route and the `ai.ts` convention.

### 4. Point Twilio at the app (`src/scripts/set-twilio-webhooks.ts`, run once)
- A one-shot script using the Twilio SDK (account SID + auth token from env) that, for both `TWILIO_OUTREACH_NUMBER` and `TWILIO_SELLER_NUMBER`, sets:
  - SMS inbound webhook → `${WEBHOOK_BASE_URL}/webhooks/sms` (HTTP POST)
  - SMS status callback → `${WEBHOOK_BASE_URL}/webhooks/sms/status` (HTTP POST)
- It looks up each number's IncomingPhoneNumber SID by phone number, then updates it. Prints before/after URLs. Safe to re-run (idempotent — sets the same values).
- Add an npm script `set-webhooks` to run it.

## Architecture / data flow

```
Twilio (inbound SMS to a WIH number)
  → POST /webhooks/sms
    → upsert contact  (pipeline/stage/type chosen by the To number)
    → upsert conversation (twilio_number = To)
    → store inbound message
    → broadcast sms:inbound
    → setImmediate:
        → checkCompliance(contactId, body)   // DNC / opt-out / human-needed / stale
        → if not blocked: ai.handleInboundSMS()
            → load history → Claude (claude-sonnet-4-6, persona by pipeline)
            → send reply via Twilio (from = the WIH number)
            → store outbound message + broadcast
            → applyActions: stage tier, deal-type → routing notify, dead, human-takeover
  → respond empty TwiML (reply sent separately over REST)
```

No schema change beyond the two seeded `Dead` stages. No new tables.

## Error handling

- `routes/sms.ts` keeps its try/catch and always returns empty TwiML so Twilio never sees a 5xx for the inbound (the AI reply is sent asynchronously over REST). The `setImmediate` block logs AI errors without failing the webhook.
- The webhook-setter script wraps each number update in try/catch and reports per-number success/failure; a failure on one number does not abort the other.
- `pipelineForNumber` is total (always returns a valid pipeline), so an unrecognized `To` degrades safely to the seller pipeline rather than throwing.

## Testing

- **Unit (node:test):** `pipelineForNumber` returns `agent_outreach` for the outreach number, `seller_inbound` for the seller number, and `seller_inbound` for an unknown number. (Set the env vars in the test.)
- **Acceptance — live, after deploy + running the webhook setter:**
  1. From Josh's phone, text the **seller** number → within ~10s Vince replies in the seller persona; `directory`/pipeline `contacts` shows the contact in `seller_inbound` on the `New Lead` stage; an inbound + outbound `messages` row exist.
  2. Text the **outreach** number → Vince replies in the **agent** persona; contact in `agent_outreach` on `New Agent Lead`.
  3. Reply `STOP` → exactly one final opt-out confirmation; contact flagged `is_dnc = true`, `ai_active = false`; no further replies.
  4. Confirm the live dashboard shows the new contact(s) and messages.

## Out of scope — milestone 2 (captured so it's not lost)

The full outreach + follow-up engine, per Joshua's 2026-06-03 direction:
- **Outbound / first-touch initiation:** Vince sends the first text to a list (agents or sellers), not just responding to inbound.
- **Source-aware outreach for sellers:** behavior differs by how the contact entered — ISP-to-lead vs. manually input — including whether we are *following up* vs. first contact.
- **Follow-up sequences, manual + automatic:**
  - *Manual follow-up:* a human designates a contact to follow up with, adds free-text context (Vince also reads existing notes), and the AI runs the follow-up.
  - *Automatic follow-up:* scheduled/sequenced cadence.
- **Goal + owner model:** each follow-up has a goal/outcome and an associated human (Josh **or** Angel) via a toggle. When the goal is met (e.g. a meeting is booked), the contact routes to that associated person. Same pattern for agents and sellers.
- **Disposition engine:** buyer matching + outbound to sell deals.

These build on the conversation core proven in this milestone and will each get their own spec.
