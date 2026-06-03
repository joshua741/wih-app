import { Router } from 'express';
import { pool } from '../db/pool';
import { normalizePhone } from '../lib/normalize';
import { buildFilterSql, FilterSpec } from '../lib/filterSpec';
import { ALL_CATEGORIES } from '../lib/categorize';

export const directoryRouter = Router();

// GET /api/directory/contacts — paginated list with search + filters
directoryRouter.get('/contacts', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.pageSize || '50'), 10)));
    const search = String(req.query.search || '').trim();

    const where: string[] = [];
    const params: unknown[] = [];
    let n = 1;

    const includeJunk = String(req.query.include_junk || '') === 'true';
    const onlyJunk = String(req.query.only_junk || '') === 'true';
    const category = String(req.query.category || '').trim();
    const label = String(req.query.label || '').trim();

    if (onlyJunk) where.push('is_junk = TRUE');
    else if (!includeJunk) where.push('is_junk = FALSE');

    if (category) { where.push(`category = $${n++}`); params.push(category); }
    if (label) { where.push(`$${n++} = ANY(categories)`); params.push(label); }
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
      `SELECT id, ghl_contact_id, full_name, phone, email, business_name, address, city, state,
              postal_code, category, categories, tags, is_junk, promoted_to_pipeline
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
    const promotedIds: string[] = [];
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
      if ((ins.rowCount ?? 0) > 0) { promoted++; promotedIds.push(c.id); } else skipped++;
    }
    if (promotedIds.length) {
      await pool.query(
        `UPDATE directory_contacts SET promoted_to_pipeline = TRUE WHERE id = ANY($1)`, [promotedIds]
      );
    }
    res.json({ promoted, skipped });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
