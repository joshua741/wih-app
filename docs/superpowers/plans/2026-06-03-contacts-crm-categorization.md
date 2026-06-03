# Contacts CRM Tab — Categorization & Global Rolodex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Contacts Directory into a usable standalone CRM tab — every contact in one global, searchable, filterable list, with multi-label tagging editable single or in bulk, and junk hidden by default.

**Architecture:** `directory_contacts` (Supabase, 14,206 rows) is the single source. Lead-type labels are multi-valued in `categories[]` and surfaced in the UI as "Tags." Backend gains label-count/label-list/bulk-label endpoints and label/junk filtering; the React Contacts tab gains a label sidebar with counts, simplified columns, and single + bulk label editing. A re-runnable recompute script re-derives `categories[]`/`is_junk` from stored data so rule changes can be re-applied without re-importing.

**Tech Stack:** TypeScript, Express 5, `pg` (Postgres/Supabase), React + Vite, Tailwind, `node:test` for unit tests.

**Note on scope:** The original import already flagged known junk (landline, name-via-lookup, etc.), so the recompute's immediate data change is small — its value is re-runnable infrastructure plus picking up the few `Possible Exit Strategy` records. The bulk of user-facing value is the UI/API tooling.

---

## File Structure

**Backend (modify):**
- `src/lib/categorize.ts` — add `ALL_CATEGORIES` export, a value-based rule for `Possible Exit Strategy`, two more junk tags.
- `src/lib/categorize.test.ts` — new cases (already in `npm test`).
- `src/routes/directory.ts` — add `address` to list SELECT; add `label` + `only_junk` filters; add `/label-counts`, `/labels`, `/bulk-label`.

**Backend (create):**
- `src/db/recategorize.ts` — recompute script with `--dry-run`.

**Frontend (modify):**
- `client/src/types.ts` — add `address` to `DirectoryContact`; add `LabelCounts` type.
- `client/src/api.ts` — `address`/`label`/`only_junk` in `fetchDirectory`; add `fetchLabelCounts`, `fetchLabels`, `bulkLabelDirectory`.
- `client/src/components/DirectoryView.tsx` — sidebar, columns, label filter, junk toggle, bulk label toolbar.
- `client/src/components/DirectoryDetailPanel.tsx` — label editor + street address.

**Frontend (create):**
- `client/src/components/LabelSidebar.tsx` — label list with live counts + selection.
- `client/src/components/LabelEditor.tsx` — reusable multi-label chip editor.

---

## Task 1: Backend — categorization rules (ALL_CATEGORIES, exit-strategy values, junk)

**Files:**
- Modify: `src/lib/categorize.ts`
- Test: `src/lib/categorize.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/categorize.test.ts`:

```typescript
import { cleanTags, categorize, ALL_CATEGORIES } from './categorize';

test('ALL_CATEGORIES includes the known label set', () => {
  assert.ok(ALL_CATEGORIES.includes('seller'));
  assert.ok(ALL_CATEGORIES.includes('pml'));
  assert.ok(ALL_CATEGORIES.includes('uncategorized'));
  assert.equal(ALL_CATEGORIES.length, 12);
});

test('categorize: Possible Exit Strategy value maps to label', () => {
  assert.equal(categorize({ 'Possible Exit Strategy': 'In House (Rent To Own)' }, []).category, 'rto_tenant');
  assert.equal(categorize({ 'Possible Exit Strategy': 'Wholesale (Sub 2)' }, []).category, 'seller');
});

test('categorize: a contact can hold multiple labels', () => {
  const r = categorize({ 'Name of Title Company': 'ABC Title' }, ['seller']);
  assert.ok(r.categories.includes('seller'));
  assert.ok(r.categories.includes('title_agent'));
  assert.ok(r.categories.length >= 2);
});

test('categorize: wrong number tag is junk', () => {
  assert.equal(categorize({ 'First Name': 'Joe', 'Email': 'a@b.com' }, ['wrong number']).isJunk, true);
});
```

Note: there is already `import { cleanTags, categorize } from './categorize';` at the top of the file. Replace that single existing import line with the new one above (adding `ALL_CATEGORIES`) so the symbol resolves; do not leave two imports of the same module.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `ALL_CATEGORIES` is undefined and the exit-strategy/multi-label assertions error.

- [ ] **Step 3: Implement the rule changes**

In `src/lib/categorize.ts`:

1. After the `Category` type union, add the exported constant:

```typescript
export const ALL_CATEGORIES: Category[] = [
  'buyer', 'seller', 'rto_tenant', 'cash_buyer', 'pml', 'wholesaler',
  'title_agent', 'insurance_agent', 'contractor', 'realtor', 'team', 'uncategorized',
];
```

2. Add two tags to the existing `JUNK_TAGS` set (`'wrong number'`, `'disconnected'`):

```typescript
const JUNK_TAGS = new Set([
  'landline', 'spam likely', 'dead number', "couldn't find caller name",
  'name via lookup', 'ghost', 'dnd', 'wrong number', 'disconnected',
]);
```

3. After the `FIELD_CLUSTERS` declaration, add value-based rules:

```typescript
// Field VALUE -> category (lowercased exact match on the cell's value).
const VALUE_RULES: { field: string; map: Record<string, Category> }[] = [
  { field: 'Possible Exit Strategy', map: {
    'wholesale (sub 2)': 'seller',
    'wholesale (cash)': 'seller',
    'wholesale (seller finance)': 'seller',
    'in house (rent to own)': 'rto_tenant',
  } },
];
```

4. Inside `categorize`, after the `FIELD_CLUSTERS` loop and before `const category`, add:

```typescript
  // 3. Field value rules
  for (const vr of VALUE_RULES) {
    const v = (row[vr.field] || '').trim().toLowerCase();
    const mapped = v ? vr.map[v] : undefined;
    if (mapped) add(mapped);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all categorize tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/categorize.ts src/lib/categorize.test.ts
git commit -m "feat: ALL_CATEGORIES export, exit-strategy value rule, extra junk tags"
```

---

## Task 2: Backend — recompute script with dry-run

**Files:**
- Create: `src/db/recategorize.ts`

- [ ] **Step 1: Write the script**

Create `src/db/recategorize.ts`:

```typescript
import 'dotenv/config';
import { pool } from './pool';
import { cleanTags, categorize } from '../lib/categorize';

// Re-derive categories[]/category/is_junk/tags for every directory_contacts row
// from its stored `data` JSONB. Idempotent. Pass --dry-run to report without writing.
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[RECATEGORIZE] ${dryRun ? 'DRY RUN' : 'LIVE'} starting...`);

  const before = await pool.query<{ junk: string; uncat: string; total: string }>(
    `SELECT count(*) FILTER (WHERE is_junk)::int AS junk,
            count(*) FILTER (WHERE 'uncategorized' = ANY(categories))::int AS uncat,
            count(*)::int AS total
     FROM directory_contacts`
  );
  console.log('[RECATEGORIZE] before:', before.rows[0]);

  const PAGE = 1000;
  let offset = 0;
  let changed = 0;
  let nextJunk = 0;
  let nextUncat = 0;

  for (;;) {
    const rows = (await pool.query<{ id: string; data: Record<string, string> }>(
      `SELECT id, data FROM directory_contacts ORDER BY id LIMIT $1 OFFSET $2`,
      [PAGE, offset]
    )).rows;
    if (rows.length === 0) break;

    for (const r of rows) {
      const data = r.data || {};
      const tags = cleanTags(data['Tags']);
      const { category, categories, isJunk } = categorize(data, tags);
      if (isJunk) nextJunk++;
      if (categories.includes('uncategorized')) nextUncat++;
      if (!dryRun) {
        await pool.query(
          `UPDATE directory_contacts
           SET category = $1, categories = $2, tags = $3, is_junk = $4
           WHERE id = $5`,
          [category, categories, tags, isJunk, r.id]
        );
      }
      changed++;
    }
    offset += rows.length;
    console.log(`[RECATEGORIZE] processed ${offset}`);
  }

  console.log('[RECATEGORIZE] would-be after:', { junk: nextJunk, uncat: nextUncat, total: changed });
  console.log(`[RECATEGORIZE] ${dryRun ? 'DRY RUN complete (no writes)' : `LIVE complete, ${changed} rows updated`}`);
  await pool.end();
}

main().catch((err) => { console.error('[RECATEGORIZE] Failed:', err); process.exit(1); });
```

- [ ] **Step 2: Add npm scripts**

In `package.json` `scripts`, add after the `import-contacts` line:

```json
    "recategorize:dry": "ts-node src/db/recategorize.ts --dry-run",
    "recategorize": "ts-node src/db/recategorize.ts"
```

(Add a trailing comma to the preceding `import-contacts` line so the JSON stays valid.)

- [ ] **Step 3: Run the dry-run to verify it reads without writing**

Run: `npm run recategorize:dry`
Expected: prints `before:` counts, progress lines up to ~14206, a `would-be after:` line, and `DRY RUN complete (no writes)`. No errors. Do NOT run the live version yet — that happens in Task 11 after the UI is verified.

- [ ] **Step 4: Commit**

```bash
git add src/db/recategorize.ts package.json
git commit -m "feat: idempotent recategorize script with --dry-run"
```

---

## Task 3: Backend — directory list: address column + label/junk filters

**Files:**
- Modify: `src/routes/directory.ts`

- [ ] **Step 1: Add `address` to the list SELECT**

In `src/routes/directory.ts`, in the `GET /contacts` handler, change the list query column set to include `address` and `postal_code`:

```typescript
    const listRes = await pool.query(
      `SELECT id, ghl_contact_id, full_name, phone, email, business_name, address, city, state,
              postal_code, category, categories, tags, is_junk, promoted_to_pipeline
       FROM directory_contacts ${whereSql}
       ORDER BY full_name NULLS LAST
       LIMIT $${n++} OFFSET $${n++}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
```

- [ ] **Step 2: Add label + only_junk handling**

In the same handler, replace the junk + category block (the lines that read `const includeJunk = ...`, `if (!includeJunk) where.push('is_junk = FALSE')`, and the `if (category)` block) with:

```typescript
    const includeJunk = String(req.query.include_junk || '') === 'true';
    const onlyJunk = String(req.query.only_junk || '') === 'true';
    const category = String(req.query.category || '').trim();
    const label = String(req.query.label || '').trim();

    if (onlyJunk) where.push('is_junk = TRUE');
    else if (!includeJunk) where.push('is_junk = FALSE');

    if (category) { where.push(`category = $${n++}`); params.push(category); }
    if (label) { where.push(`$${n++} = ANY(categories)`); params.push(label); }
```

(Leave the `search` and `filters` blocks below unchanged.)

- [ ] **Step 3: Verify against the live DB**

Run (PowerShell, app must be buildable; quickest check is a one-off script mirroring the query). Create a temporary check inline:

Run: `node -e "require('dotenv/config');const{Pool}=require('pg');const u=process.env.DATABASE_URL;const p=new Pool({connectionString:u,ssl:{rejectUnauthorized:false}});p.query(\"SELECT count(*)::int n FROM directory_contacts WHERE is_junk=TRUE\").then(r=>{console.log('junk rows:',r.rows[0].n);return p.end()})"`
Expected: prints `junk rows:` with a number ~1474 (confirms `only_junk` semantics select the right set).

- [ ] **Step 4: Commit**

```bash
git add src/routes/directory.ts
git commit -m "feat: directory list returns address + supports label/only_junk filters"
```

---

## Task 4: Backend — label-counts and labels endpoints

**Files:**
- Modify: `src/routes/directory.ts`

- [ ] **Step 1: Add the import and endpoints**

At the top of `src/routes/directory.ts`, add to the existing imports:

```typescript
import { ALL_CATEGORIES } from '../lib/categorize';
```

Add these two routes (place them just before the `GET /fields` route):

```typescript
// GET /api/directory/labels — the full label set (for editors/sidebars)
directoryRouter.get('/labels', (_req, res) => {
  res.json({ labels: ALL_CATEGORIES });
});

// GET /api/directory/label-counts — count per label (non-junk), plus totals
directoryRouter.get('/label-counts', async (_req, res) => {
  try {
    const counts = await pool.query(
      `SELECT label, count(*)::int AS n
       FROM (SELECT id, unnest(categories) AS label
             FROM directory_contacts WHERE is_junk = FALSE) s
       GROUP BY label ORDER BY n DESC`
    );
    const totals = await pool.query(
      `SELECT count(*) FILTER (WHERE NOT is_junk)::int AS total_active,
              count(*) FILTER (WHERE is_junk)::int AS junk
       FROM directory_contacts`
    );
    res.json({
      labels: counts.rows,
      total_active: totals.rows[0].total_active,
      junk: totals.rows[0].junk,
    });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
```

- [ ] **Step 2: Verify the endpoints respond**

Start the backend: `npm run dev` (in one terminal). Then in another:

Run: `node -e "fetch('http://localhost:3001/api/directory/label-counts').then(r=>r.json()).then(j=>console.log(JSON.stringify(j).slice(0,400)))"`
Expected: JSON with a `labels` array (e.g. `{label:'uncategorized',n:...}`, `{label:'seller',n:...}`), a `total_active` number, and a `junk` number. Then stop `npm run dev`.

- [ ] **Step 3: Commit**

```bash
git add src/routes/directory.ts
git commit -m "feat: /labels and /label-counts directory endpoints"
```

---

## Task 5: Backend — bulk-label add/remove endpoint

**Files:**
- Modify: `src/routes/directory.ts`

- [ ] **Step 1: Add the endpoint**

In `src/routes/directory.ts`, add this route just after the existing `POST /bulk-tag` route:

```typescript
// POST /api/directory/bulk-label — add and/or remove labels on a set of ids
directoryRouter.post('/bulk-label', async (req, res) => {
  try {
    const { ids = [], add = [], remove = [] } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' });

    if (Array.isArray(remove) && remove.length) {
      await pool.query(
        `UPDATE directory_contacts
         SET categories = COALESCE(
           (SELECT array_agg(c) FROM unnest(categories) c WHERE c <> ALL($1::text[])), '{}')
         WHERE id = ANY($2)`,
        [remove, ids]
      );
    }
    if (Array.isArray(add) && add.length) {
      await pool.query(
        `UPDATE directory_contacts
         SET categories = (SELECT array_agg(DISTINCT x) FROM unnest(categories || $1::text[]) x)
         WHERE id = ANY($2)`,
        [add, ids]
      );
    }
    // Keep singular category in sync (first label, or 'uncategorized' if empty).
    await pool.query(
      `UPDATE directory_contacts
       SET category = COALESCE(NULLIF(categories[1], ''), 'uncategorized'),
           categories = CASE WHEN cardinality(categories) = 0 THEN '{uncategorized}' ELSE categories END
       WHERE id = ANY($1)`,
      [ids]
    );
    res.json({ updated: ids.length });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
```

- [ ] **Step 2: Verify add then remove round-trips on one row**

Start `npm run dev`. Pick any id:

Run: `node -e "require('dotenv/config');const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});p.query('SELECT id FROM directory_contacts LIMIT 1').then(async r=>{const id=r.rows[0].id;await fetch('http://localhost:3001/api/directory/bulk-label',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[id],add:['pml']})});const a=await p.query('SELECT categories FROM directory_contacts WHERE id=$1',[id]);console.log('after add:',a.rows[0].categories);await fetch('http://localhost:3001/api/directory/bulk-label',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[id],remove:['pml']})});const b=await p.query('SELECT categories FROM directory_contacts WHERE id=$1',[id]);console.log('after remove:',b.rows[0].categories);return p.end()})"`
Expected: `after add:` includes `pml`; `after remove:` no longer includes `pml`. Stop `npm run dev`.

- [ ] **Step 3: Commit**

```bash
git add src/routes/directory.ts
git commit -m "feat: bulk-label add/remove endpoint, keeps singular category in sync"
```

---

## Task 6: Frontend — types + API client

**Files:**
- Modify: `client/src/types.ts`
- Modify: `client/src/api.ts`

- [ ] **Step 1: Extend types**

In `client/src/types.ts`, add `address` to `DirectoryContact` (after `email`):

```typescript
  email: string | null
  address: string | null
```

And add a new type at the end of the file:

```typescript
export interface LabelCounts {
  labels: { label: string; n: number }[]
  total_active: number
  junk: number
}
```

- [ ] **Step 2: Extend the API client**

In `client/src/api.ts`, replace the `fetchDirectory` function with this version (adds `label` + `only_junk`):

```typescript
export async function fetchDirectory(params: {
  search?: string; category?: string; label?: string;
  include_junk?: boolean; only_junk?: boolean;
  filters?: FilterSpec; page?: number; pageSize?: number;
}): Promise<DirectoryListResult> {
  const res = await api.get('/directory/contacts', {
    params: {
      search: params.search || undefined,
      category: params.category || undefined,
      label: params.label || undefined,
      include_junk: params.include_junk || undefined,
      only_junk: params.only_junk || undefined,
      filters: params.filters ? JSON.stringify(params.filters) : undefined,
      page: params.page || 1,
      pageSize: params.pageSize || 50,
    },
  })
  return res.data
}
```

Add `LabelCounts` to the type import on line 2, then add these functions after `promoteDirectory`:

```typescript
export async function fetchLabelCounts(): Promise<LabelCounts> {
  const res = await api.get('/directory/label-counts')
  return res.data
}

export async function fetchLabels(): Promise<string[]> {
  const res = await api.get('/directory/labels')
  return res.data.labels
}

export async function bulkLabelDirectory(
  ids: string[], add: string[], remove: string[]
): Promise<void> {
  await api.post('/directory/bulk-label', { ids, add, remove })
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd client && npx tsc --noEmit && cd ..`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/types.ts client/src/api.ts
git commit -m "feat: directory address field + label-counts/labels/bulk-label API client"
```

---

## Task 7: Frontend — LabelEditor component

**Files:**
- Create: `client/src/components/LabelEditor.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useEffect, useState } from 'react'
import { fetchLabels } from '../api'

// Reusable multi-label chip editor. `value` is the current labels; `onChange`
// fires with the next array whenever a label is added or removed.
export function LabelEditor({ value, onChange }: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const [all, setAll] = useState<string[]>([])
  useEffect(() => { fetchLabels().then(setAll) }, [])
  const available = all.filter(l => l !== 'uncategorized' && !value.includes(l))

  return (
    <div className="flex flex-wrap gap-1 items-center">
      {value.filter(l => l !== 'uncategorized').map(l => (
        <span key={l} className="px-2 py-0.5 rounded-full bg-purple-600/30 text-purple-100 text-xs flex items-center gap-1">
          {l}
          <button onClick={() => onChange(value.filter(x => x !== l))}
            className="text-purple-300 hover:text-white">×</button>
        </span>
      ))}
      {available.length > 0 && (
        <select value="" onChange={e => { if (e.target.value) onChange([...value.filter(x => x !== 'uncategorized'), e.target.value]) }}
          className="bg-[#0f0f1a] border border-white/10 rounded px-2 py-0.5 text-xs text-slate-300">
          <option value="">+ label</option>
          {available.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd client && npx tsc --noEmit && cd ..`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/LabelEditor.tsx
git commit -m "feat: reusable LabelEditor chip component"
```

---

## Task 8: Frontend — LabelSidebar component

**Files:**
- Create: `client/src/components/LabelSidebar.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useEffect, useState } from 'react'
import { fetchLabelCounts } from '../api'
import type { LabelCounts } from '../types'

export interface LabelSelection { label: string | null; junk: boolean }

// Left rail of labels with live counts. `version` bumps to force a count refresh
// after the user edits labels elsewhere.
export function LabelSidebar({ selected, onSelect, version }: {
  selected: LabelSelection
  onSelect: (s: LabelSelection) => void
  version: number
}) {
  const [data, setData] = useState<LabelCounts | null>(null)
  useEffect(() => { fetchLabelCounts().then(setData) }, [version])

  const Row = ({ id, label, n, active, onClick }: {
    id: string; label: string; n: number; active: boolean; onClick: () => void
  }) => (
    <button key={id} onClick={onClick}
      className={`flex items-center justify-between w-full px-3 py-1.5 rounded text-sm ${
        active ? 'bg-purple-600/30 text-white' : 'text-slate-300 hover:bg-white/5'}`}>
      <span className="truncate">{label}</span>
      <span className="text-xs text-slate-500 ml-2">{n.toLocaleString()}</span>
    </button>
  )

  return (
    <div className="w-52 shrink-0 border-r border-white/10 bg-[#12121f] p-2 overflow-y-auto space-y-0.5">
      <Row id="all" label="All" n={data?.total_active ?? 0}
        active={selected.label === null && !selected.junk}
        onClick={() => onSelect({ label: null, junk: false })} />
      {(data?.labels ?? []).map(l => (
        <Row key={l.label} id={l.label} label={l.label} n={l.n}
          active={selected.label === l.label && !selected.junk}
          onClick={() => onSelect({ label: l.label, junk: false })} />
      ))}
      <div className="border-t border-white/10 my-1" />
      <Row id="junk" label="Junk" n={data?.junk ?? 0}
        active={selected.junk}
        onClick={() => onSelect({ label: null, junk: true })} />
    </div>
  )
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd client && npx tsc --noEmit && cd ..`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/LabelSidebar.tsx
git commit -m "feat: LabelSidebar with live counts + selection"
```

---

## Task 9: Frontend — rewire DirectoryView (sidebar, columns, filters, bulk labeling)

**Files:**
- Modify: `client/src/components/DirectoryView.tsx`

- [ ] **Step 1: Replace the file**

Replace the entire contents of `client/src/components/DirectoryView.tsx` with:

```tsx
import { useEffect, useState, useCallback } from 'react'
import type { DirectoryContact, FilterSpec } from '../types'
import { fetchDirectory, bulkLabelDirectory, fetchLabels } from '../api'
import { DirectoryDetailPanel } from './DirectoryDetailPanel'
import { AdvancedFilterPanel } from './AdvancedFilterPanel'
import { LabelSidebar, type LabelSelection } from './LabelSidebar'

export function DirectoryView() {
  const [rows, setRows] = useState<DirectoryContact[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<FilterSpec | undefined>()
  const [showFilters, setShowFilters] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState<LabelSelection>({ label: null, junk: false })
  const [version, setVersion] = useState(0)
  const [allLabels, setAllLabels] = useState<string[]>([])
  const pageSize = 50

  useEffect(() => { fetchLabels().then(setAllLabels) }, [])

  const load = useCallback(() => {
    fetchDirectory({
      search,
      filters,
      label: sel.label || undefined,
      only_junk: sel.junk || undefined,
      page,
      pageSize,
    }).then(r => { setRows(r.contacts); setTotal(r.total) })
  }, [search, filters, sel, page])

  useEffect(() => { load() }, [load])

  function toggle(id: string) {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function bumpCounts() { setVersion(v => v + 1) }

  async function applyBulkLabel(label: string, mode: 'add' | 'remove') {
    const ids = Array.from(checked)
    if (!ids.length || !label) return
    await bulkLabelDirectory(ids, mode === 'add' ? [label] : [], mode === 'remove' ? [label] : [])
    setChecked(new Set()); load(); bumpCounts()
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
      <LabelSidebar
        selected={sel}
        version={version}
        onSelect={s => { setPage(1); setSel(s); setSelectedId(null) }}
      />

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
            <select defaultValue="" onChange={e => { applyBulkLabel(e.target.value, 'add'); e.target.value = '' }}
              className="bg-[#0f0f1a] border border-white/10 rounded px-2 py-1 text-slate-200 text-xs">
              <option value="">+ Add label…</option>
              {allLabels.filter(l => l !== 'uncategorized').map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <select defaultValue="" onChange={e => { applyBulkLabel(e.target.value, 'remove'); e.target.value = '' }}
              className="bg-[#0f0f1a] border border-white/10 rounded px-2 py-1 text-slate-200 text-xs">
              <option value="">− Remove label…</option>
              {allLabels.filter(l => l !== 'uncategorized').map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <button onClick={exportCsv} className="text-slate-200 hover:text-white">Export CSV</button>
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
                <th className="p-3">Tags</th>
                <th className="p-3">Street Address</th>
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
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1">
                      {r.categories.filter(c => c !== 'uncategorized').map(c => (
                        <span key={c} className="px-2 py-0.5 rounded-full bg-white/10 text-slate-300 text-xs">{c}</span>
                      ))}
                      {r.categories.filter(c => c !== 'uncategorized').length === 0 && <span className="text-slate-600">—</span>}
                    </div>
                  </td>
                  <td className="p-3 text-slate-400">{r.address || '—'}</td>
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
      {selectedId && (
        <DirectoryDetailPanel
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => { load(); bumpCounts() }}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd client && npx tsc --noEmit && cd ..`
Expected: one error — `DirectoryDetailPanel` does not yet accept `onChanged`. That is fixed in Task 10. If any *other* error appears, fix it before continuing.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/DirectoryView.tsx
git commit -m "feat: contacts tab sidebar, simplified columns, label filter + bulk labeling"
```

---

## Task 10: Frontend — DirectoryDetailPanel label editing + street address

**Files:**
- Modify: `client/src/components/DirectoryDetailPanel.tsx`

- [ ] **Step 1: Replace the file**

Replace the entire contents of `client/src/components/DirectoryDetailPanel.tsx` with:

```tsx
import { useEffect, useState } from 'react'
import type { DirectoryContactDetail } from '../types'
import { fetchDirectoryContact, patchDirectoryContact } from '../api'
import { LabelEditor } from './LabelEditor'

export function DirectoryDetailPanel({ id, onClose, onChanged }: {
  id: string
  onClose: () => void
  onChanged?: () => void
}) {
  const [c, setC] = useState<DirectoryContactDetail | null>(null)
  useEffect(() => { fetchDirectoryContact(id).then(setC) }, [id])

  async function setLabels(next: string[]) {
    if (!c) return
    const categories = next.length ? next : ['uncategorized']
    setC({ ...c, categories })
    await patchDirectoryContact(id, { categories })
    onChanged?.()
  }

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
        {c.address && <div className="text-slate-400">{c.address}</div>}

        <div>
          <div className="text-[10px] font-bold tracking-widest text-slate-500 uppercase mb-2">Tags / Labels</div>
          <LabelEditor value={c.categories} onChange={setLabels} />
        </div>

        {c.tags.length > 0 && (
          <div className="text-slate-400 text-xs">GHL tags: {c.tags.join(', ')}</div>
        )}

        <div className="border-t border-white/10 pt-3">
          <div className="text-[10px] font-bold tracking-widest text-slate-500 uppercase mb-2">Pipelines &amp; Opportunities</div>
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

- [ ] **Step 2: Verify the whole client compiles**

Run: `cd client && npx tsc --noEmit && cd ..`
Expected: no type errors (the Task 9 `onChanged` error is now resolved).

- [ ] **Step 3: Commit**

```bash
git add client/src/components/DirectoryDetailPanel.tsx
git commit -m "feat: edit labels + show street address in contact detail panel"
```

---

## Task 11: End-to-end verification + live recompute

**Files:** none (verification + data operation)

- [ ] **Step 1: Build the client and start the app**

Run: `cd client && npm run build && cd .. && npm run dev`
Expected: client builds with no errors; server logs `[DB] PostgreSQL connected` and `WIH App running on port 3001`.

- [ ] **Step 2: Manual walkthrough**

Open `http://localhost:3001`, go to the Contacts/Directory tab, and confirm:
- Columns are Name · Phone · Email · Tags · Street Address.
- Left sidebar lists labels with counts; clicking "Uncategorized" filters to ~the uncategorized set; clicking "Junk" shows junk rows; "All" shows the non-junk total.
- Search by a known name returns the contact.
- Open Advanced Filters, add a condition (e.g. `city` contains `Lubbock`), Apply — list narrows.
- Select 2–3 rows, "+ Add label… → pml" — rows get the label, sidebar `pml` count rises.
- Select the same rows, "− Remove label… → pml" — label removed, count drops back.
- Click a contact: detail panel shows street address, a Tags/Labels editor; add/remove a label there and confirm it persists on reload.

- [ ] **Step 3: Run the recompute dry-run, then live**

Stop `npm run dev` first (the script opens its own pool).

Run: `npm run recategorize:dry`
Expected: `before` vs `would-be after` counts printed. Confirm `junk`/`uncat` numbers look sane (junk in the ~1,400–1,600 range; uncat ~11,900). If they look right:

Run: `npm run recategorize`
Expected: `LIVE complete, 14206 rows updated`.

- [ ] **Step 4: Clean up the throwaway diagnostic scripts**

Run: `git rm scripts/analyze-uncategorized.js scripts/check-signal-fields.js; git rm --cached scripts/check-directory.js 2>$null`
(Keep `scripts/check-directory.js` on disk as a handy read-only health check but untrack it, or delete it too if you prefer — your call.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: contacts CRM verified end-to-end; recompute applied; remove scratch scripts"
```

---

## Self-Review Notes

- **Spec coverage:** junk pass + recompute (Tasks 1–2, 11), multi-label as Tags (Tasks 1,5,7,9,10), label sidebar with counts incl. Uncategorized/Junk (Tasks 4,8,9), columns Name/Phone/Email/Tags/Street Address (Tasks 3,6,9), single + bulk labeling (Tasks 5,9,10), advanced filtering across all fields + label filter (Tasks 3,9, existing panel), junk hidden by default (Tasks 3,9). Out-of-scope items (auto-enrich, AI categorization, GHL sync, custom columns, label management) are intentionally not tasked.
- **Type consistency:** `bulkLabelDirectory(ids, add, remove)` matches the `/bulk-label { ids, add, remove }` endpoint; `LabelSelection { label, junk }` is shared by DirectoryView/LabelSidebar; `fetchDirectory` param names (`label`, `only_junk`) match the route's `req.query.label` / `req.query.only_junk`; `DirectoryContact.address` added in Task 6 is consumed in Task 9 and returned by the SELECT in Task 3.
- **No placeholders:** every code step contains full code; every verify step has a runnable command and expected output.
```
