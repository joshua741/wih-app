# Contacts CRM Tab — Categorization & Global Rolodex

**Date:** 2026-06-03
**Status:** Approved design — ready for implementation plan
**Owner:** Joshua

---

## Purpose

Turn the existing Contacts Directory into a true standalone CRM: one global place where
every person we work with lives, searchable and filterable by anything, with multi-label
tagging for who each person is to us. Think "the contacts list in your phone, but far more
powerful." It is **not** integrated with GoHighLevel — the 14,206 contacts already in
Supabase are a one-time snapshot, and this feature operates entirely on that local data.

## Background / current state

- `directory_contacts` in Supabase holds **14,206** contacts (13,058 with usable phones).
- The original importer categorized only the records that carried a usable tag or filled
  GHL form field. **11,967 (84%) are `uncategorized`** because they have no lead-type
  signal at all: 10,864 have zero tags; the tags that exist are phone-system junk
  (landline ×903, "name via lookup" ×80, "couldn't find caller name" ×109); and the
  GHL form fields that would indicate lead type ("Asking Price", "Program Interest",
  "What type of real estate service…", "Lenders Name") are empty for these rows.
- **Conclusion:** these contacts cannot be auto-categorized — there is nothing to classify
  on. AI classification would only mislabel them and waste credits. They are genuinely
  "uncategorized" and get labeled by hand over time, or automatically later as they engage
  and supply data. The deliverable is therefore **CRM tooling for fast manual labeling +
  junk cleanup**, not a one-time auto-categorization job.

## Core model

- **Labels are tags, not pipeline stages.** A contact wears as many labels as apply
  (e.g. seller + PML + contractor). This is independent of pipelines/opportunity stages,
  which are a separate system this feature does not touch.
- **Multi-label storage:** the curated lead-type labels live in `directory_contacts.categories[]`
  (already exists). The UI surfaces this array as **"Tags."** The original GHL free-form
  tags in `directory_contacts.tags[]` are preserved, shown in the detail view, and remain
  filterable. The legacy singular `category` column is treated as derived (first element of
  `categories[]`) for back-compat and is no longer the primary concept; it is not removed in
  this pass.
- **Today's label set (kept as-is, extensible later):** buyer, seller, rto_tenant,
  cash_buyer, pml, wholesaler, title_agent, insurance_agent, contractor, realtor, team,
  uncategorized. Adding/renaming labels later is a small change; a label-management UI is
  out of scope now.

## Components

### 1. Junk + recompute pass (backend, in place)
- Expand junk rules in `src/lib/categorize.ts` to flag obvious non-leads: `landline`,
  `name via lookup`, `couldn't find caller name`, `spam likely`, `dead number`, plus the
  existing "no name and no email" rule.
- Pick up the last few records that *do* have signal (e.g. the 8 with a "Possible Exit
  Strategy" value) by extending the field-cluster rules.
- A **recompute script** (`src/db/recategorize.ts`) re-derives `categories[]` and `is_junk`
  for every existing row **from the stored `data` JSONB** — no CSV re-import, no GHL call.
  - Supports `--dry-run` that reports how counts would shift (junk before/after, labeled
    before/after, per-label deltas) without writing.
  - Live run updates rows in batches and prints the new breakdown.
- Idempotent: running it twice yields the same result.

### 2. Directory API (extend `src/routes/directory.ts`)
- **Label counts endpoint** — `GET /api/directory/label-counts`: returns count per label,
  plus `uncategorized` and `junk` totals, for the sidebar. Honors the same
  include-junk semantics as the list.
- **Bulk un-label** — extend bulk operations so a set of contacts can have a label
  **removed** (today only add exists). Add/remove both operate on `categories[]`.
- **Single-contact label + field edit** — the existing `PATCH /contacts/:id` already allows
  `categories`, `tags`, and the basic fields; confirm it round-trips `categories[]` cleanly.
- Verify advanced filtering (`filterSpec` → SQL) covers core columns *and* arbitrary GHL
  `data` keys, and add the ability to filter by a label (membership in `categories[]`).

### 3. Contacts tab UI (enhance `client/src/components/DirectoryView.tsx`)
- **Columns:** Name · Phone · Email · Tags · Street Address. Tags render as chips from
  `categories[]`. (Replaces today's Category + City/State columns. Column configurability is
  a later feature; the five are hardcoded for now.)
- **Left label sidebar** with live counts: All · each label · Uncategorized (the inbox) ·
  Junk. Selecting one filters the table. Counts come from the label-counts endpoint.
- **Search** (name/phone/email) and **Advanced Filters** across all fields — keep the existing
  panel; ensure it filters on every available field and add label filtering.
- **In-app labeling:**
  - Bulk: with rows selected, add or remove one or more labels.
  - Single: in the detail panel, edit labels (multi-select add/remove) and the basic fields
    (name, phone, email, street address).
- **Detail/profile panel** (`DirectoryDetailPanel`): show the richer field set and the GHL
  `tags[]`, plus the label editor. Keep the existing pipeline cross-reference.
- **Junk** is hidden by default with a toggle to reveal it.

## Data flow

1. One-time: run the recompute script (dry-run → review → live) to refresh `categories[]`
   and `is_junk` across the 14,206 rows from stored data.
2. Ongoing (manual): user opens the Contacts tab → filters/searches → selects contacts →
   adds/removes labels (bulk or single). The sidebar counts update.
3. Future (separate SMS build): inbound conversations dedupe against this table and enrich
   records (real name, interested-property address) automatically. Schema already supports
   this; not built here.

## Error handling

- Recompute script: per-batch try/catch with progress logging; a failed batch aborts with a
  clear message and the run can be re-executed safely (idempotent). Dry-run never writes.
- API: parameterized SQL throughout (existing pattern); 400 on bad filter/label input,
  validate label values against the known set before writing.
- UI: failed label edits surface an inline error and revert optimistic state; no silent loss.

## Testing

- **Unit** (`src/lib/categorize.test.ts`, extend): new junk tags flagged; multi-label
  assignment (a row matching two clusters lands in both); idempotency of categorize().
- **Recompute dry-run** against live data: read-only, confirms count shifts look right
  (junk rises by ~the landline/lookup volume, labeled count unchanged or slightly up) before
  any write.
- **Manual app walkthrough**: columns correct; sidebar counts match DB; bulk add/remove
  label persists and updates counts; single-contact edit persists; advanced filter returns
  expected rows; junk hidden by default.

## Out of scope (designed-for, built later)

- Auto-enrichment on inbound conversations (rides with the Vince/SMS build).
- AI auto-categorization (no signal in the data — would mislabel).
- Live GHL→Supabase sync (snapshot is intentional for now).
- Custom/editable column chooser and label-management UI.
- Any change to pipelines, opportunity stages, or the SMS automation.
