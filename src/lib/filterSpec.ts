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
