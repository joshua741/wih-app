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
