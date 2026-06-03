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
