// Atlas v2 verification (obs 471 checklist a-g). Run with both DBs mounted:
// /db1 = v1 live copy dir, /db2 = v2 staging dir. TOKENS env = v2 ATLAS_TOKEN.
const { DatabaseSync } = require('node:sqlite');
const V2 = 'http://192.168.50.23:7790/atlas-mcp';

const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail }); }

// ---------- DB-level checks (a, c) ----------
const d1 = new DatabaseSync('/db1/atlas.db', { readOnly: true });
const d2 = new DatabaseSync('/db2/atlas.db', { readOnly: true });
const cnt = (d, t) => d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
for (const t of ['entities', 'observations', 'events', 'reminders']) {
  check(`(a) rowcount ${t}`, cnt(d1, t) === cnt(d2, t), `${cnt(d1, t)} vs ${cnt(d2, t)}`);
}
const e1 = d1.prepare('SELECT id,section,name,summary,updated_at FROM entities ORDER BY id').all();
const e2 = d2.prepare('SELECT id,section,name,summary,updated_at FROM entities ORDER BY id').all();
check('(a/b) entities identical', JSON.stringify(e1) === JSON.stringify(e2));
const o1 = d1.prepare('SELECT id,entity_id,content,updated_at FROM observations ORDER BY id').all();
const o2 = d2.prepare('SELECT id,entity_id,content,updated_at FROM observations ORDER BY id').all();
check('(a/b) observations identical (sans protected)', JSON.stringify(o1) === JSON.stringify(o2));
const v1r = d1.prepare('SELECT id,section,entity_id,content,created_at FROM events ORDER BY id').all();
const v2r = d2.prepare('SELECT id,section,entity_id,content,created_at FROM events ORDER BY id').all();
check('(a/b) events identical', JSON.stringify(v1r) === JSON.stringify(v2r));
const r1 = d1.prepare('SELECT id,section,entity_id,content,trigger_date,dismissed_at FROM reminders ORDER BY id').all();
const r2 = d2.prepare('SELECT id,section,entity_id,content,trigger_date,dismissed_at FROM reminders ORDER BY id').all();
check('(a/b) reminders identical', JSON.stringify(r1) === JSON.stringify(r2));
const notZero = d2.prepare('SELECT COUNT(*) n FROM observations WHERE protected != 0').get().n;
check('(c) protected defaults 0 on all existing rows', notZero === 0, `nonzero=${notZero}`);

// ---------- MCP-level checks (b, d, e, f, g) ----------
const toks = {};
process.env.TOKENS.split(',').forEach((e) => { const [c, s, sc] = e.trim().split(':'); toks[sc] = s; });

async function mcall(scope, name, args) {
  const res = await fetch(`${V2}?token=${toks[scope]}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.text();
  let payload = body;
  if (body.startsWith('event:') || body.includes('\ndata:') || body.startsWith('data:')) {
    const line = body.split('\n').find((l) => l.startsWith('data:'));
    payload = line ? line.slice(5).trim() : body;
  }
  try { return { status: res.status, rpc: JSON.parse(payload) }; } catch { return { status: res.status, raw: body }; }
}
const rtext = (r) => r.rpc?.result?.content?.[0]?.text || r.raw || JSON.stringify(r.rpc?.error || {});
const isErr = (r) => !!(r.rpc?.result?.isError || r.rpc?.error);

(async () => {
  let r = await mcall('work', 'get_landscape', { section: 'work' });
  const lw = (() => { try { return JSON.parse(rtext(r)); } catch { return null; } })();
  check('(b) work token reads work landscape', !isErr(r) && lw && Array.isArray(lw.entities) && lw.entities.length > 0, `entities=${lw?.entities?.length}`);

  r = await mcall('work', 'get_landscape', { section: 'personal' });
  check('(d) work token DENIED on personal', isErr(r) && rtext(r).includes('403'), rtext(r).slice(0, 80));
  r = await mcall('personal', 'get_landscape', { section: 'work' });
  check('(d) home token DENIED on work', isErr(r) && rtext(r).includes('403'), rtext(r).slice(0, 80));
  r = await mcall('personal', 'get_landscape', { section: 'personal' });
  check('(d) home token reads personal', !isErr(r));

  r = await mcall('work', 'add_observation', { section: 'shared', entity: 'V2 Verify', content: 'temp verify row' });
  const obsId = (() => { try { return JSON.parse(rtext(r)).observation_id; } catch { return null; } })();
  check('(e) work token writes shared', !isErr(r) && !!obsId, `obs=${obsId}`);
  r = await mcall('personal', 'get_entity', { section: 'shared', name: 'V2 Verify' });
  check('(e) home token reads shared', !isErr(r) && rtext(r).includes('temp verify row'));
  r = await mcall('shared', 'get_landscape', { section: 'shared' });
  check('(e) shared-only token reads shared', !isErr(r));
  r = await mcall('shared', 'get_landscape', { section: 'work' });
  check('(e) shared-only token DENIED on work', isErr(r) && rtext(r).includes('403'));

  r = await mcall('work', 'protect_observation', { section: 'shared', observation_id: obsId });
  check('(g) protect works', !isErr(r) && rtext(r).includes('protected'));
  r = await mcall('work', 'remove_observation', { section: 'shared', observation_id: obsId });
  check('(g) remove REFUSED on protected', rtext(r).includes('Refused'));
  r = await mcall('work', 'update_observation', { section: 'shared', observation_id: obsId, content: 'updated verify row' });
  const upd = (() => { try { return JSON.parse(rtext(r)); } catch { return null; } })();
  check('(f) update preserves ID, allowed on protected', !isErr(r) && upd?.observation_id === obsId, JSON.stringify(upd));
  r = await mcall('work', 'get_entity', { section: 'shared', name: 'V2 Verify' });
  check('(f) content actually updated', rtext(r).includes('updated verify row'));

  r = await mcall('work', 'remove_entity', { section: 'shared', name: 'V2 Verify' });
  check('(g) remove_entity REFUSED with protected child', rtext(r).includes('Refused'));
  await mcall('work', 'unprotect_observation', { section: 'shared', observation_id: obsId });
  r = await mcall('work', 'remove_observation', { section: 'shared', observation_id: obsId });
  check('(g) remove works after unprotect', rtext(r).includes('Removed'));
  r = await mcall('work', 'remove_entity', { section: 'shared', name: 'V2 Verify' });
  check('cleanup: verify entity removed', rtext(r).includes('Removed'));

  const pass = results.filter((x) => x.ok).length;
  for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.detail ? '  [' + x.detail + ']' : ''}`);
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
