// tests/helpers/bank-connections-fake.js
// bank_api_connections / bank_api_audit_logs 用のメモリ上の簡易 supabase フェイク。
// 対応: from().select().insert().update() + eq / is / not(col,'is',null) / or('a.not.is.null,b.not.is.null')
//       / order / limit / maybeSingle / single / await（thenable）

const tables = {};

function reset() { for (const k of Object.keys(tables)) delete tables[k]; }
function seed(rows, table = 'bank_api_connections') { tables[table] = rows.map(r => ({ ...r })); }
function rows(table) { return tables[table] || []; }

function parseOr(expr) {
  return String(expr).split(',').map(part => {
    const m = part.match(/^([a-z_]+)\.not\.is\.null$/);
    if (!m) throw new Error(`fake: unsupported or() ${part}`);
    return (r) => r[m[1]] != null;
  });
}

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.op = 'select';
    this.payload = null;
    this.mode = 'many';
    this.limitN = null;
  }
  select() { if (this.op === 'select') this.op = 'select'; this.returning = true; return this; }
  insert(row) { this.op = 'insert'; this.payload = row; return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  eq(c, v) { this.filters.push(r => r[c] === v); return this; }
  is(c, v) { this.filters.push(r => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c, op, v) {
    if (op !== 'is' || v !== null) throw new Error('fake: unsupported not()');
    this.filters.push(r => r[c] != null); return this;
  }
  or(expr) { const ors = parseOr(expr); this.filters.push(r => ors.some(f => f(r))); return this; }
  order() { return this; }
  limit(n) { this.limitN = n; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  single() { this.mode = 'single'; return this; }
  run() {
    const list = tables[this.table] || (tables[this.table] = []);
    if (this.op === 'insert') {
      const r = { id: `log${list.length + 1}`, ...this.payload };
      list.push(r);
      return this.shape([r]);
    }
    let matched = list.filter(r => this.filters.every(f => f(r)));
    if (this.op === 'update') {
      for (const r of matched) Object.assign(r, this.payload);
    }
    if (this.limitN != null) matched = matched.slice(0, this.limitN);
    return this.shape(matched.map(r => ({ ...r })));
  }
  shape(list) {
    if (this.mode === 'many') return { data: list, error: null };
    if (this.mode === 'single' && list.length !== 1) return { data: null, error: { message: 'not single' } };
    return { data: list[0] || null, error: null };
  }
  then(resolve, reject) { try { resolve(this.run()); } catch (e) { reject(e); } }
}

const supabase = { from: (t) => new Query(t) };

module.exports = { supabase, reset, seed, rows };
