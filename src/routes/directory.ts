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
