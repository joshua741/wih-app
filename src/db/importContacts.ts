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
