# Outbound Initiation — Vince Sends the First Text

**Date:** 2026-06-03
**Status:** Approved design — ready for implementation plan
**Owner:** Joshua
**Milestone:** 2b of the three-engine north star ([[build-north-star]]). Adds proactive first-touch so the "active outreach" engines can start conversations, not just respond. Builds on the live conversation core (milestone 1) and the goal engine (2a). 2c (follow-up cadences) and 2d (disposition) come later.

---

## Purpose

Let a human select contacts in the Contacts CRM and have Vince send each a personalized, goal-driven **first text**. Once sent, replies flow into the existing inbound loop (Vince leads toward the goal, hands off on completion). Today Vince only responds to inbound; this unlocks proactively reaching agents and sellers.

## Background — current state

- Inbound loop is live: `routes/sms.ts` → `services/ai.ts handleInboundSMS` (Claude reply, goal-aware, `[GOAL_MET]` handoff). Outbound SMS uses the working Twilio **API key/secret** path.
- `directory_contacts` (14,206) is the source rolodex; `routes/directory.ts` has bulk actions incl. `POST /promote` (inserts into pipeline `contacts`). Pipeline `contacts` carry pipeline, stage, goals (2a), `is_dnc`, `human_takeover`, `ai_active`.
- `pipeline_stages` first stages: `New Agent Lead` (agent_outreach), `New Lead` (seller_inbound). `goalsForPipeline(pipeline)` gives default goals + owner.
- Numbers: agent_outreach → `TWILIO_OUTREACH_NUMBER` (806-547-2532), seller_inbound → `TWILIO_SELLER_NUMBER` (806-808-0719), both webhook-wired.
- There is no way to send a first message; a promoted contact just sits with no conversation.

## Scope

### 1. Opener generation — `services/ai.ts`
- Export `generateOpener(contact): Promise<string>` — calls Claude with the goal-aware system prompt (reuse `buildSystemPrompt(contact)`) plus a user instruction to write the FIRST outreach text: short, natural, on-goal, not salesy, and ending with a brief opt-out (e.g. "…reply STOP to opt out"). Returns the message text (strip any stray tags via the existing parse).
- Add a pure, testable `buildOpenerInstruction(): string` (the static user-instruction text incl. the opt-out requirement) so the prompt content is unit-tested without calling Claude.

### 2. Eligibility filter — `src/lib/outreach.ts` (pure, tested)
- `isOutreachEligible({ isDnc, phone, hasConversation }): { ok: boolean; reason?: string }` — not eligible if `is_dnc`, no usable `phone`, or a pipeline conversation already exists (no double-touch). Pure → unit-testable.

### 3. Outreach service — `src/services/outreach.ts`
- `startOutreach({ ids, pipeline }): Promise<{ queued: number }>` where `ids` are `directory_contacts` ids and `pipeline` ∈ {`agent_outreach`,`seller_inbound`}.
- Validates pipeline; loads the selected directory contacts; returns `{ queued }` = count that will be attempted, then processes the sends **in the background** (so the HTTP request returns fast), **throttled** (sequential with a short delay; per-run cap, default 25 — excess are skipped and logged).
- Per contact:
  1. Resolve/insert the pipeline `contacts` row by phone: if it exists, load it; else insert with `pipeline`, `source='outreach'`, `contact_type` (agent/seller), first-stage `stage_id`, and default goals from `goalsForPipeline(pipeline)`. (`ON CONFLICT (phone)` safe.)
  2. Check `isOutreachEligible` (DNC / phone / existing conversation) — skip + log if not ok.
  3. `generateOpener(contact)` → opener text.
  4. Send via Twilio (API key/secret) from the pipeline's number to the contact's phone, with the per-message `statusCallback` (`${WEBHOOK_BASE_URL}/webhooks/sms/status`).
  5. Insert the `conversations` row (`twilio_number` = the pipeline number) and the outbound `messages` row (`sender='ai'`), mark `directory_contacts.promoted_to_pipeline = TRUE`, and `broadcast('sms:outbound', ...)`.
- Each contact wrapped in try/catch; one failure logs and continues.

### 4. API — `routes/directory.ts`
- `POST /api/directory/start-outreach` `{ ids: string[], pipeline: string }` → validates (`ids` non-empty, pipeline valid) → calls `startOutreach` → responds `{ queued }`.

### 5. UI — Contacts CRM (`client`)
- Add a **"Start outreach"** action to the directory bulk toolbar (where Export/Promote live), shown when rows are selected.
- It opens a tiny inline picker: choose **Agent** or **Seller** pipeline, shows the selected count, and a Send button → `startOutreachApi(ids, pipeline)`; on success show "Queued N" and clear the selection.
- API client `startOutreachApi(ids, pipeline)` in `client/src/api.ts`.

## Data flow

```
CRM: select contacts → Start outreach → pick pipeline → POST /api/directory/start-outreach {ids, pipeline}
  → respond { queued } immediately
  → background, throttled, per contact:
      resolve/insert pipeline contact (goals + stage by pipeline)
      → eligibility (skip DNC / no phone / already in a conversation)
      → generateOpener via Claude (persona + goal + opt-out)
      → Twilio send from the pipeline number
      → store conversation + outbound message, mark promoted, broadcast
  → contact replies → existing inbound loop (goal-driven Vince, [GOAL_MET] handoff)
```

## Error handling

- Per-contact try/catch in the loop — a Twilio/Claude failure on one contact logs and does not stop the run.
- Eligibility skips (DNC / no phone / already in conversation) are counted and logged, never sent.
- The endpoint validates `pipeline` and non-empty `ids`, returning 400 otherwise.
- Background processing never throws into the HTTP response (request already returned `{ queued }`).

## Compliance

- **Opt-out on first contact:** the generated opener includes a brief opt-out line; STOP/UNSUBSCRIBE handling already exists in `compliance.ts`, and `is_dnc` contacts are filtered out before sending.
- **A2P 10DLC:** cold-outbound deliverability to strangers requires the Twilio numbers to be A2P 10DLC-registered. This is an external account step (cannot be automated here) and is a **prerequisite for real-volume outreach**, not for building or for the live test (which sends to the owner's own phone and delivers regardless). Flagged here so it isn't a surprise.
- **Throttle/cap** (default 25/run, short inter-send delay) reduces spam-pattern risk.

## Testing

- **Unit (node:test):** `isOutreachEligible` (DNC → not ok; no phone → not ok; existing conversation → not ok; otherwise ok); `buildOpenerInstruction` includes the opt-out requirement and "first" framing.
- **Live (after deploy):** in the CRM, select your own phone's contact (or add one), Start outreach → Agent, confirm you receive a natural Vince opener ending in an opt-out; reply → the existing inbound loop engages and is goal-driven. Verify in DB: a pipeline `contacts` row (with goals), a `conversations` row, and an outbound `messages` row; selecting a DNC contact is skipped.

## Out of scope (later sub-projects)

- **2c** — automatic/scheduled outreach and follow-up cadences (incl. acting on the long-term goal).
- **2d** — buyer disposition (buy-box capture, property matching).
- Bulk A2P registration / carrier setup (external Twilio account work).
