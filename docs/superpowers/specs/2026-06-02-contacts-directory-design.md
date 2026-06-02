# Contacts Directory — Design Spec

**Date:** 2026-06-02
**Project:** WIH Acquisitions (wih-app)
**Status:** Awaiting approval

---

## Overview

A dedicated **Contacts Directory** inside wih-app: the single master home for every
contact in the business, deliberately walled off from the deal/opportunity pipelines.
It loads the full 16,360-contact GHL export, dedupes it, organizes it best-effort by
category, and exposes it through a searchable, advanced-filterable section in the app.
A one-way **promote** action lets a contact be pushed into a pipeline when they become a
real opportunity — but the directory and the pipelines never blend automatically.

## Goals

- One place where **all** contacts live, viewable in the app and in Supabase.
- Fast lookup: "is this person already ours?" by name, phone, or email.
- Best-effort categorization (buyer, seller, RTO tenant, title agent, insurance agent,
  cash buyer, PML, wholesaler) — **uncategorized is an acceptable resting state**.
- Advanced filter on **any** field, with multi-select → export → promote/tag.
- Each contact shows whether they're already active in a pipeline/opportunity.
- Data physically stored in **Supabase** (dashboard, backups), reflected live in the app.

## Non-Goals

- Not modifying or merging into the existing pipeline `contacts` table.
- Not auto-syncing GHL going forward (this is a one-time import; re-import is idempotent).
- Not building the meeting-reminder skill (separate, paused effort).
- Not perfect categorization — the source data doesn't support it (see Data Reality).

## Data Reality (why the design is shaped this way)

From profiling the export (16,360 rows, 419 columns):
- 91% have a phone, 39% have an email, 1.1% have neither.
- **Tags cover only 11%** and are inconsistent (`insurance agent` vs `insurance-agent`).
- `Contact Type` is useless — 16,323 of 16,360 are `lead`.
- Dedicated category fields are nearly empty: PML Notes = 0, Capital Amount = 0,
  insurance ~5, title ~41, RTO ~127, wholesaler ~10. Only seller "Asking Price" (1,991)
  is meaningfully populated.
- The bulk is a cold-outreach phone list (1,044 `landline`, plus `spam likely`,
  `couldn't find caller name`, `name via lookup`).

Conclusion: most contacts will land `uncategorized` and that is expected and fine.

## Datastore Decision

- **Supabase Postgres ("WIH Acquisitions") becomes the database for the whole app.**
  Railway continues to **host the app**; the app connects to Supabase via `DATABASE_URL`.
- The Supabase DB is currently **empty** (fresh), so the full app schema
  (`src/db/schema.sql`) is created there, plus the new directory table. No existing
  pipeline data to migrate.
- `src/db/pool.ts` must enable SSL for remote hosts (Supabase requires SSL), not only
  when `NODE_ENV=production`.

## Database — new `directory_contacts` table

Fully isolated from pipeline tables. Lookup-first columns + a JSONB vault for all 419
original fields so nothing is ever lost.

```
directory_contacts
  id                    UUID PK default uuid_generate_v4()
  ghl_contact_id        TEXT UNIQUE            -- import idempotency key
  first_name            TEXT
  last_name             TEXT
  full_name             TEXT
  phone                 TEXT                   -- display form
  phone_normalized      TEXT                   -- digits only, match key
  email                 TEXT
  email_lower           TEXT                   -- match key
  business_name         TEXT
  address               TEXT
  city                  TEXT
  state                 TEXT
  postal_code           TEXT
  category              TEXT default 'uncategorized'   -- primary, best-effort
  categories            TEXT[] default '{}'            -- can be multiple
  tags                  TEXT[] default '{}'            -- cleaned tags
  is_junk               BOOLEAN default FALSE          -- landline/spam/no-name
  promoted_to_pipeline  BOOLEAN default FALSE
  data                  JSONB default '{}'             -- full original GHL row
  created_at            TIMESTAMPTZ default NOW()
  updated_at            TIMESTAMPTZ default NOW()
```

Indexes:
- `phone_normalized`, `email_lower` (B-tree) — identity lookup
- trigram index on `full_name` (`pg_trgm`) — fuzzy name search ("Josh" → "Joshua")
- GIN on `tags` — tag filtering
- GIN on `data` (jsonb_path_ops) — **filter on any field**
- B-tree on `category`

Category vocabulary (controlled list):
`buyer`, `seller`, `rto_tenant`, `cash_buyer`, `pml`, `wholesaler`, `title_agent`,
`insurance_agent`, `contractor`, `realtor`, `team`, `uncategorized`.

## Import & Categorization (`src/db/importContacts.ts`)

One-time, idempotent importer run like the existing `migrate` script
(`npm run import-contacts`). Reads the CSV from a configurable path.

Pipeline per row:
1. **Parse** with an RFC-4180-correct reader (handles quoted multi-line fields).
2. **Normalize** phone (strip to digits, keep last 10 for US match) and email (lowercase).
3. **Dedup** by `phone_normalized` OR `email_lower`. On collision, **keep the record with
   the most populated fields** (highest non-empty field count); merge tags.
4. **Categorize** (best-effort, priority order):
   a. Clean + map tags → category (e.g. `rent to own buyer` → `rto_tenant`,
      `insurance agent`/`insurance-agent` → `insurance_agent`, `pml` → `pml`,
      `seller leads`/`seller` → `seller`, `wholesaler` → `wholesaler`).
   b. Else infer from populated field-clusters (RTO fields → `rto_tenant`,
      title/escrow fields → `title_agent`, lender fields → `pml`,
      seller questionnaire → `seller`, etc.).
   c. Else `uncategorized`.
   Multiple signals → populate `categories[]`; pick a sensible `category` primary.
5. **Flag junk**: tag-based (`landline`, `spam likely`, `dead number`,
   `couldn't find caller name`, `name via lookup`) and no-name rows → `is_junk = true`.
6. **Store** the full original row in `data` JSONB; batch-insert (e.g. 500/batch),
   `ON CONFLICT (ghl_contact_id) DO UPDATE`.

Output a summary: rows read, deduped, inserted, per-category counts, junk count.

## API (server, `src/routes/`)

New router `directory.ts`, mounted under `/api/directory`:
- `GET /contacts` — paginated list. Query params: `search` (name/phone/email),
  `filters` (JSON filter spec), `category`, `include_junk`, `page`, `pageSize`,
  `sort`. Returns rows + total count.
- `GET /contacts/:id` — full detail incl. `data`, plus **pipeline cross-reference**:
  match `phone_normalized`/`email_lower` against the pipeline `contacts` table and
  return any pipeline/stage/deal involvement.
- `POST /contacts` — manually add a contact to the directory.
- `PATCH /contacts/:id` — edit fields / set category / tags.
- `GET /fields` — list of filterable fields (core columns + known GHL field keys) with
  type hints, to drive the filter builder UI.
- `POST /export` — given a filter spec or explicit id list, stream a CSV download.
- `POST /promote` — given id list + target `pipeline` + `stage`, create pipeline
  `contacts` rows and set `promoted_to_pipeline = true` here. Skips already-promoted.
- `POST /bulk-tag` — apply tags / set category on a selected set.

## Advanced Filter

A **filter builder**: each condition = `{ field, operator, value }`, combined with
AND/OR.
- Operators: `is`, `is not`, `contains`, `is empty`, `is not empty`,
  `>`, `<`, `between` (numbers/dates).
- Fields: core columns + any key inside `data` JSONB (so genuinely every field is
  filterable, backed by the GIN index).
- Server translates the spec to parameterized SQL (core columns directly; JSONB fields
  via `data->>'Field Name'`). Always parameterized — no string interpolation of values.
- Filters drive the list, the count badge, export, and "select all matching".

## App UI (`client/src`)

- **Navigation:** introduce a top-level view mode beyond `Pipeline`. Sidebar gets a
  visually separated **DIRECTORY** group (divider + label) with a "Contacts" item, so it
  reads as a distinct area, not a fourth pipeline. Selecting it swaps the main view from
  `KanbanBoard` to the new `DirectoryView`.
- **DirectoryView:** top search bar (name/phone/email) + "Filters" button opening the
  advanced filter panel; a paginated **table** (Name, Phone, Email, Category, City/State,
  Tags, pipeline badge); row checkboxes + "select all matching"; a bulk-action bar
  (Export, Promote, Tag/Categorize) when rows are selected; an "Add Contact" button.
- **DirectoryDetailPanel:** reuses the side-panel pattern of `LeadPanel`. Shows grouped
  fields, all `data`, editable category/tags, and a **"Pipelines & Opportunities"**
  section showing cross-reference results.
- Styling matches existing Tailwind dark theme (`#0f0f1a` / `#1a1a2e`, purple accents).

## Build Order (phased)

1. **Foundation:** SSL fix in `pool.ts`; create full schema (incl.
   `directory_contacts`) in Supabase; importer script; load all 16,360 contacts.
2. **Read + view:** directory API (`GET /contacts`, `/contacts/:id`, `/fields`) + Sidebar
   nav + `DirectoryView` table + search + detail panel + pipeline cross-reference.
3. **Advanced filter:** filter builder UI + server filter translation.
4. **Bulk actions:** multi-select + export (CSV) + promote-to-pipeline + bulk tag/category
   + manual Add Contact.

## Edge Cases & Guardrails

- Contacts with neither phone nor email (176) still import; dedup falls back to name+row.
- Promote must not create duplicate pipeline contacts (pipeline `contacts.phone` is
  UNIQUE) — upsert/skip on conflict and report.
- Re-running the importer must not duplicate rows (idempotent on `ghl_contact_id`).
- JSONB filter values always parameterized (no SQL injection).
- Junk rows hidden by default in the UI but never deleted; toggle to include.
- Secrets stay in `.env` (gitignored); never commit the Supabase password.

## Open Items

- Confirm category vocabulary above is acceptable.
- Existing Railway DB data (if any real pipeline data exists there) is **not** migrated;
  Supabase starts fresh. Flag if there's production data to bring over.
