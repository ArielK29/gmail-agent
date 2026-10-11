// Shared test helpers: a small in-memory database that speaks the part of the Supabase client the agent uses
// (select / insert / update / upsert / delete with eq, in, lt, lte, gt, gte, is, or, order, limit, maybeSingle, and
// `.select()` after a write), with failures that can be injected per table and action. Test code only.
export type Row = Record<string, any>;

type Action = 'select' | 'insert' | 'update' | 'upsert' | 'delete';

const UPSERT_KEYS: Record<string, string[]> = {
  gmail_digest: ['user_id', 'gmail_message_id'],
  gmail_usage: ['user_id', 'day'],
  gmail_scan_hits: ['scan_id', 'gmail_message_id'],
};
const DEFAULTS: Record<string, () => Row> = {
  gmail_scans: () => ({ status: 'queued', listed: false, total: 0, processed: 0, pending_ids: [], claimed_until: null, error: null, finished_at: null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 86400000).toISOString() }),
};

export function makeDb(tables: Record<string, Row[]>, failing: Record<string, any> = {}) {
  const writes: string[] = [];
  const db = {
    tables,
    writes,
    failing,
    from(name: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let action: Action = 'select';
      let payload: any;
      let options: any;
      let order: { column: string; ascending: boolean } | null = null;
      let limit = Infinity;
      let returning = false;

      const compare = (a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0);
      const orClause = (text: string) => {
        const parts = text.split(',').map((part) => {
          const [column, op, ...rest] = part.split('.');
          const value = rest.join('.');
          return (row: Row) => {
            if (op === 'is') return value === 'null' ? row[column] == null : row[column] === value;
            if (op === 'lt') return row[column] != null && compare(row[column], value) < 0;
            if (op === 'eq') return String(row[column]) === value;
            throw new Error('fake db: unsupported or() clause ' + part);
          };
        });
        return (row: Row) => parts.some((test) => test(row));
      };

      const run = () => {
        const table = (tables[name] ??= []);
        const key = `${name}.${action}`;
        if (failing[key]) return { data: null, error: typeof failing[key] === 'object' ? failing[key] : { message: 'fake failure ' + key } };
        let selected: Row[] = [];
        if (action === 'select') {
          selected = table.filter((row) => filters.every((f) => f(row)));
        } else {
          writes.push(key);
          if (action === 'insert') {
            for (const item of [].concat(payload)) {
              const row = { ...(DEFAULTS[name]?.() ?? {}), ...item };
              table.push(row);
              selected.push(row);
            }
          } else if (action === 'update') {
            for (const row of table) if (filters.every((f) => f(row))) { Object.assign(row, payload); selected.push(row); }
          } else if (action === 'delete') {
            for (let i = table.length - 1; i >= 0; i--) if (filters.every((f) => f(table[i]))) selected.push(...table.splice(i, 1));
          } else if (action === 'upsert') {
            const keys = String(options?.onConflict ?? '').split(',').filter(Boolean).length ? String(options.onConflict).split(',') : UPSERT_KEYS[name] ?? [];
            for (const item of [].concat(payload)) {
              const existing = table.find((row) => keys.every((column) => row[column] === item[column]));
              if (existing) { Object.assign(existing, item); selected.push(existing); } else { const row = { ...(DEFAULTS[name]?.() ?? {}), ...item }; table.push(row); selected.push(row); }
            }
          }
        }
        if (order) selected = [...selected].sort((a, b) => (order!.ascending ? 1 : -1) * compare(a[order!.column], b[order!.column]));
        selected = selected.slice(0, limit).map((row) => JSON.parse(JSON.stringify(row)));
        return { data: action === 'select' || returning ? selected : null, error: null };
      };

      const builder: any = {
        select: () => { if (action !== 'select') returning = true; return builder; },
        insert: (value: any) => ((action = 'insert'), (payload = value), builder),
        update: (value: Row) => ((action = 'update'), (payload = value), builder),
        upsert: (value: any, opts?: any) => ((action = 'upsert'), (payload = value), (options = opts), builder),
        delete: () => ((action = 'delete'), builder),
        eq: (column: string, value: any) => (filters.push((row) => row[column] === value), builder),
        in: (column: string, values: any[]) => (filters.push((row) => values.includes(row[column])), builder),
        lt: (column: string, value: any) => (filters.push((row) => row[column] != null && compare(row[column], value) < 0), builder),
        lte: (column: string, value: any) => (filters.push((row) => row[column] != null && compare(row[column], value) <= 0), builder),
        gt: (column: string, value: any) => (filters.push((row) => row[column] != null && compare(row[column], value) > 0), builder),
        gte: (column: string, value: any) => (filters.push((row) => row[column] != null && compare(row[column], value) >= 0), builder),
        is: (column: string, value: any) => (filters.push((row) => (value === null ? row[column] == null : row[column] === value)), builder),
        or: (text: string) => (filters.push(orClause(text)), builder),
        order: (column: string, opts?: { ascending?: boolean }) => ((order = { column, ascending: opts?.ascending !== false }), builder),
        limit: (n: number) => ((limit = n), builder),
        maybeSingle: () => {
          const result: any = run();
          return Promise.resolve({ data: result.data?.[0] ?? null, error: result.error });
        },
        then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
  };
  return db;
}

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
