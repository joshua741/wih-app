# Outbound Initiation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human select contacts in the Contacts CRM and have Vince send each a personalized, goal-driven first text; replies then flow into the existing inbound loop.

**Architecture:** Pure rules (`outreachRules.ts`) decide eligibility and the opener instruction; `ai.generateOpener` produces the first message via Claude using the goal-aware prompt; `services/outreach.startOutreach` upserts the pipeline contact (with goals), checks eligibility, generates + sends the opener from the pipeline's Twilio number (background, throttled), and records the conversation/message; a directory endpoint + CRM toolbar action drive it.

**Tech Stack:** TypeScript, Express 5, `pg` (Supabase), Anthropic SDK, Twilio (API key/secret), React, `node:test`.

---

## File Structure

**Create:**
- `src/lib/outreachRules.ts` — pure `isOutreachEligible` + `buildOpenerInstruction`.
- `src/lib/outreachRules.test.ts` — unit tests.
- `src/services/outreach.ts` — `startOutreach` orchestrator (background, throttled).

**Modify:**
- `src/services/ai.ts` — export the `Contact` interface; add exported `generateOpener(contact)`.
- `src/routes/directory.ts` — `POST /start-outreach`.
- `package.json` — add the new test file to `test`.
- `client/src/api.ts` — `startOutreachApi`.
- `client/src/components/DirectoryView.tsx` — "Start outreach" toolbar action + pipeline picker.

---

## Task 1: Outreach rules (pure, TDD)

**Files:**
- Create: `src/lib/outreachRules.ts`
- Test: `src/lib/outreachRules.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test** — `src/lib/outreachRules.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { isOutreachEligible, buildOpenerInstruction } from './outreachRules';

test('isOutreachEligible: DNC is not eligible', () => {
  assert.deepEqual(isOutreachEligible({ isDnc: true, phone: '+18065551234', hasConversation: false }), { ok: false, reason: 'dnc' });
});

test('isOutreachEligible: missing phone is not eligible', () => {
  assert.equal(isOutreachEligible({ isDnc: false, phone: null, hasConversation: false }).reason, 'no_phone');
  assert.equal(isOutreachEligible({ isDnc: false, phone: '   ', hasConversation: false }).reason, 'no_phone');
});

test('isOutreachEligible: already in a conversation is not eligible', () => {
  assert.equal(isOutreachEligible({ isDnc: false, phone: '+18065551234', hasConversation: true }).reason, 'already_in_conversation');
});

test('isOutreachEligible: clean contact is eligible', () => {
  assert.deepEqual(isOutreachEligible({ isDnc: false, phone: '+18065551234', hasConversation: false }), { ok: true });
});

test('buildOpenerInstruction frames a first touch and requires opt-out', () => {
  const s = buildOpenerInstruction();
  assert.match(s, /FIRST/);
  assert.match(s, /STOP/);
});
```

- [ ] **Step 2: Add the test file to `package.json` `test`** — append ` src/lib/outreachRules.test.ts` before the closing quote of the `test` script (it currently ends with `src/lib/goals.test.ts"`):

```json
    "test": "node --require ts-node/register/transpile-only --test src/lib/csv.test.ts src/lib/normalize.test.ts src/lib/categorize.test.ts src/lib/filterSpec.test.ts src/lib/pipelineRouting.test.ts src/lib/goals.test.ts src/lib/outreachRules.test.ts",
```

- [ ] **Step 3: Run the test to verify it FAILS**

Run: `npm test`
Expected: FAIL — `Cannot find module './outreachRules'`.

- [ ] **Step 4: Implement `src/lib/outreachRules.ts`:**

```typescript
// Pure rules for outbound first-touch. No IO — unit-testable.
export interface OutreachEligibility {
  ok: boolean;
  reason?: 'dnc' | 'no_phone' | 'already_in_conversation';
}

export function isOutreachEligible(input: {
  isDnc: boolean;
  phone: string | null | undefined;
  hasConversation: boolean;
}): OutreachEligibility {
  if (input.isDnc) return { ok: false, reason: 'dnc' };
  if (!input.phone || !input.phone.trim()) return { ok: false, reason: 'no_phone' };
  if (input.hasConversation) return { ok: false, reason: 'already_in_conversation' };
  return { ok: true };
}

export function buildOpenerInstruction(): string {
  return [
    'Write the FIRST outreach text message to this person — you are reaching out to them; they have not messaged you.',
    'Keep it short (1-2 sentences), natural and human, and open toward your goal without being salesy or pushy.',
    'End with a brief, casual opt-out (e.g. "reply STOP to opt out").',
    'Output ONLY the SMS text — no tags, no preamble, no quotes.',
  ].join(' ');
}
```

- [ ] **Step 5: Run the test to verify it PASSES**

Run: `npm test`
Expected: PASS — all suites green including the 5 new outreachRules tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/outreachRules.ts src/lib/outreachRules.test.ts package.json
git commit -m "feat: outreach eligibility + opener-instruction rules

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `generateOpener` in `services/ai.ts`

**Files:**
- Modify: `src/services/ai.ts`

- [ ] **Step 1: Export the `Contact` interface**

In `src/services/ai.ts`, change the `Contact` interface declaration from `interface Contact {` to:

```typescript
export interface Contact {
```

(Its fields already include the goal fields added in milestone 2a.)

- [ ] **Step 2: Import the opener instruction**

At the top of `src/services/ai.ts`, add:

```typescript
import { buildOpenerInstruction } from '../lib/outreachRules';
```

- [ ] **Step 3: Add `generateOpener`**

Add this exported function near the end of `src/services/ai.ts` (after `handleInboundSMS`, before or after the `export const aiService = ...` line). It reuses the module-scoped `anthropic` client, the goal-aware `buildSystemPrompt(contact)`, and `parseAIResponse` to strip any stray tags:

```typescript
// Generate Vince's FIRST outreach text for a contact (goal-aware, opt-out included).
export async function generateOpener(contact: Contact): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    system: buildSystemPrompt(contact),
    messages: [{ role: 'user', content: buildOpenerInstruction() }],
  });
  const raw = response.content[0].type === 'text' ? response.content[0].text : '';
  return parseAIResponse(raw).text;
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai.ts
git commit -m "feat: generateOpener — Vince's goal-aware first outreach text

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Outreach orchestrator `services/outreach.ts`

**Files:**
- Create: `src/services/outreach.ts`

- [ ] **Step 1: Create the service**

```typescript
import twilio from 'twilio';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { broadcast } from '../websocket/server';
import { goalsForPipeline } from '../lib/goals';
import { contactTypeForPipeline, firstStageName } from '../lib/pipelineRouting';
import { isOutreachEligible } from '../lib/outreachRules';
import { generateOpener, Contact } from './ai';

const CAP = 25;
const DELAY_MS = 1500;
const VALID = new Set(['agent_outreach', 'seller_inbound']);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DirRow {
  id: string;
  phone: string | null;
  full_name: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
}

function pipelineNumber(pipeline: string): string | undefined {
  return pipeline === 'agent_outreach'
    ? process.env.TWILIO_OUTREACH_NUMBER
    : process.env.TWILIO_SELLER_NUMBER;
}

// Send the first outreach text to one directory contact.
async function sendOne(d: DirRow, pipeline: string): Promise<void> {
  if (!d.phone) return;
  const goals = goalsForPipeline(pipeline);
  const contactType = contactTypeForPipeline(pipeline);
  const stageName = firstStageName(pipeline);

  // Upsert the pipeline contact (with goals + first stage), keyed by phone.
  await pool.query(
    `INSERT INTO contacts (id, phone, name, email, address, city, state, contact_type, source, pipeline, stage_id, immediate_goal, long_term_goal, goal_owner)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'outreach',$9,(SELECT id FROM pipeline_stages WHERE name=$10),$11,$12,$13)
     ON CONFLICT (phone) DO NOTHING`,
    [uuidv4(), d.phone, d.full_name, d.email, d.address, d.city, d.state, contactType, pipeline, stageName, goals.immediateGoal, goals.longTermGoal, goals.owner]
  );

  const c = (await pool.query<Contact>(
    `SELECT id, phone, name, pipeline, stage_id, human_takeover, ai_active, is_dnc, metadata,
            immediate_goal, long_term_goal, goal_owner, goal_status
     FROM contacts WHERE phone = $1`,
    [d.phone]
  )).rows[0];
  if (!c) return;

  const convCount = await pool.query(`SELECT 1 FROM conversations WHERE contact_id = $1`, [c.id]);
  const elig = isOutreachEligible({ isDnc: c.is_dnc, phone: c.phone, hasConversation: (convCount.rowCount ?? 0) > 0 });
  if (!elig.ok) { console.log(`[OUTREACH] skip ${c.phone}: ${elig.reason}`); return; }

  const opener = await generateOpener(c);
  if (!opener) { console.log(`[OUTREACH] empty opener for ${c.phone}`); return; }

  const from = pipelineNumber(pipeline);
  if (!from) throw new Error('no from number for pipeline');
  const client = twilio(
    process.env.TWILIO_API_KEY!,
    process.env.TWILIO_API_SECRET!,
    { accountSid: process.env.TWILIO_ACCOUNT_SID! }
  );
  const sent = await client.messages.create({
    to: c.phone,
    from,
    body: opener,
    statusCallback: `${process.env.WEBHOOK_BASE_URL}/webhooks/sms/status`,
  });

  const conv = (await pool.query<{ id: string }>(
    `INSERT INTO conversations (id, contact_id, twilio_number, last_message_at, status)
     VALUES ($1,$2,$3,NOW(),'active')
     ON CONFLICT (contact_id) DO UPDATE SET last_message_at = NOW(), twilio_number = EXCLUDED.twilio_number
     RETURNING id`,
    [uuidv4(), c.id, from]
  )).rows[0];

  await pool.query(
    `INSERT INTO messages (id, conversation_id, contact_id, twilio_sid, direction, body, from_number, to_number, sender, status)
     VALUES ($1,$2,$3,$4,'outbound',$5,$6,$7,'ai','sent')`,
    [uuidv4(), conv.id, c.id, sent.sid, opener, from, c.phone]
  );
  await pool.query(`UPDATE directory_contacts SET promoted_to_pipeline = TRUE WHERE id = $1`, [d.id]);

  broadcast('sms:outbound', {
    contactId: c.id, conversationId: conv.id, body: opener,
    from, to: c.phone, sender: 'ai', ts: new Date().toISOString(),
  });
}

// Manual first-touch to a set of directory contacts. Returns the count that will be attempted;
// processes sends in the background, throttled, capped per run.
export async function startOutreach(params: { ids: string[]; pipeline: string }): Promise<{ queued: number }> {
  const { ids, pipeline } = params;
  if (!VALID.has(pipeline)) throw new Error('invalid pipeline');

  const dir = (await pool.query<DirRow>(
    `SELECT id, phone, full_name, email, address, city, state FROM directory_contacts WHERE id = ANY($1)`,
    [ids]
  )).rows;

  const batch = dir.slice(0, CAP);
  if (dir.length > batch.length) {
    console.log(`[OUTREACH] capping at ${CAP}/run; ${dir.length - batch.length} not attempted this run`);
  }

  setImmediate(async () => {
    for (const d of batch) {
      try {
        await sendOne(d, pipeline);
      } catch (e) {
        console.error('[OUTREACH] failed for', d.phone, (e as Error).message);
      }
      await wait(DELAY_MS);
    }
    console.log('[OUTREACH] run complete');
  });

  return { queued: batch.length };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/outreach.ts
git commit -m "feat: outreach orchestrator — upsert, eligibility, opener, send (background, throttled)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `POST /api/directory/start-outreach`

**Files:**
- Modify: `src/routes/directory.ts`

- [ ] **Step 1: Import the service** — at the top of `src/routes/directory.ts`, add:

```typescript
import { startOutreach } from '../services/outreach';
```

- [ ] **Step 2: Add the route** — add this just after the existing `POST /promote` route:

```typescript
// POST /api/directory/start-outreach — Vince sends a first text to selected directory contacts
directoryRouter.post('/start-outreach', async (req, res) => {
  try {
    const { ids = [], pipeline } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' });
    if (pipeline !== 'agent_outreach' && pipeline !== 'seller_inbound') {
      return res.status(400).json({ error: 'pipeline must be agent_outreach or seller_inbound' });
    }
    const result = await startOutreach({ ids, pipeline });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/directory.ts
git commit -m "feat: start-outreach endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: API client `startOutreachApi`

**Files:**
- Modify: `client/src/api.ts`

- [ ] **Step 1: Add the function** — after `promoteDirectory` in `client/src/api.ts`:

```typescript
export async function startOutreachApi(ids: string[], pipeline: string): Promise<{ queued: number }> {
  const res = await api.post('/directory/start-outreach', { ids, pipeline })
  return res.data
}
```

- [ ] **Step 2: Type-check the client**

Run: `cd client && rm -f node_modules/.tmp/*.tsbuildinfo && npx tsc -p tsconfig.app.json --noEmit; cd ..`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/api.ts
git commit -m "feat: startOutreachApi client

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: "Start outreach" in the Contacts CRM toolbar

**Files:**
- Modify: `client/src/components/DirectoryView.tsx`

- [ ] **Step 1: Import the API**

In `client/src/components/DirectoryView.tsx`, add `startOutreachApi` to the existing import from `../api`:

```typescript
import { fetchDirectory, bulkLabelDirectory, fetchLabels, startOutreachApi } from '../api'
```

- [ ] **Step 2: Add outreach state + handler**

With the other `useState` hooks in `DirectoryView`, add:

```typescript
  const [outreachOpen, setOutreachOpen] = useState(false)
```

And add this handler alongside the others (e.g. after `applyBulkLabel`):

```typescript
  async function startOutreach(pipeline: 'agent_outreach' | 'seller_inbound') {
    const ids = Array.from(checked)
    if (!ids.length) return
    const r = await startOutreachApi(ids, pipeline)
    alert(`Outreach queued for ${r.queued} contact(s).`)
    setOutreachOpen(false)
    setChecked(new Set()); load(); bumpCounts()
  }
```

- [ ] **Step 3: Add the toolbar control**

In the bulk-action toolbar (the `checked.size > 0` block), add — right before the `Export CSV` button — this Start-outreach control:

```tsx
            {!outreachOpen ? (
              <button onClick={() => setOutreachOpen(true)} className="text-slate-200 hover:text-white">Start outreach</button>
            ) : (
              <span className="flex items-center gap-2">
                <span className="text-purple-200">Send first text via:</span>
                <button onClick={() => startOutreach('agent_outreach')}
                  className="px-2 py-0.5 rounded bg-blue-600/30 text-blue-200 text-xs hover:bg-blue-600/50">Agent</button>
                <button onClick={() => startOutreach('seller_inbound')}
                  className="px-2 py-0.5 rounded bg-amber-600/30 text-amber-200 text-xs hover:bg-amber-600/50">Seller</button>
                <button onClick={() => setOutreachOpen(false)} className="text-slate-400 hover:text-white text-xs">cancel</button>
              </span>
            )}
```

- [ ] **Step 4: Type-check the client**

Run: `cd client && rm -f node_modules/.tmp/*.tsbuildinfo && npx tsc -p tsconfig.app.json --noEmit; cd ..`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/DirectoryView.tsx
git commit -m "feat: Start outreach action + pipeline picker in Contacts CRM

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Deploy + live test (controller-run)

**Files:** none (deploy + live test). Run by the controller — touches production and needs a phone.

- [ ] **Step 1: Build the client**

Run: `cd client && npm run build && cd ..`
Expected: builds clean.

- [ ] **Step 2: Merge + deploy**

```bash
git checkout master
git merge --no-ff feat/outbound-initiation -m "Merge: Outbound Initiation — Vince sends the first text"
git push origin master
```
Expected: Railway builds + deploys; `npm run migrate` is a no-op for schema (no new columns).

- [ ] **Step 3: Confirm deploy**

Run: `node -e "fetch('https://web-production-bcdba.up.railway.app/health').then(r=>r.json()).then(j=>console.log('health',j.status))"`
Expected: `health ok`.

- [ ] **Step 4: Live test (to your own phone — delivers regardless of A2P)**

1. In the live CRM Contacts tab, make sure there's a directory contact with **your** mobile number (add one via the manual-add form if needed), and that it is NOT DNC.
2. Select it → **Start outreach → Agent**.
3. Within ~15s you should receive a short, natural Vince opener ending with an opt-out. Reply to it → the existing inbound loop engages (goal-driven Vince).

- [ ] **Step 5: Verify in the data**

Run: `node -e "require('dotenv/config');const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});(async()=>{const c=await p.query(\"SELECT phone,pipeline,source,(SELECT name FROM pipeline_stages s WHERE s.id=contacts.stage_id) stage FROM contacts WHERE source='outreach' ORDER BY created_at DESC LIMIT 3\");console.log('outreach contacts:',c.rows);const m=await p.query(\"SELECT direction,sender,left(body,80) body,status FROM messages ORDER BY created_at DESC LIMIT 4\");console.log('recent messages:',m.rows);await p.end()})()"`
Expected: a pipeline contact with `source='outreach'`, the right pipeline + first stage; a recent outbound `ai` message containing the opener. Selecting a DNC contact would be skipped (no message).

---

## Self-Review Notes

- **Spec coverage:** opener generation (Task 2) + opener instruction (Task 1); eligibility filter (Task 1); orchestrator with upsert+goals, eligibility, throttle/cap, send, conversation/message, broadcast (Task 3); endpoint (Task 4); API client (Task 5); CRM toolbar + pipeline picker (Task 6); deploy + live test (Task 7). Compliance: opt-out in `buildOpenerInstruction`, DNC filtered in eligibility, throttle/cap in orchestrator; A2P noted as external prerequisite. Auto/scheduled + disposition correctly out of scope.
- **Type consistency:** `isOutreachEligible({isDnc, phone, hasConversation})` defined (Task 1) and called with those exact keys (Task 3); `generateOpener(contact: Contact)` (Task 2) consumes the exported `Contact` from ai.ts and is called in Task 3; `startOutreach({ids, pipeline})` (Task 3) matches the endpoint body (Task 4) and `startOutreachApi(ids, pipeline)` (Task 5) and the toolbar handler (Task 6); pipeline values `'agent_outreach'|'seller_inbound'` consistent throughout; the contact insert uses goal columns + `(SELECT id FROM pipeline_stages WHERE name=$10)` exactly as the milestone-1/2a inserts do.
- **No placeholders:** every code step is complete; every verify step has a command + expected output.
- **Note:** opener generation and the orchestrator are verified by tsc + the live test (consistent with the repo, which unit-tests pure `lib/` code and live-tests the Claude/Twilio/DB paths).
