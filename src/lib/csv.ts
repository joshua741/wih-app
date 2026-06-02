// Minimal RFC-4180 parser. Handles quoted fields, embedded commas/newlines,
// and escaped double-quotes ("").
export function parseCsv(s: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; } else { q = false; }
      } else { cur += c; }
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// Parse into array of objects keyed by header row.
export function parseCsvObjects(s: string): Record<string, string>[] {
  const rows = parseCsv(s);
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1)
    .filter(r => r.length > 1)
    .map(r => {
      const o: Record<string, string> = {};
      header.forEach((h, i) => { o[h] = r[i] ?? ''; });
      return o;
    });
}
