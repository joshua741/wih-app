import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { pool } from './pool';

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  console.log('[MIGRATE] Running schema...');
  await pool.query(sql);
  console.log('[MIGRATE] Done.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('[MIGRATE] Failed:', err);
  process.exit(1);
});
