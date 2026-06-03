# Goal Engine — Goal-Oriented Conversations

**Date:** 2026-06-03
**Status:** Approved design — ready for implementation plan
**Owner:** Joshua
**Milestone:** 2a of the three-engine north star ([[build-north-star]]). The backbone that makes every Vince conversation goal-oriented ([[goal-oriented-conversations]]); 2b (outbound), 2c (follow-ups), 2d (disposition) build on it.

---

## Purpose

Make every Vince conversation **goal-oriented**: each contact carries a concrete *immediate* goal Vince actively drives toward (NEPQ-style, aware of the big picture), plus a *long-term* relationship goal that explains why we stay in touch. When Vince achieves the immediate goal he notifies the owner (Josh or Angel) and hands the conversation off. This builds directly on the live conversation core (inbound SMS → Claude reply → routing) shipped in milestone 1.

## Background — current state

- The live conversation core works: `routes/sms.ts` routes inbound by Twilio number into `agent_outreach` / `seller_inbound`; `services/ai.ts` builds a persona prompt via `buildSystemPrompt(contact.pipeline)`, calls Claude, sends the reply, and parses `[TAG]`s (`[TIER:n]`, `[DEAL_TYPE:..]`, `[DEAD]`, `[HUMAN_TAKEOVER]`) in `parseAIResponse` → `applyActions`.
- `contacts` already has `human_takeover`, `takeover_by` (`josh`/`angel`), `ai_active`, `metadata JSONB`.
- Twilio outbound uses the working API key/secret path; `dealRouting.sendNotification(to, message)` (Angel/Josh/both) is the notify mechanism.
- Vince's personas already embed implicit goals, but there is no explicit, per-contact, overridable goal, no long-term goal, and no goal-completion → owner-handoff step.

## Data model

Add four columns to `contacts` (migration in `schema.sql`, idempotent `ADD COLUMN IF NOT EXISTS`):

```sql
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS immediate_goal TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS long_term_goal TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS goal_owner TEXT CHECK (goal_owner IN ('josh','angel'));
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS goal_status TEXT NOT NULL DEFAULT 'active' CHECK (goal_status IN ('active','met'));
```

(`schema.sql` is re-run by `npm run migrate` on every deploy; `IF NOT EXISTS` keeps it safe.)

## Components

### 1. Goal defaults helper — `src/lib/goals.ts` (pure, tested)
`goalsForPipeline(pipeline)` returns `{ immediateGoal, longTermGoal, owner }`:
- **agent_outreach** — immediate: "Build rapport and get an off-market or pre-foreclosure deal submitted." long-term: "Stay top-of-mind for perpetual deal flow; when a deal closes or dies, re-engage for the next one." owner: `angel`.
- **seller_inbound** — immediate: "Qualify the situation (property, condition, timeline, price/mortgage) and move toward an offer or a booked appointment." long-term: "After they sell, follow up for referrals and any other properties they know about." owner: `angel`.

Owner is a sensible default (Angel = acquisitions); it is overridable per contact and is naturally refined to Josh when a creative deal is later classified (existing `dealRouting` behavior). Pure function so it is unit-testable.

### 2. Set defaults on contact creation + backfill
- `routes/sms.ts`: when inserting a NEW contact, also set `immediate_goal`, `long_term_goal`, `goal_owner` from `goalsForPipeline(pipeline)`. (`goal_status` defaults to `active`.) Existing-contact `ON CONFLICT` path is unchanged.
- One-time backfill (`src/db/backfill-goals.ts`, run once): for contacts whose goal fields are NULL, populate them from `goalsForPipeline(pipeline)`. Idempotent (only fills NULLs).

### 3. Goal-aware prompting — `services/ai.ts`
- Change `buildSystemPrompt(pipeline: string)` to `buildSystemPrompt(contact)` (it already receives the contact in `handleInboundSMS`). It keeps the existing persona base (agent vs seller by pipeline) and appends a **goal block**:
  ```
  YOUR GOAL FOR THIS CONVERSATION: <immediate_goal>
  WHY YOU'RE IN TOUCH (long-term): <long_term_goal>
  Lead the conversation toward the goal naturally (NEPQ-style) — don't read a script. Keep the big picture in mind.
  When you have ACHIEVED the goal (e.g. appointment booked, deal agreed), include [GOAL_MET] on the tag line.
  ```
- The `Contact` interface loaded in `handleInboundSMS` gains `immediate_goal`, `long_term_goal`, `goal_owner`, `goal_status` (the SELECT already loads the row; add these columns).
- If goal fields are null (older contact not yet backfilled), fall back to `goalsForPipeline(contact.pipeline)` so prompting is never empty.

### 4. Goal-completion detection + handoff — `services/ai.ts`
- `parseAIResponse` gains a `goalMet: boolean` from a `/\[GOAL_MET\]/i` test, and strips the tag from the outbound text (same pattern as the other tags).
- In `applyActions`, when `goalMet` and `goal_status !== 'met'`:
  - `UPDATE contacts SET goal_status='met', human_takeover=TRUE, takeover_by=goal_owner, ai_active=FALSE WHERE id=$1` (owner defaults to existing `goal_owner`, falling back to `angel`).
  - Notify the owner via `dealRouting.sendNotification(owner, message)` — message names the contact, phone, and the goal achieved.
  - `broadcast('contact:goal_met', { id, owner })` and `broadcast('contact:takeover', { id, agent: owner })`.
- This reuses the milestone-1 handoff semantics (`human_takeover` + `ai_active=false`), so Vince pauses on that contact and the human takes over.

### 5. View + edit goals — frontend (`client`)
- API: extend `PATCH /api/contacts/:id` allow-list to include `immediate_goal`, `long_term_goal`, `goal_owner` (the handler already does a generic allow-list update). `goal_status` is system-managed (not editable via this path).
- `contacts` GET/list already returns `c.*`, so the fields flow through.
- Lead panel (`client/src/components/LeadPanel.tsx`): a small "Goal" section showing immediate goal, long-term goal, owner (Josh/Angel toggle), and status; editing immediate/long-term goal (text) and owner (toggle) calls `patchContact`. Types in `client/src/types.ts` gain the four fields.

## Data flow

```
Inbound SMS → contact upserted with default goals (by pipeline)
  → Vince prompt = persona + GOAL BLOCK (immediate + long-term + owner)
  → Claude leads toward the immediate goal
  → on achievement Vince emits [GOAL_MET]
    → goal_status=met, human_takeover=true (takeover_by=owner), ai_active=false
    → SMS notify owner (Josh/Angel) + broadcast
  → human owns the conversation from here
Manual: in the lead panel, a human can edit the immediate goal / long-term goal / owner at any time.
```

## Error handling

- Goal columns are nullable/defaulted; missing goals fall back to `goalsForPipeline`, so a not-yet-backfilled contact still gets goal-aware prompting and never errors.
- `[GOAL_MET]` handling is guarded by `goal_status !== 'met'` so a repeated tag does not re-notify.
- Owner notify uses the existing `sendNotification` (per-recipient try/catch, won't crash the handler).
- Backfill only writes NULL fields → safe to re-run.

## Testing

- **Unit (node:test):** `goalsForPipeline` returns the right immediate/long-term/owner per pipeline (and a safe default for unknown); `parseAIResponse` sets `goalMet` true on `[GOAL_MET]` and strips it from the message; the goal-block builder includes the immediate + long-term goal text.
- **Live (after deploy + backfill):** from a phone, run a seller conversation to the booking point; when Vince emits `[GOAL_MET]`, confirm: the owner (Josh/Angel) receives the SMS notification, the contact shows `goal_status=met`, `human_takeover=true`, `ai_active=false`, and the lead panel reflects it. Edit a contact's goal/owner in the panel and confirm it persists.

## Out of scope (later sub-projects)

- **2b Outbound initiation** — Vince sending the first text to a selected list.
- **2c Follow-up engine** — manual follow-ups (human-supplied context + scheduling) and automatic cadences; **acting on the long-term goal** (re-engagement after a deal closes or dies) lives here. 2a only stores/displays the long-term goal.
- **2d Disposition** — buyer buy-box capture + property matching + outbound.
- Buyer pipeline persona/goals (no `buyer` pipeline exists yet; added when 2d is built).
