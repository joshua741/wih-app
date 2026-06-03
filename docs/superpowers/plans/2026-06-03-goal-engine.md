# Goal Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Vince conversation an explicit immediate goal + long-term goal + owner; make Vince lead toward the immediate goal and, on achievement, notify the owner and hand the conversation off.

**Architecture:** Add goal columns to `contacts`, a pure tested helper for default goals + the prompt goal-block, default-set goals on new inbound contacts (and backfill existing), inject the goal block into Vince's system prompt, detect a `[GOAL_MET]` tag → mark met + notify owner + hand off, and surface/edit goals in the lead panel. Builds on the live conversation core.

**Tech Stack:** TypeScript, Express 5, `pg` (Supabase), Anthropic SDK, Twilio (API key/secret), React, `node:test`.

---

## File Structure

**Create:**
- `src/lib/goals.ts` — pure helpers: `goalsForPipeline(pipeline)` and `buildGoalBlock(immediate, longTerm)`.
- `src/lib/goals.test.ts` — unit tests.
- `src/db/backfill-goals.ts` — one-shot: fill goals on existing contacts.

**Modify:**
- `src/db/schema.sql` — add four goal columns (idempotent).
- `src/routes/sms.ts` — set default goals on new-contact insert.
- `src/services/ai.ts` — goal fields on `Contact`, SELECT them, goal-aware `buildSystemPrompt(contact)`, `[GOAL_MET]` parsing + handoff in `applyActions`.
- `src/routes/api.ts` — allow goal fields in `PATCH /contacts/:id`.
- `package.json` — add goals test file to `test`; add `backfill-goals` script.
- `client/src/types.ts` — goal fields on `Contact`.
- `client/src/components/LeadPanel.tsx` — Goal section in the Details tab.

---

## Task 1: Goal helper (pure, TDD)

**Files:**
- Create: `src/lib/goals.ts`
- Test: `src/lib/goals.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test** — create `src/lib/goals.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { goalsForPipeline, buildGoalBlock } from './goals';

test('goalsForPipeline: agent_outreach goals + owner', () => {
  const g = goalsForPipeline('agent_outreach');
  assert.match(g.immediateGoal, /deal submitted/i);
  assert.match(g.longTermGoal, /deal flow/i);
  assert.equal(g.owner, 'angel');
});

test('goalsForPipeline: seller_inbound goals + owner', () => {
  const g = goalsForPipeline('seller_inbound');
  assert.match(g.immediateGoal, /qualify/i);
  assert.match(g.longTermGoal, /referrals/i);
  assert.equal(g.owner, 'angel');
});

test('goalsForPipeline: unknown pipeline falls back to seller_inbound', () => {
  assert.deepEqual(goalsForPipeline('whatever'), goalsForPipeline('seller_inbound'));
});

test('buildGoalBlock embeds both goals and the GOAL_MET instruction', () => {
  const block = buildGoalBlock('Book the appointment', 'Stay in touch for referrals');
  assert.match(block, /Book the appointment/);
  assert.match(block, /Stay in touch for referrals/);
  assert.match(block, /\[GOAL_MET\]/);
});
```

- [ ] **Step 2: Add the test file to the `test` script in `package.json`** — append ` src/lib/goals.test.ts` before the closing quote of the `test` script:

```json
    "test": "node --require ts-node/register/transpile-only --test src/lib/csv.test.ts src/lib/normalize.test.ts src/lib/categorize.test.ts src/lib/filterSpec.test.ts src/lib/pipelineRouting.test.ts src/lib/goals.test.ts",
```

- [ ] **Step 3: Run the test to verify it FAILS**

Run: `npm test`
Expected: FAIL — `Cannot find module './goals'`.

- [ ] **Step 4: Implement `src/lib/goals.ts`:**

```typescript
// Default conversation goals per pipeline, plus the prompt goal-block builder.
// Pure + unit-testable. See docs/superpowers/specs/2026-06-03-goal-engine-design.md.
export type GoalOwner = 'josh' | 'angel';

export interface PipelineGoals {
  immediateGoal: string;
  longTermGoal: string;
  owner: GoalOwner;
}

const GOALS: Record<string, PipelineGoals> = {
  agent_outreach: {
    immediateGoal: 'Build rapport and get an off-market or pre-foreclosure deal submitted.',
    longTermGoal: 'Stay top-of-mind for perpetual deal flow; when a deal closes or dies, re-engage for the next one.',
    owner: 'angel',
  },
  seller_inbound: {
    immediateGoal: 'Qualify the situation (property, condition, timeline, price/mortgage) and move toward an offer or a booked appointment.',
    longTermGoal: 'After they sell, follow up for referrals and any other properties they know about.',
    owner: 'angel',
  },
};

export function goalsForPipeline(pipeline: string): PipelineGoals {
  return GOALS[pipeline] ?? GOALS.seller_inbound;
}

export function buildGoalBlock(immediateGoal: string, longTermGoal: string): string {
  return [
    `YOUR GOAL FOR THIS CONVERSATION: ${immediateGoal}`,
    `WHY YOU'RE IN TOUCH (long-term): ${longTermGoal}`,
    `Lead the conversation toward the goal naturally (NEPQ-style) — don't read a script. Keep the big picture in mind.`,
    `When you have ACHIEVED the goal (e.g. appointment booked, deal agreed), include [GOAL_MET] on the tag line at the end.`,
  ].join('\n');
}
```

- [ ] **Step 5: Run the test to verify it PASSES**

Run: `npm test`
Expected: PASS — all suites green including the 4 new goals tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/goals.ts src/lib/goals.test.ts package.json
git commit -m "feat: goal defaults + prompt goal-block helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Goal columns on `contacts`

**Files:**
- Modify: `src/db/schema.sql`

- [ ] **Step 1: Add the columns**

In `src/db/schema.sql`, immediately after the `CREATE TABLE IF NOT EXISTS contacts (...)` statement (after its closing `);`), add:

```sql
-- Goal engine: per-contact immediate + long-term goals, owner, status
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS immediate_goal TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS long_term_goal TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS goal_owner TEXT CHECK (goal_owner IN ('josh','angel'));
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS goal_status TEXT NOT NULL DEFAULT 'active' CHECK (goal_status IN ('active','met'));
```

- [ ] **Step 2: Apply and verify**

Run: `npm run migrate`
Expected: `[MIGRATE] Done.` no error.

Run: `node -e "require('dotenv/config');const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});p.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='contacts' AND column_name IN ('immediate_goal','long_term_goal','goal_owner','goal_status') ORDER BY column_name\").then(r=>{console.log(r.rows.map(x=>x.column_name));return p.end()})"`
Expected: `[ 'goal_owner', 'goal_status', 'immediate_goal', 'long_term_goal' ]`.

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.sql
git commit -m "feat: add goal columns to contacts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Default goals on new inbound contact

**Files:**
- Modify: `src/routes/sms.ts`

- [ ] **Step 1: Import the helper**

At the top of `src/routes/sms.ts`, alongside the existing `pipelineRouting` import, add:

```typescript
import { goalsForPipeline } from '../lib/goals';
```

- [ ] **Step 2: Compute goals next to the routing**

Where the handler computes `const pipeline = pipelineForNumber(To);` etc., add right after those lines:

```typescript
    const goals = goalsForPipeline(pipeline);
```

- [ ] **Step 3: Include goals in the contact insert**

Replace the contact-upsert `pool.query(...)` call with this version (adds `immediate_goal`, `long_term_goal`, `goal_owner`):

```typescript
    // 1. Upsert contact — pipeline/type/stage/goals chosen by which WIH number was texted.
    const contactResult = await pool.query<{ id: string; is_dnc: boolean; human_takeover: boolean; ai_active: boolean }>(
      `INSERT INTO contacts (id, phone, source, pipeline, contact_type, stage_id, immediate_goal, long_term_goal, goal_owner)
       VALUES ($1, $2, $3, $3, $4, (SELECT id FROM pipeline_stages WHERE name = $5), $6, $7, $8)
       ON CONFLICT (phone) DO UPDATE SET updated_at = NOW()
       RETURNING id, is_dnc, human_takeover, ai_active`,
      [uuidv4(), From, pipeline, contactType, stageName, goals.immediateGoal, goals.longTermGoal, goals.owner]
    );
```

(Existing contacts keep their goals — the `ON CONFLICT` path is unchanged.)

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/routes/sms.ts
git commit -m "feat: set default goals on new inbound contacts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Backfill goals on existing contacts

**Files:**
- Create: `src/db/backfill-goals.ts`
- Modify: `package.json`

- [ ] **Step 1: Create the script** — `src/db/backfill-goals.ts`:

```typescript
import 'dotenv/config';
import { pool } from './pool';
import { goalsForPipeline } from '../lib/goals';

// One-shot: fill immediate_goal/long_term_goal/goal_owner for contacts missing them.
// Idempotent — only fills NULLs (COALESCE keeps any existing value).
async function main() {
  const rows = (await pool.query<{ id: string; pipeline: string }>(
    `SELECT id, pipeline FROM contacts WHERE immediate_goal IS NULL OR goal_owner IS NULL`
  )).rows;
  console.log('[BACKFILL-GOALS] contacts to fill:', rows.length);
  for (const r of rows) {
    const g = goalsForPipeline(r.pipeline);
    await pool.query(
      `UPDATE contacts
       SET immediate_goal = COALESCE(immediate_goal, $1),
           long_term_goal = COALESCE(long_term_goal, $2),
           goal_owner     = COALESCE(goal_owner, $3)
       WHERE id = $4`,
      [g.immediateGoal, g.longTermGoal, g.owner, r.id]
    );
  }
  console.log('[BACKFILL-GOALS] done');
  await pool.end();
}

main().catch((e) => { console.error('[BACKFILL-GOALS] Failed:', e); process.exit(1); });
```

- [ ] **Step 2: Add npm script** — in `package.json` `scripts`, after `import-contacts` (add trailing comma), add:

```json
    "backfill-goals": "ts-node src/db/backfill-goals.ts",
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (Do NOT run the backfill yet — that happens in the final deploy task so it runs against current prod data once.)

- [ ] **Step 4: Commit**

```bash
git add src/db/backfill-goals.ts package.json
git commit -m "feat: one-shot backfill of goals on existing contacts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Goal-aware Vince + completion handoff (`services/ai.ts`)

**Files:**
- Modify: `src/services/ai.ts`

- [ ] **Step 1: Import the goal helpers**

At the top of `src/services/ai.ts`, add to the imports:

```typescript
import { goalsForPipeline, buildGoalBlock } from '../lib/goals';
```

- [ ] **Step 2: Extend the `Contact` interface** — add the goal fields:

```typescript
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
  immediate_goal: string | null;
  long_term_goal: string | null;
  goal_owner: 'josh' | 'angel' | null;
  goal_status: string;
}
```

- [ ] **Step 3: Load the goal columns** — in `handleInboundSMS`, the contact SELECT currently is:
`SELECT id, phone, name, pipeline, stage_id, human_takeover, ai_active, is_dnc, metadata FROM contacts WHERE id = $1`.
Change it to also select the goal columns:

```typescript
  const contactResult = await pool.query<Contact>(
    `SELECT id, phone, name, pipeline, stage_id, human_takeover, ai_active, is_dnc, metadata,
            immediate_goal, long_term_goal, goal_owner, goal_status
     FROM contacts WHERE id = $1`,
    [contactId]
  );
```

- [ ] **Step 4: Make `buildSystemPrompt` goal-aware** — replace the existing `buildSystemPrompt`:

```typescript
function buildSystemPrompt(contact: Contact): string {
  const base = contact.pipeline === 'agent_outreach' ? AGENT_SYSTEM_PROMPT : SELLER_SYSTEM_PROMPT;
  const defaults = goalsForPipeline(contact.pipeline);
  const immediate = contact.immediate_goal || defaults.immediateGoal;
  const longTerm = contact.long_term_goal || defaults.longTermGoal;
  return `${base}\n\n${buildGoalBlock(immediate, longTerm)}`;
}
```

And update the call site in `handleInboundSMS` from `system: buildSystemPrompt(contact.pipeline),` to:

```typescript
    system: buildSystemPrompt(contact),
```

- [ ] **Step 5: Parse `[GOAL_MET]`** — in the `ParsedResponse` interface, add `goalMet: boolean` to the `actions` object. In `parseAIResponse`, initialize `goalMet: false` in the `actions` object, add detection, and strip the tag:

In the actions initializer:
```typescript
  const actions: ParsedResponse['actions'] = {
    humanTakeover: false,
    dealType: null,
    dead: false,
    tier: null,
    goalMet: false,
  };
```
After the other tag matches:
```typescript
  actions.goalMet = /\[GOAL_MET\]/i.test(raw);
```
And add to the `.replace(...)` chain that strips tags:
```typescript
    .replace(/\[GOAL_MET\]/gi, '')
```

- [ ] **Step 6: Handle goal completion in `applyActions`** — at the end of `applyActions` (after the human-takeover block, before the closing brace), add:

```typescript
  // Goal met → notify owner + hand off
  if (actions.goalMet && contact.goal_status !== 'met') {
    const owner = (contact.goal_owner ?? goalsForPipeline(contact.pipeline).owner) as 'josh' | 'angel';
    await pool.query(
      `UPDATE contacts SET goal_status = 'met', human_takeover = TRUE, takeover_by = $1, ai_active = FALSE WHERE id = $2`,
      [owner, contact.id]
    );
    const label = contact.name ?? contact.phone;
    const goalText = contact.immediate_goal || goalsForPipeline(contact.pipeline).immediateGoal;
    await dealRouting.sendNotification(
      owner,
      `Goal met for ${label} (${contact.phone}): ${goalText} — handed to you, take it from here.`
    );
    broadcast('contact:goal_met', { id: contact.id, owner });
    broadcast('contact:takeover', { id: contact.id, agent: owner });
  }
```

(`dealRouting` is already imported at the top of `applyActions` via `const { dealRouting } = await import('./dealRouting');`; `broadcast` and `pool` are already imported in the file.)

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/services/ai.ts
git commit -m "feat: goal-aware Vince prompt + [GOAL_MET] detection and owner handoff

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Expose goal fields in the API + client types

**Files:**
- Modify: `src/routes/api.ts`
- Modify: `client/src/types.ts`

- [ ] **Step 1: Allow goal fields in the contact PATCH**

In `src/routes/api.ts`, the `PATCH /contacts/:id` handler has an `allowed` array. Add the three editable goal fields (NOT `goal_status` — that is system-managed). Change the array to include them:

```typescript
  const allowed = ['name','email','address','city','state','zip','stage_id','pipeline','is_dnc','dnc_reason','human_takeover','takeover_by','ai_active','notes','metadata','immediate_goal','long_term_goal','goal_owner'];
```

- [ ] **Step 2: Add goal fields to the client `Contact` type**

In `client/src/types.ts`, in the `Contact` interface, add (after `metadata`):

```typescript
  immediate_goal: string | null
  long_term_goal: string | null
  goal_owner: 'josh' | 'angel' | null
  goal_status: string
```

- [ ] **Step 3: Type-check both**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `cd client && rm -f node_modules/.tmp/*.tsbuildinfo && npx tsc -p tsconfig.app.json --noEmit; cd ..`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/api.ts client/src/types.ts
git commit -m "feat: allow editing goal fields via contact PATCH + client types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Goal section in the lead panel

**Files:**
- Modify: `client/src/components/LeadPanel.tsx`

- [ ] **Step 1: Add goal state**

In `LeadPanel`, with the other Details-form `useState` declarations (after `const [zip, setZip] = useState(contact.zip ?? '')`), add:

```typescript
  const [immediateGoal, setImmediateGoal] = useState(contact.immediate_goal ?? '')
  const [longTermGoal, setLongTermGoal] = useState(contact.long_term_goal ?? '')
  const [goalOwner, setGoalOwner] = useState<'josh' | 'angel'>(contact.goal_owner ?? 'angel')
```

- [ ] **Step 2: Reset goal state when the contact switches**

In the `useEffect(() => { ... }, [contact.id])` that resets the form fields, add:

```typescript
    setImmediateGoal(contact.immediate_goal ?? '')
    setLongTermGoal(contact.long_term_goal ?? '')
    setGoalOwner(contact.goal_owner ?? 'angel')
```

- [ ] **Step 3: Include goals in the save**

In `handleSaveDetails`, add the three goal fields to the `patchContact` payload:

```typescript
      const updated = await patchContact(contact.id, {
        name: name || null,
        email: email || null,
        address: address || null,
        city: city || null,
        state: stateVal || null,
        zip: zip || null,
        immediate_goal: immediateGoal || null,
        long_term_goal: longTermGoal || null,
        goal_owner: goalOwner,
      })
```

- [ ] **Step 4: Render the Goal section in the Details tab**

In the Details tab JSX, immediately after the `Stage` Field (the `<Field label="Stage">...</Field>` block) and before the Save Details button, add:

```tsx
          <div className="border-t border-white/10 pt-3 mt-1 flex flex-col gap-3">
            <div className="text-[10px] font-bold tracking-widest text-slate-500 uppercase">
              Goal {contact.goal_status === 'met' && <span className="ml-1 text-emerald-400">· met</span>}
            </div>
            <Field label="Immediate goal">
              <textarea value={immediateGoal} onChange={e => setImmediateGoal(e.target.value)}
                rows={2} placeholder="What Vince is driving toward now"
                className={inputCls + ' resize-none'} />
            </Field>
            <Field label="Long-term goal">
              <textarea value={longTermGoal} onChange={e => setLongTermGoal(e.target.value)}
                rows={2} placeholder="Why we stay in touch"
                className={inputCls + ' resize-none'} />
            </Field>
            <Field label="Owner">
              <div className="flex gap-2">
                <button type="button" onClick={() => setGoalOwner('angel')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-lg border transition-colors ${goalOwner === 'angel' ? 'bg-emerald-600/30 text-emerald-300 border-emerald-500/40' : 'bg-white/5 text-slate-400 border-white/10'}`}>
                  Angel
                </button>
                <button type="button" onClick={() => setGoalOwner('josh')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-lg border transition-colors ${goalOwner === 'josh' ? 'bg-blue-600/30 text-blue-300 border-blue-500/40' : 'bg-white/5 text-slate-400 border-white/10'}`}>
                  Josh
                </button>
              </div>
            </Field>
          </div>
```

(The existing **Save Details** button already calls `handleSaveDetails`, which now persists the goal fields too.)

- [ ] **Step 5: Type-check the client**

Run: `cd client && rm -f node_modules/.tmp/*.tsbuildinfo && npx tsc -p tsconfig.app.json --noEmit; cd ..`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/LeadPanel.tsx
git commit -m "feat: view + edit immediate/long-term goal and owner in lead panel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Deploy, backfill, and live test (controller-run)

**Files:** none (deploy + data op + live test). Run by the controller, not a subagent.

- [ ] **Step 1: Build the client locally to catch any error**

Run: `cd client && npm run build && cd ..`
Expected: builds clean.

- [ ] **Step 2: Merge to master and deploy**

```bash
git checkout master
git merge --no-ff feat/goal-engine -m "Merge: Goal Engine — goal-oriented conversations"
git push origin master
```
Expected: Railway auto-builds, runs `npm run migrate` (adds the goal columns), starts the server.

- [ ] **Step 3: Confirm deploy + columns**

Run: `node -e "fetch('https://web-production-bcdba.up.railway.app/health').then(r=>r.json()).then(j=>console.log('health',j.status))"`
Expected: `health ok`. Then re-run the column-check query from Task 2 Step 2 against prod — expect the four goal columns.

- [ ] **Step 4: Backfill existing contacts' goals**

Run: `npm run backfill-goals`
Expected: `[BACKFILL-GOALS] contacts to fill: N` then `done`.

- [ ] **Step 5: Live acceptance test (from a phone, ideally a different number than JOSH_PHONE so it's a clean seller)**

1. Text the **seller** line (806-808-0719): "Hi, thinking about selling my house." → Vince replies, leading toward qualifying/booking (goal-driven).
2. Continue until you can prompt Vince to "book a time" — when he treats the goal as achieved, he emits `[GOAL_MET]` (stripped from the text you see).
3. On `[GOAL_MET]`: the owner (Angel by default) should receive a "Goal met…" SMS, and the contact should flip to handoff.

- [ ] **Step 6: Verify the handoff in the data**

Run: `node -e "require('dotenv/config');const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});p.query(\"SELECT phone,goal_status,human_takeover,takeover_by,ai_active,left(immediate_goal,40) goal FROM contacts ORDER BY updated_at DESC LIMIT 3\").then(r=>{console.log(r.rows);return p.end()})"`
Expected: the test contact shows `goal_status=met`, `human_takeover=true`, `takeover_by` = the owner, `ai_active=false`.

- [ ] **Step 7: Verify edit in the dashboard**

Open the live app, select the test contact, go to the Details tab, edit the immediate goal and toggle the owner, Save, and confirm it persists on reload.

---

## Self-Review Notes

- **Spec coverage:** data model (Task 2), `goalsForPipeline`/`buildGoalBlock` (Task 1), defaults on creation (Task 3) + backfill (Task 4), goal-aware prompt + `[GOAL_MET]` + handoff (Task 5), API edit + types (Task 6), lead-panel view/edit (Task 7), deploy/backfill/live test (Task 8). Long-term-goal *action* (re-engagement) is correctly out of scope (2c).
- **Type consistency:** `goalsForPipeline` returns `{ immediateGoal, longTermGoal, owner }` (used in Tasks 1,3,4,5); `Contact` (server) gains `immediate_goal/long_term_goal/goal_owner/goal_status` (Task 5) matching the SELECT and the DB columns (Task 2); client `Contact` mirrors them (Task 6) and the lead panel binds them (Task 7); the PATCH allow-list (Task 6) matches the fields the panel sends (Task 7); `buildSystemPrompt(contact)` signature change is updated at its only call site (Task 5).
- **No placeholders:** every code step is complete; every verify step has a command + expected output.
