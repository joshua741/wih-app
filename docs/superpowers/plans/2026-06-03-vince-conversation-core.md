# Vince Conversation Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Vince hold a live inbound SMS conversation — a text to a WIH Twilio number gets a Claude reply in the correct persona, lands in the correct pipeline/stage, and respects opt-out, human-takeover, and deal-routing.

**Architecture:** Fix the inbound webhook so the contact's pipeline is chosen by which Twilio number was texted (a pure, tested helper), seed the missing `Dead` stages, correct one status-callback URL, and add a one-shot script to point the Twilio numbers at the deployed app. No new tables; Vince's existing persona/tag/routing logic is reused as-is.

**Tech Stack:** TypeScript, Express 5, `pg` (Supabase), Twilio SDK, Anthropic SDK, `node:test`.

---

## File Structure

**Create:**
- `src/lib/pipelineRouting.ts` — pure helpers: number → pipeline, pipeline → contact_type, pipeline → first stage name.
- `src/lib/pipelineRouting.test.ts` — unit tests for the above.
- `src/scripts/set-twilio-webhooks.ts` — one-shot: point both Twilio numbers' inbound SMS webhook at the app.

**Modify:**
- `src/routes/sms.ts` — choose pipeline/stage/type from the `To` number on new-contact insert.
- `src/db/schema.sql` — seed `Dead (Agent)` and `Dead (Seller)` stages.
- `src/services/ai.ts` — look up the dead stage by pipeline + `Dead%` name pattern.
- `src/routes/api.ts` — fix the manual-reply status callback URL.
- `package.json` — add the routing test file to `test`; add a `set-webhooks` script.

---

## Task 1: Pipeline routing helper (pure, TDD)

**Files:**
- Create: `src/lib/pipelineRouting.ts`
- Test: `src/lib/pipelineRouting.test.ts`
- Modify: `package.json` (add the new test file to the `test` script)

- [ ] **Step 1: Write the failing test**

Create `src/lib/pipelineRouting.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { pipelineForNumber, contactTypeForPipeline, firstStageName } from './pipelineRouting';

test('pipelineForNumber: the outreach number maps to agent_outreach', () => {
  process.env.TWILIO_OUTREACH_NUMBER = '+18065551111';
  assert.equal(pipelineForNumber('+18065551111'), 'agent_outreach');
});

test('pipelineForNumber: any other or missing number maps to seller_inbound', () => {
  process.env.TWILIO_OUTREACH_NUMBER = '+18065551111';
  assert.equal(pipelineForNumber('+18065559999'), 'seller_inbound');
  assert.equal(pipelineForNumber(undefined), 'seller_inbound');
});

test('contactTypeForPipeline maps pipeline to contact_type', () => {
  assert.equal(contactTypeForPipeline('agent_outreach'), 'agent');
  assert.equal(contactTypeForPipeline('seller_inbound'), 'seller');
});

test('firstStageName maps pipeline to its first stage', () => {
  assert.equal(firstStageName('agent_outreach'), 'New Agent Lead');
  assert.equal(firstStageName('seller_inbound'), 'New Lead');
});
```

- [ ] **Step 2: Add the test file to the npm `test` script**

In `package.json`, the `test` script currently ends with `src/lib/filterSpec.test.ts"`. Add ` src/lib/pipelineRouting.test.ts` before the closing quote so it reads:

```json
    "test": "node --require ts-node/register/transpile-only --test src/lib/csv.test.ts src/lib/normalize.test.ts src/lib/categorize.test.ts src/lib/filterSpec.test.ts src/lib/pipelineRouting.test.ts",
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './pipelineRouting'` (the implementation doesn't exist yet).

- [ ] **Step 4: Implement `src/lib/pipelineRouting.ts`**

```typescript
// Which AI pipeline an inbound contact belongs to, based on the WIH number they texted.
// Pure + env-driven so it is unit-testable. Unknown numbers degrade to the seller pipeline.
export type InboundPipeline = 'agent_outreach' | 'seller_inbound';

export function pipelineForNumber(toNumber: string | undefined): InboundPipeline {
  const outreach = process.env.TWILIO_OUTREACH_NUMBER;
  return toNumber && outreach && toNumber === outreach ? 'agent_outreach' : 'seller_inbound';
}

export function contactTypeForPipeline(pipeline: string): 'agent' | 'seller' {
  return pipeline === 'agent_outreach' ? 'agent' : 'seller';
}

export function firstStageName(pipeline: string): string {
  return pipeline === 'agent_outreach' ? 'New Agent Lead' : 'New Lead';
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — all suites green including the new `pipelineRouting` tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipelineRouting.ts src/lib/pipelineRouting.test.ts package.json
git commit -m "feat: pipeline routing helper (number -> pipeline/type/stage)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Route inbound by Twilio number (`routes/sms.ts`)

**Files:**
- Modify: `src/routes/sms.ts`

- [ ] **Step 1: Add the import**

At the top of `src/routes/sms.ts`, with the other imports, add:

```typescript
import { pipelineForNumber, contactTypeForPipeline, firstStageName } from '../lib/pipelineRouting';
```

- [ ] **Step 2: Compute routing after destructuring the webhook body**

In the `smsRouter.post('/', ...)` handler, immediately after the `const { MessageSid, From, To, Body } = req.body as {...};` destructuring, add:

```typescript
    const pipeline = pipelineForNumber(To);
    const contactType = contactTypeForPipeline(pipeline);
    const stageName = firstStageName(pipeline);
```

- [ ] **Step 3: Replace the contact upsert to use the routing**

Replace the existing contact-upsert query (the `INSERT INTO contacts (id, phone, source, pipeline) VALUES ($1, $2, 'seller_inbound', 'seller_inbound') ...` block) with:

```typescript
    // 1. Upsert contact — pipeline/type/stage are chosen by which WIH number was texted.
    const contactResult = await pool.query<{ id: string; is_dnc: boolean; human_takeover: boolean; ai_active: boolean }>(
      `INSERT INTO contacts (id, phone, source, pipeline, contact_type, stage_id)
       VALUES ($1, $2, $3, $3, $4, (SELECT id FROM pipeline_stages WHERE name = $5))
       ON CONFLICT (phone) DO UPDATE SET updated_at = NOW()
       RETURNING id, is_dnc, human_takeover, ai_active`,
      [uuidv4(), From, pipeline, contactType, stageName]
    );
```

(Existing contacts keep their pipeline/stage because the `ON CONFLICT` clause only bumps `updated_at`.)

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/routes/sms.ts
git commit -m "fix: route inbound SMS to the correct pipeline by Twilio number

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Seed Dead stages + correct the dead-stage lookup

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/services/ai.ts`

- [ ] **Step 1: Seed the Dead stages**

In `src/db/schema.sql`, inside the `INSERT INTO pipeline_stages (name, pipeline, position, color) VALUES` seed block, add two rows. Put them right after the `seller_inbound` rows and before the `-- Active Deals pipeline` comment (they must be inside the VALUES list, so end the preceding line with a comma):

```sql
  -- Dead stages (used when Vince tags a lead [DEAD])
  ('Dead (Agent)',  'agent_outreach', 99, '#64748b'),
  ('Dead (Seller)', 'seller_inbound', 99, '#64748b'),
```

The seed ends with `ON CONFLICT (name) DO NOTHING`, so this is idempotent and re-applied by `npm run migrate` on every deploy.

- [ ] **Step 2: Fix the dead-stage lookup in `ai.ts`**

In `src/services/ai.ts`, inside `applyActions`, replace the dead-handling block (the `if (actions.dead) { const deadStageId = await getStageId('Dead', contact.pipeline); ... }`) with a pipeline-scoped pattern lookup:

```typescript
  // Mark contact dead
  if (actions.dead) {
    const deadRes = await pool.query<{ id: string }>(
      `SELECT id FROM pipeline_stages WHERE pipeline = $1 AND name LIKE 'Dead%' LIMIT 1`,
      [contact.pipeline]
    );
    const deadStageId = deadRes.rows[0]?.id ?? null;
    await pool.query(
      `UPDATE contacts SET ai_active = FALSE, stage_id = COALESCE($1, stage_id) WHERE id = $2`,
      [deadStageId, contact.id]
    );
    broadcast('contact:updated', { id: contact.id, ai_active: false });
  }
```

(`pool` is already imported in `ai.ts`.)

- [ ] **Step 3: Apply the seed to the database and verify**

Run: `npm run migrate`
Expected: `[MIGRATE] Running schema...` then `[MIGRATE] Done.` with no error.

Then verify both Dead stages exist:

Run: `node -e "require('dotenv/config');const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});p.query(\"SELECT name,pipeline FROM pipeline_stages WHERE name LIKE 'Dead%' ORDER BY pipeline\").then(r=>{console.log(r.rows);return p.end()})"`
Expected: two rows — `Dead (Agent)`/`agent_outreach` and `Dead (Seller)`/`seller_inbound`.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/services/ai.ts
git commit -m "feat: seed Dead stages and scope dead-stage lookup by pipeline

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Fix the manual-reply status callback URL (`routes/api.ts`)

**Files:**
- Modify: `src/routes/api.ts`

- [ ] **Step 1: Correct the URL**

In `src/routes/api.ts`, in the `POST /contacts/:id/messages` handler, the Twilio `messages.create` call sets `statusCallback: \`${process.env.WEBHOOK_BASE_URL}/sms/status\``. Change it to include the `/webhooks` segment so it matches the real route and the `ai.ts` convention:

```typescript
    statusCallback: `${process.env.WEBHOOK_BASE_URL}/webhooks/sms/status`,
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/routes/api.ts
git commit -m "fix: manual-reply SMS status callback URL missing /webhooks segment

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: One-shot Twilio webhook setter

**Files:**
- Create: `src/scripts/set-twilio-webhooks.ts`
- Modify: `package.json` (add `set-webhooks` script)

- [ ] **Step 1: Create the script**

Create `src/scripts/set-twilio-webhooks.ts`:

```typescript
import 'dotenv/config';
import twilio from 'twilio';

// One-shot: point both WIH numbers' inbound SMS webhook at the deployed app.
// SMS delivery-status callbacks are set per-message in the app, so we only set smsUrl here.
async function main() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const base = (process.env.WEBHOOK_BASE_URL || '').replace(/\/+$/, '');
  if (!sid || !token || !base) {
    console.error('Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or WEBHOOK_BASE_URL');
    process.exit(1);
  }
  const client = twilio(sid, token);
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
```

- [ ] **Step 2: Add npm scripts**

In `package.json` `scripts`, after the `import-contacts` line (add a trailing comma to it), add:

```json
    "set-webhooks": "ts-node src/scripts/set-twilio-webhooks.ts",
    "list-webhooks": "ts-node -e \"require('dotenv/config');const twilio=require('twilio');const c=twilio(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN);(async()=>{for(const p of [process.env.TWILIO_OUTREACH_NUMBER,process.env.TWILIO_SELLER_NUMBER]){const f=await c.incomingPhoneNumbers.list({phoneNumber:p,limit:1});console.log(p, f[0] ? f[0].smsUrl||'(none)' : 'NOT FOUND')}})()\""
```

- [ ] **Step 3: Type-check and read-only verify (do NOT set yet)**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `npm run list-webhooks`
Expected: prints both WIH numbers and their current `smsUrl` (likely `(none)` or a demo/placeholder URL). This is read-only — it confirms the Twilio creds work and shows the starting state. Do NOT run `set-webhooks` here; that happens in Task 6 after deploy, so the webhook points at live code.

- [ ] **Step 4: Commit**

```bash
git add src/scripts/set-twilio-webhooks.ts package.json
git commit -m "feat: one-shot script to point Twilio numbers at the app webhook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Deploy, wire Twilio, and live acceptance test (controller-run)

**Files:** none (deploy + external config + live test). Run by the controller, not a subagent — it deploys to production, mutates Twilio config, and needs a real phone.

- [ ] **Step 1: Merge to master and deploy**

```bash
git checkout master
git merge --no-ff feat/vince-conversation-core -m "Merge: Vince conversation core — live inbound SMS"
git push origin master
```
Expected: push succeeds; Railway auto-builds and runs `npm run migrate` (which seeds the Dead stages) then starts the server.

- [ ] **Step 2: Confirm the new build is live**

Run: `node -e "fetch('https://web-production-bcdba.up.railway.app/health').then(r=>r.json()).then(j=>console.log('health',j.status))"`
Expected: `health ok`. (Optionally re-run the Dead-stage query from Task 3 Step 3 to confirm the deploy migration seeded them in prod.)

- [ ] **Step 3: Point the Twilio numbers at the deployed app**

Run: `npm run set-webhooks`
Expected: for both numbers, `before` → `after: smsUrl=https://web-production-bcdba.up.railway.app/webhooks/sms`.

- [ ] **Step 4: Live acceptance test (from Josh's phone)**

1. Text the **seller** number (`TWILIO_SELLER_NUMBER`) something like "Hi, I might want to sell my house." → within ~10s Vince replies in the warm seller persona.
2. Text the **outreach** number (`TWILIO_OUTREACH_NUMBER`) something like "Hey, got any deals?" → Vince replies in the colleague/agent persona.
3. Reply `STOP` to one of them → exactly one final opt-out confirmation, then silence.

- [ ] **Step 5: Verify the data landed correctly**

Run: `node -e "require('dotenv/config');const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});(async()=>{const c=await p.query(\"SELECT phone,pipeline,contact_type,is_dnc,(SELECT name FROM pipeline_stages s WHERE s.id=contacts.stage_id) stage FROM contacts ORDER BY created_at DESC LIMIT 5\");console.log('contacts:',c.rows);const m=await p.query('SELECT count(*)::int n, direction FROM messages GROUP BY direction');console.log('messages:',m.rows);await p.end()})()"`
Expected: the test contact(s) present with the correct `pipeline`/`contact_type`/`stage`; the STOP'd contact `is_dnc = true`; both inbound and outbound message rows exist (proving Vince replied).

- [ ] **Step 6: Confirm on the live dashboard**

Open `https://web-production-bcdba.up.railway.app`, view the pipeline board, and confirm the test contact appears on the correct stage with its conversation.

---

## Self-Review Notes

- **Spec coverage:** inbound pipeline routing (Tasks 1–2), Dead stage seed + lookup (Task 3), webhook URL fix (Task 4), Twilio wiring script (Task 5) + live run (Task 6), live acceptance incl. persona-by-number and STOP (Task 6). Milestone-2 items (outbound, follow-up sequences, goal/owner, disposition) are intentionally untasked.
- **Type consistency:** `pipelineForNumber`/`contactTypeForPipeline`/`firstStageName` are defined in Task 1 and consumed in Task 2 with matching names/signatures; the contact insert uses `$3` for both `source` and `pipeline` (same value) and a subquery for `stage_id` keyed on `firstStageName`; the Dead seed names (`Dead (Agent)`/`Dead (Seller)`) match the `LIKE 'Dead%'` lookup in Task 3.
- **No placeholders:** every code step shows full code; every verify step has a command + expected output.
- **Note:** `set-webhooks` and the live test are deliberately deferred to Task 6 so the webhook only points at freshly deployed code.
```
