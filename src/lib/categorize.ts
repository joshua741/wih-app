export type Category =
  | 'buyer' | 'seller' | 'rto_tenant' | 'cash_buyer' | 'pml' | 'wholesaler'
  | 'title_agent' | 'insurance_agent' | 'contractor' | 'realtor' | 'team'
  | 'uncategorized';

export const ALL_CATEGORIES: Category[] = [
  'buyer', 'seller', 'rto_tenant', 'cash_buyer', 'pml', 'wholesaler',
  'title_agent', 'insurance_agent', 'contractor', 'realtor', 'team', 'uncategorized',
];

export interface CategoryResult {
  category: Category;
  categories: Category[];
  isJunk: boolean;
}

export function cleanTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw.split(',')) {
    const v = t.trim().toLowerCase();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

// Exact-match tag -> category.
const TAG_MAP: Record<string, Category> = {
  'rent to own buyer': 'rto_tenant',
  'under contract rent to own buyer': 'rto_tenant',
  'rto facebook ad lead': 'rto_tenant',
  'intro call rent to own': 'rto_tenant',
  'tenant client': 'rto_tenant',
  'tenant prospect': 'rto_tenant',
  'seller leads': 'seller',
  'seller': 'seller',
  'speed to lead seller new': 'seller',
  'seller finance buyer': 'buyer',
  'insurance agent': 'insurance_agent',
  'insurance-agent': 'insurance_agent',
  'pml': 'pml',
  'first time lender': 'pml',
  'active lender': 'pml',
  'under minimum pml': 'pml',
  'wholesaler': 'wholesaler',
  'investor': 'cash_buyer',
  'fix and flip': 'cash_buyer',
  'handymen': 'contractor',
  'plumber': 'contractor',
  'painter': 'contractor',
  'roofer': 'contractor',
  'home inspector': 'contractor',
  'garage door repair': 'contractor',
  'lubbock contractor': 'contractor',
  'amarillo contractor': 'contractor',
  'lubbock agent': 'realtor',
  'team': 'team',
};

const JUNK_TAGS = new Set([
  'landline', 'spam likely', 'dead number', "couldn't find caller name",
  'name via lookup', 'ghost', 'dnd', 'wrong number', 'disconnected',
]);

// Field clusters: if any of these keys is non-empty -> category.
const FIELD_CLUSTERS: { category: Category; fields: string[] }[] = [
  { category: 'rto_tenant', fields: ['Rent to Own Monthly Payment', 'Rent to Own Address', 'RTO Full Address'] },
  { category: 'title_agent', fields: ['Name of Title Company', 'Escrow Officer / Closing Attorney Name'] },
  { category: 'pml', fields: ['Lenders Name', 'PML Notes', 'Capital Amount'] },
  { category: 'insurance_agent', fields: ['Insurance Agents Name', 'Our Insurance Agent Name'] },
  { category: 'buyer', fields: ['Max Amount Per Month ($)', 'Credit Score Range', 'Program Interest'] },
  { category: 'seller', fields: ['How Soon Are You Looking To Sell?', 'Asking Price'] },
];

// Field VALUE -> category (lowercased exact match on the cell's value).
const VALUE_RULES: { field: string; map: Record<string, Category> }[] = [
  { field: 'Possible Exit Strategy', map: {
    'wholesale (sub 2)': 'seller',
    'wholesale (cash)': 'seller',
    'wholesale (seller finance)': 'seller',
    'in house (rent to own)': 'rto_tenant',
  } },
];

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' ? v.trim().length > 0 : v != null;
}

export function categorize(row: Record<string, string>, tags: string[]): CategoryResult {
  const cats: Category[] = [];
  const add = (c: Category) => { if (!cats.includes(c)) cats.push(c); };

  // 1. Tags first
  for (const t of tags) {
    const c = TAG_MAP[t];
    if (c) add(c);
  }
  // 2. Field clusters
  for (const cluster of FIELD_CLUSTERS) {
    if (cluster.fields.some(f => nonEmpty(row[f]))) add(cluster.category);
  }

  // 3. Field value rules
  for (const vr of VALUE_RULES) {
    const v = (row[vr.field] || '').trim().toLowerCase();
    const mapped = v ? vr.map[v] : undefined;
    if (mapped) add(mapped);
  }

  const category: Category = cats[0] ?? 'uncategorized';

  // Junk: any junk tag, OR no name and no email.
  const hasName = nonEmpty(row['First Name']) || nonEmpty(row['Last Name']);
  const hasEmail = nonEmpty(row['Email']);
  const isJunk = tags.some(t => JUNK_TAGS.has(t)) || (!hasName && !hasEmail);

  return { category, categories: cats.length ? cats : ['uncategorized'], isJunk };
}
