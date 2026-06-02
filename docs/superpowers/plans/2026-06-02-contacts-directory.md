# Contacts Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Contacts Directory in wih-app — the single master home for all ~16,360 contacts, stored in Supabase, fully isolated from the deal pipelines, with search, advanced any-field filtering, multi-select export, and one-way promote-to-pipeline.

**Architecture:** A new `directory_contacts` table (separate from the pipeline `contacts` table) holds normalized lookup columns plus a `data` JSONB vault of every original GHL field. A one-time idempotent importer loads the CSV (parse → normalize → dedup → categorize → flag junk → batch insert). A new `/api/directory` Express router serves list/detail/filter/export/promote. A new React "Directory" section (separate sidebar group) renders a paginated table with an advanced filter builder and bulk actions.

**Tech Stack:** TypeScript, Express 5, `pg`, React + Vite, Tailwind, Supabase Postgres 17. Tests: Node built-in test runner (`node --test`) via `ts-node/register` — no new dependencies.

---

## Assumptions (confirmed during brainstorming)

- Category vocabulary: `buyer, seller, rto_tenant, cash_buyer, pml, wholesaler, title_agent, insurance_agent, contractor, realtor, team, uncategorized`.
- Supabase ("WIH Acquisitions") starts **fresh** — no Railway data migration.
- CSV source: `C:\Users\joshu\Downloads\Export_Contacts_undefined_Jun_2026_12_47_PM.csv`.
- `.env` `DATABASE_URL` already points at Supabase (done).

## File Structure

**Backend (create):**
- `src/lib/csv.ts` — RFC-4180 CSV parser
- `src/lib/normalize.ts` — phone/email normalization
- `src/lib/categorize.ts` — tag cleaning, category inference, junk detection
- `src/lib/filterSpec.ts` — advanced-filter spec → parameterized SQL
- `src/db/importContacts.ts` — one-time importer CLI
- `src/routes/directory.ts` — `/api/directory` router
- Tests: `src/lib/csv.test.ts`, `src/lib/normalize.test.ts`, `src/lib/categorize.test.ts`, `src/lib/filterSpec.test.ts`

**Backend (modify):**
- `src/db/pool.ts` — SSL for remote hosts
- `src/db/schema.sql` — add `directory_contacts` + indexes + `pg_trgm`
- `src/server.ts` — mount `/api/directory`
- `package.json` — add `test` and `import-contacts` scripts

**Frontend (create):**
- `client/src/components/DirectoryView.tsx` — table + search + bulk bar
- `client/src/components/DirectoryDetailPanel.tsx` — detail + pipeline cross-ref
- `client/src/components/AdvancedFilterPanel.tsx` — filter builder

**Frontend (modify):**
- `client/src/types.ts` — directory types
- `client/src/api.ts` — directory API calls
- `client/src/components/Sidebar.tsx` — Directory nav group + view mode
- `client/src/App.tsx` — view-mode switch (pipeline vs directory)

---

# PHASE 1 — Foundation: schema, parsing, normalization, categorization, import

### Task 1: Enable SSL for remote DB hosts

**Files:**
- Modify: `src/db/pool.ts`

- [ ] **Step 1: Replace pool config**

Supabase requires SSL on every connection, including local dev and the importer. Switch from "SSL only in production" to "SSL for any non-localhost host".

```typescript
import { Pool } from 'pg';

const url = process.env.DATABASE_URL || '';
const isLocal = url.includes('localhost') || url.includes('127.0.0.1');

export const pool = new Pool({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});
```

- [ ] **Step 2: Verify it loads**

Run: `cd ~/wih-app && node --require ts-node/register -e "require('./src/db/pool').pool.query('select 1').then(r=>{console.log('OK',r.rows);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"`
Expected: `OK [ { '?column?': 1 } ]`

- [ ] **Step 3: Commit**

```bash
git add src/db/pool.ts
git commit -m "fix: enable SSL for remote (Supabase) DB connections"
```

---

### Task 2: Add `test` and `import-contacts` scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add scripts**

In the `"scripts"` block, add:

```json
    "test": "node --require ts-node/register --test src/lib/csv.test.ts src/lib/normalize.test.ts src/lib/categorize.test.ts src/lib/filterSpec.test.ts",
    "import-contacts": "ts-node src/db/importContacts.ts"
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "chore: add test and import-contacts npm scripts"
```

---

### Task 3: RFC-4180 CSV parser

**Files:**
- Create: `src/lib/csv.ts`
- Test: `src/lib/csv.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { parseCsv } from './csv';

test('parses simple rows', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a','b'],['1','2']]);
});

test('handles quoted commas and quoted newlines', () => {
  const rows = parseCsv('name,note\n"Doe, John","line1\nline2"\n');
  assert.deepEqual(rows, [['name','note'],['Doe, John','line1\nline2']]);
});

test('handles escaped double quotes', () => {
  assert.deepEqual(parseCsv('a\n"He said ""hi"""\n'), [['a'],['He said "hi"']]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `./csv`.

- [ ] **Step 3: Implement the parser**

```typescript
// Minimal RFC-4180 parser. Handles quoted fields, embedded commas/newlines,
// and escaped double-quotes ("").
export function parseCsv(s: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; } else { q = false; }
      } else { cur += c; }
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// Parse into array of objects keyed by header row.
export function parseCsvObjects(s: string): Record<string, string>[] {
  const rows = parseCsv(s);
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1)
    .filter(r => r.length > 1)
    .map(r => {
      const o: Record<string, string> = {};
      header.forEach((h, i) => { o[h] = r[i] ?? ''; });
      return o;
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: csv tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/csv.ts src/lib/csv.test.ts
git commit -m "feat: RFC-4180 CSV parser"
```

---

### Task 4: Phone/email normalization

**Files:**
- Create: `src/lib/normalize.ts`
- Test: `src/lib/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { normalizePhone, normalizeEmail } from './normalize';

test('normalizePhone keeps last 10 US digits', () => {
  assert.equal(normalizePhone('+1 (806) 781-8495'), '8067818495');
  assert.equal(normalizePhone('806-781-8495'), '8067818495');
  assert.equal(normalizePhone('18067818495'), '8067818495');
});

test('normalizePhone returns null for junk/empty', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('   '), null);
  assert.equal(normalizePhone('123'), null); // too short
});

test('normalizeEmail lowercases and trims, null when empty/invalid', () => {
  assert.equal(normalizeEmail('  Josh@Example.COM '), 'josh@example.com');
  assert.equal(normalizeEmail('notanemail'), null);
  assert.equal(normalizeEmail(''), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `./normalize`.

- [ ] **Step 3: Implement**

```typescript
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10) return null;
  // Keep the last 10 digits (drops leading US country code 1).
  return digits.slice(-10);
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  if (!e) return null;
  // Lightweight validity check — must look like x@y.z
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: normalize tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/normalize.ts src/lib/normalize.test.ts
git commit -m "feat: phone/email normalization helpers"
```

---

### Task 5: Tag cleaning, categorization, junk detection

**Files:**
- Create: `src/lib/categorize.ts`
- Test: `src/lib/categorize.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { cleanTags, categorize } from './categorize';

test('cleanTags splits, lowercases, trims, dedupes', () => {
  assert.deepEqual(cleanTags('Lubbock, rent to own buyer ,Lubbock'), ['lubbock', 'rent to own buyer']);
  assert.deepEqual(cleanTags(''), []);
});

test('categorize: tag wins first (rto)', () => {
  const r = categorize({}, ['rent to own buyer']);
  assert.equal(r.category, 'rto_tenant');
  assert.ok(r.categories.includes('rto_tenant'));
});

test('categorize: insurance tag variants map to insurance_agent', () => {
  assert.equal(categorize({}, ['insurance-agent']).category, 'insurance_agent');
  assert.equal(categorize({}, ['insurance agent']).category, 'insurance_agent');
});

test('categorize: field-cluster inference when no tag (title company)', () => {
  const r = categorize({ 'Name of Title Company': 'ABC Title' }, []);
  assert.equal(r.category, 'title_agent');
});

test('categorize: defaults to uncategorized', () => {
  assert.equal(categorize({}, []).category, 'uncategorized');
});

test('categorize: junk flag from landline tag', () => {
  assert.equal(categorize({}, ['landline']).isJunk, true);
});

test('categorize: junk when no name and no email', () => {
  assert.equal(categorize({ 'First Name': '', 'Last Name': '', 'Email': '' }, []).isJunk, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `./categorize`.

- [ ] **Step 3: Implement**

```typescript
export type Category =
  | 'buyer' | 'seller' | 'rto_tenant' | 'cash_buyer' | 'pml' | 'wholesaler'
  | 'title_agent' | 'insurance_agent' | 'contractor' | 'realtor' | 'team'
  | 'uncategorized';

export interface CategoryResult {
  category: Category;
  categories: Category[];
  isJunk: boolean;
}

export function cleanTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw.split(',')) {
    const v = t.trim().toLowerCase();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

// Exact-match tag → category.
const TAG_MAP: Record<string, Category> = {
  'rent to own buyer': 'rto_tenant',
  'under contract rent to own buyer': 'rto_tenant',
  'rto facebook ad lead': 'rto_tenant',
  'intro call rent to own': 'rto_tenant',
  'tenant client': 'rto_tenant',
  'tenant prospect': 'rto_tenant',
  'seller leads': 'seller',
  'seller': 'seller',
  'speed to lead seller new': 'seller',
  'seller finance buyer': 'buyer',
  'insurance agent': 'insurance_agent',
  'insurance-agent': 'insurance_agent',
  'pml': 'pml',
  'first time lender': 'pml',
  'active lender': 'pml',
  'under minimum pml': 'pml',
  'wholesaler': 'wholesaler',
  'investor': 'cash_buyer',
  'fix and flip': 'cash_buyer',
  'handymen': 'contractor',
  'plumber': 'contractor',
  'painter': 'contractor',
  'roofer': 'contractor',
  'home inspector': 'contractor',
  'garage door repair': 'contractor',
  'lubbock contractor': 'contractor',
  'amarillo contractor': 'contractor',
  'lubbock agent': 'realtor',
  'team': 'team',
};

const JUNK_TAGS = new Set([
  'landline', 'spam likely', 'dead number', 'couldn\'t find caller name',
  'name via lookup', 'ghost', 'dnd',
]);

// Field clusters: if any of these keys is non-empty → category.
const FIELD_CLUSTERS: { category: Category; fields: string[] }[] = [
  { category: 'rto_tenant', fields: ['Rent to Own Monthly Payment', 'Rent to Own Address', 'RTO Full Address'] },
  { category: 'title_agent', fields: ['Name of Title Company', 'Escrow Officer / Closing Attorney Name'] },
  { category: 'pml', fields: ['Lenders Name', 'PML Notes', 'Capital Amount'] },
  { category: 'insurance_agent', fields: ['Insurance Agents Name', 'Our Insurance Agent Name'] },
  { category: 'buyer', fields: ['Max Amount Per Month ($)', 'Credit Score Range', 'Program Interest'] },
  { category: 'seller', fields: ['How Soon Are You Looking To Sell?', 'Asking Price'] },
];

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' ? v.trim().length > 0 : v != null;
}

export function categorize(row: Record<string, string>, tags: string[]): CategoryResult {
  const cats: Category[] = [];
  const add = (c: Category) => { if (!cats.includes(c)) cats.push(c); };

  // 1. Tags first
  for (const t of tags) {
    const c = TAG_MAP[t];
    if (c) add(c);
  }
  // 2. Field clusters
  for (const cluster of FIELD_CLUSTERS) {
    if (cluster.fields.some(f => nonEmpty(row[f]))) add(cluster.category);
  }

  const category: Category = cats[0] ?? 'uncategorized';

  // Junk: any junk tag, OR no name and no email.
  const hasName = nonEmpty(row['First Name']) || nonEmpty(row['Last Name']);
  const hasEmail = nonEmpty(row['Email']);
  const isJunk = tags.some(t => JUNK_TAGS.has(t)) || (!hasName && !hasEmail);

  return { category, categories: cats.length ? cats : ['uncategorized'], isJunk };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: categorize tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/categorize.ts src/lib/categorize.test.ts
git commit -m "feat: tag cleaning, categorization, junk detection"
```

---

### Task 6: Add `directory_contacts` table to schema

**Files:**
- Modify: `src/db/schema.sql`

- [ ] **Step 1: Append the table + indexes**

Add at the end of `schema.sql` (after the existing content, before/after seeds is fine — it is independent):

```sql
-- ─── Contacts Directory (master rolodex, isolated from pipeline contacts) ───
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS directory_contacts (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ghl_contact_id       TEXT UNIQUE,
  first_name           TEXT,
  last_name            TEXT,
  full_name            TEXT,
  phone                TEXT,
  phone_normalized     TEXT,
  email                TEXT,
  email_lower          TEXT,
  business_name        TEXT,
  address              TEXT,
  city                 TEXT,
  state                TEXT,
  postal_code          TEXT,
  category             TEXT NOT NULL DEFAULT 'uncategorized',
  categories           TEXT[] NOT NULL DEFAULT '{}',
  tags                 TEXT[] NOT NULL DEFAULT '{}',
  is_junk              BOOLEAN NOT NULL DEFAULT FALSE,
  promoted_to_pipeline BOOLEAN NOT NULL DEFAULT FALSE,
  data                 JSONB NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dir_phone      ON directory_contacts(phone_normalized);
CREATE INDEX IF NOT EXISTS idx_dir_email      ON directory_contacts(email_lower);
CREATE INDEX IF NOT EXISTS idx_dir_category   ON directory_contacts(category);
CREATE INDEX IF NOT EXISTS idx_dir_name_trgm  ON directory_contacts USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_dir_tags       ON directory_contacts USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_dir_data       ON directory_contacts USING gin (data jsonb_path_ops);

CREATE OR REPLACE TRIGGER directory_contacts_updated_at
  BEFORE UPDATE ON directory_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

- [ ] **Step 2: Run migration against Supabase**

Run: `cd ~/wih-app && npm run migrate`
Expected: `[MIGRATE] Done.` with no errors.

- [ ] **Step 3: Verify table exists**

Run: `cd ~/wih-app && node --require ts-node/register -e "require('./src/db/pool').pool.query(\"select count(*) from directory_contacts\").then(r=>{console.log('rows',r.rows[0].count);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"`
Expected: `rows 0`

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.sql
git commit -m "feat: directory_contacts table + indexes"
```

---

### Task 7: The importer

**Files:**
- Create: `src/db/importContacts.ts`

- [ ] **Step 1: Implement the importer**

```typescript
import 'dotenv/config';
import fs from 'fs';
import { pool } from './pool';
import { parseCsvObjects } from '../lib/csv';
import { normalizePhone, normalizeEmail } from '../lib/normalize';
import { cleanTags, categorize } from '../lib/categorize';

const DEFAULT_CSV =
  'C:\\Users\\joshu\\Downloads\\Export_Contacts_undefined_Jun_2026_12_47_PM.csv';

interface DirRow {
  ghl_contact_id: string;
  first_name: string; last_name: string; full_name: string;
  phone: string; phone_normalized: string | null;
  email: string; email_lower: string | null;
  business_name: string; address: string; city: string; state: string; postal_code: string;
  category: string; categories: string[]; tags: string[]; is_junk: boolean;
  data: Record<string, string>;
  _fill: number;
}

function fillCount(row: Record<string, string>): number {
  let n = 0;
  for (const v of Object.values(row)) if (v && v.trim()) n++;
  return n;
}

function buildRow(raw: Record<string, string>): DirRow {
  const tags = cleanTags(raw['Tags']);
  const { category, categories, isJunk } = categorize(raw, tags);
  const first = (raw['First Name'] || '').trim();
  const last = (raw['Last Name'] || '').trim();
  return {
    ghl_contact_id: (raw['Contact Id'] || '').trim(),
    first_name: first, last_name: last,
    full_name: `${first} ${last}`.trim(),
    phone: (raw['Phone'] || '').trim(),
    phone_normalized: normalizePhone(raw['Phone']),
    email: (raw['Email'] || '').trim(),
    email_lower: normalizeEmail(raw['Email']),
    business_name: (raw['Business Name'] || '').trim(),
    address: (raw['Street Address'] || '').trim(),
    city: (raw['City'] || '').trim(),
    state: (raw['State'] || '').trim(),
    postal_code: (raw['Postal Code'] || '').trim(),
    category, categories, tags, is_junk: isJunk,
    data: raw,
    _fill: fillCount(raw),
  };
}

// Dedupe by phone_normalized OR email_lower; keep richest; merge tags.
function dedupe(rows: DirRow[]): DirRow[] {
  const byKey = new Map<string, DirRow>();
  const result: DirRow[] = [];
  for (const r of rows) {
    const keys = [
      r.phone_normalized ? 'p:' + r.phone_normalized : '',
      r.email_lower ? 'e:' + r.email_lower : '',
    ].filter(Boolean);
    if (keys.length === 0) { result.push(r); continue; }
    const existing = keys.map(k => byKey.get(k)).find(Boolean);
    if (!existing) {
      result.push(r);
      keys.forEach(k => byKey.set(k, r));
    } else {
      // merge tags into the richer record
      const richer = r._fill > existing._fill ? r : existing;
      const poorer = richer === r ? existing : r;
      const merged = Array.from(new Set([...richer.tags, ...poorer.tags]));
      richer.tags = merged;
      if (richer === r) {
        // replace existing in result + map
        const idx = result.indexOf(existing);
        if (idx >= 0) result[idx] = r;
        keys.forEach(k => byKey.set(k, r));
      }
    }
  }
  return result;
}

async function main() {
  const path = process.argv[2] || process.env.CONTACTS_CSV || DEFAULT_CSV;
  console.log('[IMPORT] Reading', path);
  const text = fs.readFileSync(path, 'utf-8');
  const raw = parseCsvObjects(text);
  console.log('[IMPORT] Parsed rows:', raw.length);

  const built = raw.map(buildRow);
  const deduped = dedupe(built);
  console.log('[IMPORT] After dedupe:', deduped.length);

  let inserted = 0;
  const BATCH = 500;
  for (let i = 0; i < deduped.length; i += BATCH) {
    const batch = deduped.slice(i, i + BATCH);
    const values: unknown[] = [];
    const tuples: string[] = [];
    batch.forEach((r, j) => {
      const b = j * 18;
      tuples.push(
        `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},` +
        `$${b+10},$${b+11},$${b+12},$${b+13},$${b+14},$${b+15},$${b+16},$${b+17},$${b+18})`
      );
      values.push(
        r.ghl_contact_id || null, r.first_name, r.last_name, r.full_name,
        r.phone, r.phone_normalized, r.email, r.email_lower, r.business_name,
        r.address, r.city, r.state, r.postal_code, r.category,
        r.categories, r.tags, r.is_junk, JSON.stringify(r.data)
      );
    });
    const sql =
      `INSERT INTO directory_contacts
       (ghl_contact_id, first_name, last_name, full_name, phone, phone_normalized,
        email, email_lower, business_name, address, city, state, postal_code,
        category, categories, tags, is_junk, data)
       VALUES ${tuples.join(',')}
       ON CONFLICT (ghl_contact_id) DO UPDATE SET
         first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
         full_name=EXCLUDED.full_name, phone=EXCLUDED.phone,
         phone_normalized=EXCLUDED.phone_normalized, email=EXCLUDED.email,
         email_lower=EXCLUDED.email_lower, business_name=EXCLUDED.business_name,
         address=EXCLUDED.address, city=EXCLUDED.city, state=EXCLUDED.state,
         postal_code=EXCLUDED.postal_code, category=EXCLUDED.category,
         categories=EXCLUDED.categories, tags=EXCLUDED.tags,
         is_junk=EXCLUDED.is_junk, data=EXCLUDED.data, updated_at=NOW()`;
    await pool.query(sql, values);
    inserted += batch.length;
    console.log(`[IMPORT] ${inserted}/${deduped.length}`);
  }

  const counts = await pool.query(
    `SELECT category, count(*) FROM directory_contacts GROUP BY category ORDER BY 2 DESC`
  );
  const junk = await pool.query(`SELECT count(*) FROM directory_contacts WHERE is_junk`);
  console.log('[IMPORT] Category breakdown:');
  counts.rows.forEach(r => console.log(`  ${r.category}: ${r.count}`));
  console.log('[IMPORT] Junk flagged:', junk.rows[0].count);
  await pool.end();
}

main().catch(err => { console.error('[IMPORT] Failed:', err); process.exit(1); });
```

- [ ] **Step 2: Run the import against Supabase**

Run: `cd ~/wih-app && npm run import-contacts`
Expected: progress logs ending with a category breakdown and junk count; total deduped < 16,360.

- [ ] **Step 3: Verify idempotency (re-run does not duplicate)**

Run: `cd ~/wih-app && npm run import-contacts`
Then: `node --require ts-node/register -e "require('./src/db/pool').pool.query('select count(*) from directory_contacts').then(r=>{console.log(r.rows[0].count);process.exit(0)})"`
Expected: same count as first run (no growth).

- [ ] **Step 4: Commit**

```bash
git add src/db/importContacts.ts
git commit -m "feat: GHL contacts importer (parse, dedupe, categorize, load)"
```

---

# PHASE 2 — Read API + Directory view + search + detail + cross-reference

### Task 8: Advanced-filter spec → SQL (pure logic, tested)

**Files:**
- Create: `src/lib/filterSpec.ts`
- Test: `src/lib/filterSpec.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { buildFilterSql } from './filterSpec';

test('empty spec → always-true clause, no params', () => {
  const { clause, params } = buildFilterSql({ combinator: 'AND', conditions: [] }, 1);
  assert.equal(clause, 'TRUE');
  assert.deepEqual(params, []);
});

test('core column "is" uses column directly + param', () => {
  const r = buildFilterSql({ combinator: 'AND', conditions: [
    { field: 'category', operator: 'is', value: 'seller' },
  ]}, 1);
  assert.match(r.clause, /category = \$1/);
  assert.deepEqual(r.params, ['seller']);
});

test('JSONB field "contains" uses data->> + ILIKE', () => {
  const r = buildFilterSql({ combinator: 'AND', conditions: [
    { field: 'City', operator: 'contains', value: 'lub' },
  ]}, 1);
  assert.match(r.clause, /data->>'City' ILIKE \$1/);
  assert.deepEqual(r.params, ['%lub%']);
});

test('OR combinator and is_empty (no param)', () => {
  const r = buildFilterSql({ combinator: 'OR', conditions: [
    { field: 'email_lower', operator: 'not_empty' },
    { field: 'phone_normalized', operator: 'not_empty' },
  ]}, 1);
  assert.match(r.clause, / OR /);
  assert.deepEqual(r.params, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `./filterSpec`.

- [ ] **Step 3: Implement**

```typescript
export type FilterOperator =
  | 'is' | 'is_not' | 'contains' | 'empty' | 'not_empty' | 'gt' | 'lt' | 'between';

export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value?: string;
  value2?: string; // for 'between'
}

export interface FilterSpec {
  combinator: 'AND' | 'OR';
  conditions: FilterCondition[];
}

// Core columns map to real columns; everything else hits the JSONB `data`.
const CORE_COLUMNS = new Set([
  'first_name', 'last_name', 'full_name', 'phone', 'phone_normalized',
  'email', 'email_lower', 'business_name', 'address', 'city', 'state',
  'postal_code', 'category', 'is_junk', 'promoted_to_pipeline',
]);

function ref(field: string): string {
  if (CORE_COLUMNS.has(field)) return field;
  // JSONB field — quote the key safely (escape single quotes).
  return `data->>'${field.replace(/'/g, "''")}'`;
}

// Returns a parameterized clause. `start` is the next $N index to use.
export function buildFilterSql(spec: FilterSpec, start: number): { clause: string; params: unknown[] } {
  if (!spec || !spec.conditions || spec.conditions.length === 0) {
    return { clause: 'TRUE', params: [] };
  }
  const params: unknown[] = [];
  let n = start;
  const parts: string[] = [];

  for (const c of spec.conditions) {
    const col = ref(c.field);
    switch (c.operator) {
      case 'is':       parts.push(`${col} = $${n++}`); params.push(c.value); break;
      case 'is_not':   parts.push(`${col} <> $${n++}`); params.push(c.value); break;
      case 'contains': parts.push(`${col} ILIKE $${n++}`); params.push(`%${c.value ?? ''}%`); break;
      case 'empty':    parts.push(`(${col} IS NULL OR ${col} = '')`); break;
      case 'not_empty':parts.push(`(${col} IS NOT NULL AND ${col} <> '')`); break;
      case 'gt':       parts.push(`NULLIF(${col},'')::numeric > $${n++}`); params.push(c.value); break;
      case 'lt':       parts.push(`NULLIF(${col},'')::numeric < $${n++}`); params.push(c.value); break;
      case 'between':
        parts.push(`NULLIF(${col},'')::numeric BETWEEN $${n++} AND $${n++}`);
        params.push(c.value, c.value2);
        break;
      default: parts.push('TRUE');
    }
  }
  const joiner = spec.combinator === 'OR' ? ' OR ' : ' AND ';
  return { clause: `(${parts.join(joiner)})`, params };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: filterSpec tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/filterSpec.ts src/lib/filterSpec.test.ts
git commit -m "feat: advanced-filter spec to parameterized SQL"
```

---

### Task 9: Directory API router

**Files:**
- Create: `src/routes/directory.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Implement the router**

```typescript
import { Router } from 'express';
import { pool } from '../db/pool';
import { normalizePhone } from '../lib/normalize';
import { buildFilterSql, FilterSpec } from '../lib/filterSpec';

export const directoryRouter = Router();

// GET /api/directory/contacts — paginated list with search + filters
directoryRouter.get('/contacts', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.pageSize || '50'), 10)));
    const search = String(req.query.search || '').trim();
    const category = String(req.query.category || '').trim();
    const includeJunk = String(req.query.include_junk || '') === 'true';

    const where: string[] = [];
    const params: unknown[] = [];
    let n = 1;

    if (!includeJunk) where.push('is_junk = FALSE');
    if (category) { where.push(`category = $${n++}`); params.push(category); }
    if (search) {
      const digits = normalizePhone(search);
      where.push(
        `(full_name ILIKE $${n} OR email_lower ILIKE $${n}` +
        (digits ? ` OR phone_normalized = $${n + 1}` : '') + `)`
      );
      params.push(`%${search}%`);
      if (digits) { n++; params.push(digits); }
      n++;
    }
    if (req.query.filters) {
      const spec = JSON.parse(String(req.query.filters)) as FilterSpec;
      const f = buildFilterSql(spec, n);
      if (f.clause !== 'TRUE') { where.push(f.clause); params.push(...f.params); n += f.params.length; }
    }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const countRes = await pool.query(`SELECT count(*) FROM directory_contacts ${whereSql}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    const listRes = await pool.query(
      `SELECT id, ghl_contact_id, full_name, phone, email, business_name, city, state,
              category, categories, tags, is_junk, promoted_to_pipeline
       FROM directory_contacts ${whereSql}
       ORDER BY full_name NULLS LAST
       LIMIT $${n++} OFFSET $${n++}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    res.json({ contacts: listRes.rows, total, page, pageSize });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// GET /api/directory/contacts/:id — detail + pipeline cross-reference
directoryRouter.get('/contacts/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM directory_contacts WHERE id = $1', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const c = r.rows[0];
    // Cross-reference against the pipeline contacts table by normalized phone/email.
    const xref = await pool.query(
      `SELECT c.id, c.name, c.pipeline, s.name AS stage_name
       FROM contacts c
       LEFT JOIN pipeline_stages s ON s.id = c.stage_id
       WHERE ($1::text IS NOT NULL AND right(regexp_replace(c.phone,'\\D','','g'),10) = $1)
          OR ($2::text IS NOT NULL AND lower(c.email) = $2)`,
      [c.phone_normalized, c.email_lower]
    );
    res.json({ ...c, pipeline_matches: xref.rows });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// POST /api/directory/contacts — manual add
directoryRouter.post('/contacts', async (req, res) => {
  try {
    const { first_name = '', last_name = '', phone = '', email = '', business_name = '',
            address = '', city = '', state = '', postal_code = '', category = 'uncategorized',
            tags = [] } = req.body || {};
    const r = await pool.query(
      `INSERT INTO directory_contacts
       (first_name, last_name, full_name, phone, phone_normalized, email, email_lower,
        business_name, address, city, state, postal_code, category, categories, tags, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'{}')
       RETURNING *`,
      [first_name, last_name, `${first_name} ${last_name}`.trim(), phone, normalizePhone(phone),
       email, email ? email.toLowerCase() : null, business_name, address, city, state, postal_code,
       category, [category], tags]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// PATCH /api/directory/contacts/:id — edit category/tags/basic fields
directoryRouter.patch('/contacts/:id', async (req, res) => {
  try {
    const allowed = ['first_name','last_name','full_name','phone','email','business_name',
                     'address','city','state','postal_code','category','categories','tags'];
    const sets: string[] = [];
    const params: unknown[] = [];
    let n = 1;
    for (const k of allowed) {
      if (k in (req.body || {})) { sets.push(`${k} = $${n++}`); params.push(req.body[k]); }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields' });
    params.push(req.params.id);
    const r = await pool.query(
      `UPDATE directory_contacts SET ${sets.join(', ')} WHERE id = $${n} RETURNING *`, params
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// GET /api/directory/fields — filterable field list for the filter builder
directoryRouter.get('/fields', async (_req, res) => {
  try {
    const core = ['full_name','first_name','last_name','phone','email','business_name',
                  'address','city','state','postal_code','category','is_junk','promoted_to_pipeline'];
    // Sample JSONB keys actually present in the data.
    const r = await pool.query(
      `SELECT DISTINCT jsonb_object_keys(data) AS k
       FROM directory_contacts
       WHERE data <> '{}'::jsonb
       LIMIT 1000`
    );
    const jsonbKeys = r.rows.map(x => x.k).sort();
    res.json({ core, jsonb: jsonbKeys });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// POST /api/directory/bulk-tag — set category/add tags on a set of ids
directoryRouter.post('/bulk-tag', async (req, res) => {
  try {
    const { ids = [], category, addTags = [] } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' });
    if (category) {
      await pool.query('UPDATE directory_contacts SET category = $1 WHERE id = ANY($2)', [category, ids]);
    }
    if (addTags.length) {
      await pool.query(
        `UPDATE directory_contacts
         SET tags = (SELECT array_agg(DISTINCT t) FROM unnest(tags || $1::text[]) t)
         WHERE id = ANY($2)`,
        [addTags, ids]
      );
    }
    res.json({ updated: ids.length });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
```

- [ ] **Step 2: Mount the router in `server.ts`**

Add the import near the other route imports (after line 8):

```typescript
import { directoryRouter } from './routes/directory';
```

Add the mount after `app.use('/api', apiRouter);` (line 22):

```typescript
app.use('/api/directory', directoryRouter);
```

- [ ] **Step 3: Start the server and verify list + detail**

Run (in one terminal): `cd ~/wih-app && npm run dev`
Then in another:
`curl "http://localhost:3001/api/directory/contacts?pageSize=2"`
Expected: JSON `{ contacts:[...2...], total:<number>, page:1, pageSize:2 }`.
`curl "http://localhost:3001/api/directory/fields"`
Expected: JSON with `core` array and a large `jsonb` array of field names.

- [ ] **Step 4: Verify search + filter**

Run: `curl "http://localhost:3001/api/directory/contacts?search=lubbock&pageSize=2"`
Expected: results matching name/email/phone.
Run: `curl "http://localhost:3001/api/directory/contacts?filters=%7B%22combinator%22%3A%22AND%22%2C%22conditions%22%3A%5B%7B%22field%22%3A%22category%22%2C%22operator%22%3A%22is%22%2C%22value%22%3A%22seller%22%7D%5D%7D&pageSize=2"`
(That is the URL-encoded `{"combinator":"AND","conditions":[{"field":"category","operator":"is","value":"seller"}]}`.)
Expected: only `category: "seller"` rows.

- [ ] **Step 5: Commit**

```bash
git add src/routes/directory.ts src/server.ts
git commit -m "feat: /api/directory read+filter+cross-reference+bulk-tag API"
```

---

### Task 10: Promote + export endpoints

**Files:**
- Modify: `src/routes/directory.ts`

- [ ] **Step 1: Add export + promote handlers (append to the router)**

```typescript
// POST /api/directory/export — CSV of selected ids OR current filter
directoryRouter.post('/export', async (req, res) => {
  try {
    const { ids } = req.body || {};
    let rows;
    if (Array.isArray(ids) && ids.length) {
      rows = (await pool.query(
        `SELECT full_name, phone, email, business_name, city, state, category,
                array_to_string(tags,';') AS tags
         FROM directory_contacts WHERE id = ANY($1) ORDER BY full_name`, [ids]
      )).rows;
    } else {
      rows = (await pool.query(
        `SELECT full_name, phone, email, business_name, city, state, category,
                array_to_string(tags,';') AS tags
         FROM directory_contacts WHERE is_junk = FALSE ORDER BY full_name LIMIT 5000`
      )).rows;
    }
    const cols = ['full_name','phone','email','business_name','city','state','category','tags'];
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(',')]
      .concat(rows.map(r => cols.map(c => esc((r as Record<string, unknown>)[c])).join(',')))
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="directory-export.csv"');
    res.send(csv);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// POST /api/directory/promote — push selected into a pipeline
directoryRouter.post('/promote', async (req, res) => {
  try {
    const { ids = [], pipeline, stageId, contactType = 'seller' } = req.body || {};
    if (!Array.isArray(ids) || !ids.length || !pipeline) {
      return res.status(400).json({ error: 'ids and pipeline required' });
    }
    const dir = (await pool.query(
      `SELECT * FROM directory_contacts WHERE id = ANY($1)`, [ids]
    )).rows;
    let promoted = 0, skipped = 0;
    for (const c of dir) {
      if (!c.phone) { skipped++; continue; }
      const ins = await pool.query(
        `INSERT INTO contacts (phone, name, email, address, city, state, contact_type,
                               source, pipeline, stage_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'directory',$8,$9)
         ON CONFLICT (phone) DO NOTHING RETURNING id`,
        [c.phone, c.full_name || null, c.email || null, c.address || null, c.city || null,
         c.state || null, contactType, pipeline, stageId || null]
      );
      if ((ins.rowCount ?? 0) > 0) promoted++; else skipped++;
    }
    await pool.query(
      `UPDATE directory_contacts SET promoted_to_pipeline = TRUE WHERE id = ANY($1)`, [ids]
    );
    res.json({ promoted, skipped });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
```

Note: pipeline `contacts.contact_type` only allows `seller|agent|buyer`; the promote
caller must pass one of those. `source` is free text so `'directory'` is fine.

- [ ] **Step 2: Verify export**

Run: `curl -s -X POST http://localhost:3001/api/directory/export -H "Content-Type: application/json" -d "{}" | head -3`
Expected: CSV header line `full_name,phone,email,...` followed by data rows.

- [ ] **Step 3: Verify promote (use a real directory id from the list endpoint)**

Run: `curl -s -X POST http://localhost:3001/api/directory/promote -H "Content-Type: application/json" -d "{\"ids\":[\"<DIR_ID>\"],\"pipeline\":\"seller_inbound\",\"contactType\":\"seller\"}"`
Expected: `{"promoted":1,"skipped":0}` (re-running → `{"promoted":0,"skipped":1}` because of the UNIQUE phone conflict).

- [ ] **Step 4: Commit**

```bash
git add src/routes/directory.ts
git commit -m "feat: directory export + promote-to-pipeline endpoints"
```

---

# PHASE 3 — Frontend: types, API client, navigation, table, detail

### Task 11: Frontend types + API client

**Files:**
- Modify: `client/src/types.ts`
- Modify: `client/src/api.ts`

- [ ] **Step 1: Add types to `types.ts`**

```typescript
export interface DirectoryContact {
  id: string
  ghl_contact_id: string | null
  full_name: string | null
  phone: string | null
  email: string | null
  business_name: string | null
  city: string | null
  state: string | null
  category: string
  categories: string[]
  tags: string[]
  is_junk: boolean
  promoted_to_pipeline: boolean
}

export interface DirectoryContactDetail extends DirectoryContact {
  first_name: string | null
  last_name: string | null
  address: string | null
  postal_code: string | null
  data: Record<string, string>
  pipeline_matches: { id: string; name: string | null; pipeline: string; stage_name: string | null }[]
}

export type FilterOperator =
  | 'is' | 'is_not' | 'contains' | 'empty' | 'not_empty' | 'gt' | 'lt' | 'between'

export interface FilterCondition {
  field: string
  operator: FilterOperator
  value?: string
  value2?: string
}

export interface FilterSpec {
  combinator: 'AND' | 'OR'
  conditions: FilterCondition[]
}

export interface DirectoryListResult {
  contacts: DirectoryContact[]
  total: number
  page: number
  pageSize: number
}
```

- [ ] **Step 2: Add API functions to `api.ts`**

```typescript
import type {
  DirectoryContact, DirectoryContactDetail, DirectoryListResult, FilterSpec,
} from './types'

export async function fetchDirectory(params: {
  search?: string; category?: string; include_junk?: boolean;
  filters?: FilterSpec; page?: number; pageSize?: number;
}): Promise<DirectoryListResult> {
  const res = await api.get('/directory/contacts', {
    params: {
      search: params.search || undefined,
      category: params.category || undefined,
      include_junk: params.include_junk || undefined,
      filters: params.filters ? JSON.stringify(params.filters) : undefined,
      page: params.page || 1,
      pageSize: params.pageSize || 50,
    },
  })
  return res.data
}

export async function fetchDirectoryContact(id: string): Promise<DirectoryContactDetail> {
  const res = await api.get(`/directory/contacts/${id}`)
  return res.data
}

export async function fetchDirectoryFields(): Promise<{ core: string[]; jsonb: string[] }> {
  const res = await api.get('/directory/fields')
  return res.data
}

export async function patchDirectoryContact(
  id: string, data: Partial<DirectoryContact>
): Promise<DirectoryContact> {
  const res = await api.patch(`/directory/contacts/${id}`, data)
  return res.data
}

export async function createDirectoryContact(
  data: Partial<DirectoryContact>
): Promise<DirectoryContact> {
  const res = await api.post('/directory/contacts', data)
  return res.data
}

export async function bulkTagDirectory(
  ids: string[], category?: string, addTags?: string[]
): Promise<void> {
  await api.post('/directory/bulk-tag', { ids, category, addTags })
}

export async function promoteDirectory(
  ids: string[], pipeline: string, contactType: string, stageId?: string
): Promise<{ promoted: number; skipped: number }> {
  const res = await api.post('/directory/promote', { ids, pipeline, contactType, stageId })
  return res.data
}

export function exportDirectoryUrl(): string { return '/api/directory/export' }
```

- [ ] **Step 3: Verify it type-checks/builds**

Run: `cd ~/wih-app/client && npm run build`
Expected: build succeeds (no TS errors).

- [ ] **Step 4: Commit**

```bash
git add client/src/types.ts client/src/api.ts
git commit -m "feat: directory frontend types + API client"
```

---

### Task 12: Sidebar Directory nav + App view mode

**Files:**
- Modify: `client/src/components/Sidebar.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Update Sidebar to support a Directory item**

Replace the `Sidebar` component with one that adds a separated Directory group. It takes a `view` prop and an `onSelectDirectory` callback alongside the existing pipeline tabs.

```typescript
import type { Pipeline } from '../types'
import { usePipeline } from '../context/PipelineContext'

interface Props {
  active: Pipeline
  view: 'pipeline' | 'directory'
  onChange: (p: Pipeline) => void
  onSelectDirectory: () => void
}

const TABS: { id: Pipeline; label: string }[] = [
  { id: 'agent_outreach', label: 'Agent Outreach' },
  { id: 'seller_inbound', label: 'ISP to Lead' },
  { id: 'active_deals', label: 'Disposition' },
]

export function Sidebar({ active, view, onChange, onSelectDirectory }: Props) {
  const { state } = usePipeline()
  const countForPipeline = (pipeline: Pipeline) =>
    Object.values(state.contacts).filter(c => c.pipeline === pipeline && !c.is_dnc).length

  return (
    <div className="flex flex-col w-56 min-h-screen bg-[#1a1a2e] border-r border-white/10 shrink-0">
      <div className="px-5 py-6 border-b border-white/10">
        <div className="text-xs font-bold tracking-widest text-purple-400 uppercase mb-1">WIH</div>
        <div className="text-white font-semibold text-sm leading-tight">Webber Investment<br />Homes</div>
      </div>

      <nav className="flex flex-col gap-1 p-3 flex-1">
        <div className="text-[10px] font-bold tracking-widest text-slate-500 uppercase px-3 mb-1">Pipelines</div>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${
              view === 'pipeline' && active === tab.id
                ? 'bg-purple-600/30 text-purple-300 border border-purple-500/40'
                : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            }`}
          >
            <span>{tab.label}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded-full font-mono ${
              view === 'pipeline' && active === tab.id ? 'bg-purple-500/40 text-purple-200' : 'bg-white/10 text-slate-400'
            }`}>{countForPipeline(tab.id)}</span>
          </button>
        ))}

        <div className="border-t border-white/10 my-3" />
        <div className="text-[10px] font-bold tracking-widest text-slate-500 uppercase px-3 mb-1">Directory</div>
        <button
          onClick={onSelectDirectory}
          className={`flex items-center px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${
            view === 'directory'
              ? 'bg-purple-600/30 text-purple-300 border border-purple-500/40'
              : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
          }`}
        >
          Contacts
        </button>
      </nav>

      <div className="px-4 py-3 border-t border-white/10">
        <div className="text-xs text-slate-600">Live pipeline</div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Update `App.tsx` to switch views**

```typescript
import { useState } from 'react'
import type { Contact, Pipeline } from './types'
import { PipelineProvider } from './context/PipelineContext'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { KanbanBoard } from './components/KanbanBoard'
import { LeadPanel } from './components/LeadPanel'
import { DirectoryView } from './components/DirectoryView'
import { usePipelineWebSocket } from './hooks/usePipelineWebSocket'
import { usePipeline } from './context/PipelineContext'

function Dashboard() {
  const [view, setView] = useState<'pipeline' | 'directory'>('pipeline')
  const [pipeline, setPipeline] = useState<Pipeline>('agent_outreach')
  const [search, setSearch] = useState('')
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const { activeCallId } = usePipelineWebSocket()
  const { dispatch } = usePipeline()

  function handleSelect(contact: Contact) {
    setSelectedContact(contact)
    dispatch({ type: 'CLEAR_UNREAD', id: contact.id })
  }

  function handlePipelineChange(p: Pipeline) {
    setView('pipeline')
    setPipeline(p)
    setSelectedContact(null)
    setSearch('')
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#0f0f1a]">
      <Sidebar
        active={pipeline}
        view={view}
        onChange={handlePipelineChange}
        onSelectDirectory={() => { setView('directory'); setSelectedContact(null) }}
      />

      <div className="flex flex-col flex-1 min-w-0">
        {view === 'pipeline' ? (
          <>
            <TopBar pipeline={pipeline} search={search} onSearch={setSearch} />
            <div className="flex flex-1 min-h-0">
              <KanbanBoard
                pipeline={pipeline}
                search={search}
                selectedId={selectedContact?.id ?? null}
                onSelect={handleSelect}
              />
              {selectedContact && (
                <LeadPanel
                  contact={selectedContact}
                  onClose={() => setSelectedContact(null)}
                  activeCallId={activeCallId}
                />
              )}
            </div>
          </>
        ) : (
          <DirectoryView />
        )}
      </div>
    </div>
  )
}

function App() {
  return (
    <PipelineProvider>
      <Dashboard />
    </PipelineProvider>
  )
}

export default App
```

- [ ] **Step 3: Verify build (DirectoryView created in next task — expect a missing-module error until Task 13)**

Skip building until Task 13 adds `DirectoryView`. Proceed.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/Sidebar.tsx client/src/App.tsx
git commit -m "feat: directory navigation + app view switch"
```

---

### Task 13: DirectoryView (table + search + pagination + bulk bar)

**Files:**
- Create: `client/src/components/DirectoryView.tsx`
- Create: `client/src/components/DirectoryDetailPanel.tsx`

- [ ] **Step 1: Implement `DirectoryDetailPanel.tsx`**

```typescript
import { useEffect, useState } from 'react'
import type { DirectoryContactDetail } from '../types'
import { fetchDirectoryContact } from '../api'

export function DirectoryDetailPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [c, setC] = useState<DirectoryContactDetail | null>(null)
  useEffect(() => { fetchDirectoryContact(id).then(setC) }, [id])
  if (!c) return (
    <div className="w-96 border-l border-white/10 bg-[#1a1a2e] p-4 text-slate-400">Loading…</div>
  )
  const fields = Object.entries(c.data).filter(([, v]) => v && String(v).trim())
  return (
    <div className="w-96 border-l border-white/10 bg-[#1a1a2e] flex flex-col min-h-0">
      <div className="flex items-center justify-between p-4 border-b border-white/10">
        <div className="text-white font-semibold">{c.full_name || '(no name)'}</div>
        <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
      </div>
      <div className="overflow-y-auto p-4 text-sm space-y-3">
        <div className="text-slate-300">{c.phone} · {c.email}</div>
        <div><span className="text-purple-400">Category:</span> {c.category}</div>
        {c.tags.length > 0 && <div className="text-slate-400">Tags: {c.tags.join(', ')}</div>}

        <div className="border-t border-white/10 pt-3">
          <div className="text-[10px] font-bold tracking-widest text-slate-500 uppercase mb-2">Pipelines & Opportunities</div>
          {c.pipeline_matches.length === 0
            ? <div className="text-slate-500">Not in any pipeline.</div>
            : c.pipeline_matches.map(m => (
                <div key={m.id} className="text-slate-300">{m.pipeline} — {m.stage_name || 'no stage'}</div>
              ))}
        </div>

        <div className="border-t border-white/10 pt-3">
          <div className="text-[10px] font-bold tracking-widest text-slate-500 uppercase mb-2">All fields</div>
          {fields.map(([k, v]) => (
            <div key={k} className="mb-1">
              <span className="text-slate-500">{k}:</span> <span className="text-slate-200">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Implement `DirectoryView.tsx`**

```typescript
import { useEffect, useState, useCallback } from 'react'
import type { DirectoryContact, FilterSpec } from '../types'
import { fetchDirectory, promoteDirectory } from '../api'
import { DirectoryDetailPanel } from './DirectoryDetailPanel'
import { AdvancedFilterPanel } from './AdvancedFilterPanel'

export function DirectoryView() {
  const [rows, setRows] = useState<DirectoryContact[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<FilterSpec | undefined>()
  const [showFilters, setShowFilters] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const pageSize = 50

  const load = useCallback(() => {
    fetchDirectory({ search, filters, page, pageSize }).then(r => {
      setRows(r.contacts); setTotal(r.total)
    })
  }, [search, filters, page])

  useEffect(() => { load() }, [load])

  function toggle(id: string) {
    setChecked(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function promote() {
    const ids = Array.from(checked)
    if (!ids.length) return
    const r = await promoteDirectory(ids, 'seller_inbound', 'seller')
    alert(`Promoted ${r.promoted}, skipped ${r.skipped}`)
    setChecked(new Set()); load()
  }

  async function exportCsv() {
    const ids = Array.from(checked)
    const res = await fetch('/api/directory/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'directory-export.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const pages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="flex flex-1 min-h-0">
      <div className="flex flex-col flex-1 min-w-0">
        <div className="flex items-center gap-3 p-4 border-b border-white/10 bg-[#12121f]">
          <input
            value={search}
            onChange={e => { setPage(1); setSearch(e.target.value) }}
            placeholder="Search name, phone, or email…"
            className="flex-1 bg-[#1a1a2e] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500"
          />
          <button onClick={() => setShowFilters(s => !s)}
            className="px-3 py-2 rounded-lg text-sm bg-white/5 text-slate-300 hover:bg-white/10">
            Filters{filters?.conditions.length ? ` (${filters.conditions.length})` : ''}
          </button>
          <span className="text-xs text-slate-500">{total.toLocaleString()} contacts</span>
        </div>

        {checked.size > 0 && (
          <div className="flex items-center gap-3 px-4 py-2 bg-purple-600/20 border-b border-purple-500/30 text-sm">
            <span className="text-purple-200">{checked.size} selected</span>
            <button onClick={exportCsv} className="text-slate-200 hover:text-white">Export CSV</button>
            <button onClick={promote} className="text-slate-200 hover:text-white">Promote → ISP to Lead</button>
            <button onClick={() => setChecked(new Set())} className="text-slate-400 hover:text-white">Clear</button>
          </div>
        )}

        <div className="overflow-auto flex-1">
          <table className="w-full text-sm text-left">
            <thead className="sticky top-0 bg-[#12121f] text-slate-500 text-xs uppercase tracking-wider">
              <tr>
                <th className="p-3 w-8"></th>
                <th className="p-3">Name</th>
                <th className="p-3">Phone</th>
                <th className="p-3">Email</th>
                <th className="p-3">Category</th>
                <th className="p-3">City/State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`border-b border-white/5 cursor-pointer hover:bg-white/5 ${selectedId === r.id ? 'bg-white/5' : ''}`}>
                  <td className="p-3" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={checked.has(r.id)} onChange={() => toggle(r.id)} />
                  </td>
                  <td className="p-3 text-white">{r.full_name || '—'}</td>
                  <td className="p-3 text-slate-300">{r.phone || '—'}</td>
                  <td className="p-3 text-slate-300">{r.email || '—'}</td>
                  <td className="p-3"><span className="px-2 py-0.5 rounded-full bg-white/10 text-slate-300 text-xs">{r.category}</span></td>
                  <td className="p-3 text-slate-400">{[r.city, r.state].filter(Boolean).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between p-3 border-t border-white/10 text-sm text-slate-400">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
            className="px-3 py-1 rounded bg-white/5 disabled:opacity-30">Prev</button>
          <span>Page {page} / {pages}</span>
          <button disabled={page >= pages} onClick={() => setPage(p => p + 1)}
            className="px-3 py-1 rounded bg-white/5 disabled:opacity-30">Next</button>
        </div>
      </div>

      {showFilters && (
        <AdvancedFilterPanel
          value={filters}
          onApply={f => { setPage(1); setFilters(f); setShowFilters(false) }}
          onClose={() => setShowFilters(false)}
        />
      )}
      {selectedId && <DirectoryDetailPanel id={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  )
}
```

- [ ] **Step 3: Commit (build happens after Task 14 adds AdvancedFilterPanel)**

```bash
git add client/src/components/DirectoryView.tsx client/src/components/DirectoryDetailPanel.tsx
git commit -m "feat: directory table view + detail panel"
```

---

# PHASE 4 — Advanced filter builder

### Task 14: AdvancedFilterPanel

**Files:**
- Create: `client/src/components/AdvancedFilterPanel.tsx`

- [ ] **Step 1: Implement the filter builder**

```typescript
import { useEffect, useState } from 'react'
import type { FilterSpec, FilterCondition, FilterOperator } from '../types'
import { fetchDirectoryFields } from '../api'

const OPERATORS: { id: FilterOperator; label: string; needsValue: boolean }[] = [
  { id: 'is', label: 'is', needsValue: true },
  { id: 'is_not', label: 'is not', needsValue: true },
  { id: 'contains', label: 'contains', needsValue: true },
  { id: 'empty', label: 'is empty', needsValue: false },
  { id: 'not_empty', label: 'is not empty', needsValue: false },
  { id: 'gt', label: '>', needsValue: true },
  { id: 'lt', label: '<', needsValue: true },
]

interface Props {
  value?: FilterSpec
  onApply: (f: FilterSpec | undefined) => void
  onClose: () => void
}

export function AdvancedFilterPanel({ value, onApply, onClose }: Props) {
  const [fields, setFields] = useState<string[]>([])
  const [combinator, setCombinator] = useState<'AND' | 'OR'>(value?.combinator || 'AND')
  const [conds, setConds] = useState<FilterCondition[]>(value?.conditions || [])

  useEffect(() => {
    fetchDirectoryFields().then(f => setFields([...f.core, ...f.jsonb]))
  }, [])

  function add() {
    setConds(c => [...c, { field: fields[0] || 'full_name', operator: 'contains', value: '' }])
  }
  function update(i: number, patch: Partial<FilterCondition>) {
    setConds(c => c.map((x, j) => j === i ? { ...x, ...patch } : x))
  }
  function remove(i: number) {
    setConds(c => c.filter((_, j) => j !== i))
  }

  return (
    <div className="w-[28rem] border-l border-white/10 bg-[#1a1a2e] flex flex-col min-h-0">
      <div className="flex items-center justify-between p-4 border-b border-white/10">
        <div className="text-white font-semibold">Advanced Filter</div>
        <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
      </div>

      <div className="p-4 flex items-center gap-2 text-sm">
        <span className="text-slate-400">Match</span>
        <select value={combinator} onChange={e => setCombinator(e.target.value as 'AND' | 'OR')}
          className="bg-[#0f0f1a] border border-white/10 rounded px-2 py-1 text-white">
          <option value="AND">ALL</option>
          <option value="OR">ANY</option>
        </select>
        <span className="text-slate-400">of the conditions</span>
      </div>

      <div className="overflow-y-auto flex-1 px-4 space-y-3">
        {conds.map((c, i) => {
          const op = OPERATORS.find(o => o.id === c.operator)!
          return (
            <div key={i} className="space-y-2 border border-white/10 rounded-lg p-2">
              <select value={c.field} onChange={e => update(i, { field: e.target.value })}
                className="w-full bg-[#0f0f1a] border border-white/10 rounded px-2 py-1 text-white text-sm">
                {fields.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              <div className="flex gap-2">
                <select value={c.operator} onChange={e => update(i, { operator: e.target.value as FilterOperator })}
                  className="bg-[#0f0f1a] border border-white/10 rounded px-2 py-1 text-white text-sm">
                  {OPERATORS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
                {op.needsValue && (
                  <input value={c.value || ''} onChange={e => update(i, { value: e.target.value })}
                    className="flex-1 bg-[#0f0f1a] border border-white/10 rounded px-2 py-1 text-white text-sm" />
                )}
                <button onClick={() => remove(i)} className="text-slate-500 hover:text-red-400">✕</button>
              </div>
            </div>
          )
        })}
        <button onClick={add} className="text-purple-300 text-sm hover:text-purple-200">+ Add condition</button>
      </div>

      <div className="p-4 border-t border-white/10 flex gap-2">
        <button onClick={() => onApply(conds.length ? { combinator, conditions: conds } : undefined)}
          className="flex-1 bg-purple-600 hover:bg-purple-500 text-white rounded-lg py-2 text-sm">Apply</button>
        <button onClick={() => { setConds([]); onApply(undefined) }}
          className="px-3 bg-white/5 text-slate-300 rounded-lg py-2 text-sm hover:bg-white/10">Clear</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Build the client**

Run: `cd ~/wih-app/client && npm run build`
Expected: build succeeds with no TS errors.

- [ ] **Step 3: Manual end-to-end check**

Run server + client (`cd ~/wih-app && npm run dev`, and `cd ~/wih-app/client && npm run dev`), open the app, click **Directory → Contacts**. Verify:
- Table loads with contacts and a total count.
- Search by a known name/phone narrows results.
- "Filters" → add `City contains lubbock` → Apply → list narrows.
- Click a row → detail panel shows all fields + "Pipelines & Opportunities".
- Check a few rows → Export CSV downloads; Promote reports a count.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/AdvancedFilterPanel.tsx
git commit -m "feat: advanced filter builder UI"
```

---

## Final verification

- [ ] `npm test` (in `~/wih-app`) — all unit tests pass.
- [ ] `npm run build` (in `~/wih-app/client`) — client builds clean.
- [ ] Directory shows all imported contacts, isolated from the three pipelines.
- [ ] Re-running `npm run import-contacts` does not change the row count (idempotent).
- [ ] Supabase dashboard → Table editor → `directory_contacts` shows the loaded rows.

## Notes / Guardrails

- Never commit `.env` (already gitignored).
- The pipeline `contacts` table and its `contact_type` CHECK (`seller|agent|buyer`) are untouched; promote passes one of those three values.
- All JSONB filter values are parameterized — no string interpolation of user values.
- Junk rows are hidden by default (toggle `include_junk`) but never deleted.
- This importer is one-time/idempotent; ongoing GHL sync is out of scope.
