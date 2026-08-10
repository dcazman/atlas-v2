require('dotenv').config({ quiet: true });

const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { registerTools } = require('./tools');

const PORT = process.env.PORT || 7784;
const ATLAS_TOKEN = process.env.ATLAS_TOKEN;

if (!ATLAS_TOKEN) {
  console.error('FATAL: ATLAS_TOKEN not set');
  process.exit(1);
}

// v2 token format: "caller:secret:scope" pairs, comma-separated.
// scope is one of: work | personal | shared
//   work     -> may access sections: work, shared
//   personal -> may access sections: personal, shared
//   shared   -> may access sections: shared only
// Enforcement is SERVER-SIDE on every tool call - a token can never reach a
// section outside its scope, regardless of what the client asks for.
// (v1 format "caller:secret" is rejected at startup - scope is mandatory in v2.)
const SCOPE_SECTIONS = {
  work: ['work', 'shared'],
  personal: ['personal', 'shared'],
  shared: ['shared'],
};

const TOKENS = {};
let tokenParseError = false;
ATLAS_TOKEN.split(',').forEach((entry) => {
  const parts = entry.trim().split(':');
  if (parts.length !== 3) {
    console.error(`FATAL: token entry "${parts[0] || entry}" is not in caller:secret:scope format`);
    tokenParseError = true;
    return;
  }
  const [caller, secret, scope] = parts;
  if (!SCOPE_SECTIONS[scope]) {
    console.error(`FATAL: token entry "${caller}" has unknown scope "${scope}"`);
    tokenParseError = true;
    return;
  }
  TOKENS[secret] = { caller, scope, sections: SCOPE_SECTIONS[scope] };
});
if (tokenParseError || Object.keys(TOKENS).length === 0) process.exit(1);

function identifyCaller(token) {
  return TOKENS[token] || null;
}

function authCheck(req, res, next) {
  const token = req.headers['x-atlas-token'] || req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
  const auth = identifyCaller(token);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  req.auth = auth;
  next();
}

const app = express();
app.use(express.json());

const ATLAS_INSTRUCTIONS = `Atlas is shared memory for Claude across conversations, split into "work",
"personal", and "shared" sections. Your token is scoped: it can reach its own
section plus "shared", and the server refuses (403) anything else - so use the
section your project instructions name, plus "shared" for cross-context material
like skill files.

At the start of every conversation, call get_landscape with your section to see
the current state - don't ask the user to repeat context that's already there.

As things change during the conversation, proactively (without being asked):
- upsert_entity / add_observation to record or update current state
- update_observation to revise a fact in place (ID stays stable)
- remove_observation / remove_entity to clear out stuff that's stale or done
- log_event for notable things that happened

Observations marked protected cannot be deleted, only updated. Protect facts
whose loss would be costly and hard to notice: skill files, standing rules,
permanent URLs, incident lessons.`;

app.post('/atlas-mcp', authCheck, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = new McpServer({ name: 'atlas', version: '2.0.0' }, { instructions: ATLAS_INSTRUCTIONS });
  registerTools(server, req.auth);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'atlas-mcp', version: 2, port: PORT }));

// ---------------------------------------------------------------------------
// Groom scheduler: in-image, no host cron dependency. Every 5 minutes, if it
// is past 4am ET and the groom has not yet run today (groom_meta), spawn
// src/groom.js as a child process. Self-healing: a missed 4am window (container
// down, host reboot) runs at the first check after it comes back.
// ---------------------------------------------------------------------------
const { spawn } = require('node:child_process');
const dbMod = require('./db');
let groomRunning = false;

function easternNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parseInt(parts.hour, 10) % 24 };
}

setInterval(() => {
  try {
    const { date, hour } = easternNow();
    if (hour < 4 || groomRunning) return;
    if (dbMod.getGroomMeta('last_groom_date') === date) return;
    groomRunning = true;
    dbMod.setGroomMeta('last_groom_date', date);
    console.log(`groom scheduler: starting nightly groom for ${date}`);
    const child = spawn(process.execPath, [require('node:path').join(__dirname, 'groom.js')], { stdio: 'inherit' });
    child.on('exit', (code) => {
      groomRunning = false;
      console.log(`groom scheduler: groom exited with code ${code}`);
    });
  } catch (e) {
    groomRunning = false;
    console.error('groom scheduler error:', e.message);
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => console.log('atlas-mcp v2 running on port ' + PORT));

// ---------------------------------------------------------------------------
// READ-ONLY BOARD VIEW (PCT-15801 Phase 2, item 4). A plain HTTP page on its
// own LAN port so Dan can SEE the position without a Claude session. Renders
// straight off the tables (VIEW vs STORE, Atlas obs 875): live pieces + the
// untriaged tray only, oldest-first. No writes here - single-writer stays the
// MCP API. LAN-only (not on the Cloudflare tunnel), so no auth gate.
// ---------------------------------------------------------------------------
const BOARD_PORT = process.env.BOARD_PORT || 7795;
const BOARD_SECTION = process.env.BOARD_SECTION || 'work';

// Atlas mark — the titan holding the world (globe + arms cradling it). Amber,
// reads on the dark board. Used inline in the header and as the favicon.
const ATLAS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="23" r="15" fill="none" stroke="#e0b24a" stroke-width="3"/><path d="M17 23h30M32 8v30M22 13c7 6 13 6 20 0M22 33c7-6 13-6 20 0" fill="none" stroke="#e0b24a" stroke-width="1.3" opacity="0.7"/><path d="M13 58c1-13 9-16 19-11 10-5 18-2 19 11" fill="none" stroke="#e0b24a" stroke-width="3.2" stroke-linecap="round"/></svg>';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function boardDaysSince(ts) {
  if (!ts) return '';
  const iso = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(ts) ? ts.replace(' ', 'T') + 'Z' : ts;
  const t = new Date(iso);
  return isNaN(t.getTime()) ? '' : Math.floor((Date.now() - t.getTime()) / 86400000) + 'd';
}
function boardStamp() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
  }).format(new Date());
}
function boardBadge(s) {
  return `<span class="b b-${esc(s)}">${esc(String(s).replace(/_/g, ' '))}</span>`;
}

function slotRow(slot, p, isClosed) {
  let rel = [];
  try { rel = JSON.parse(p.related); } catch (e) { rel = [p.related]; }
  const pinned = p.priority !== null && p.priority !== undefined;
  const numGrey = isClosed || pinned || p.status === 'in_progress';
  const nn = p.status !== 'todo' && p.status !== 'done' && !(p.waiting_on && String(p.waiting_on).trim());
  const rowCls = [
    p.status === 'on_hold' ? 'hold' : '',
    isClosed ? 'closed' : '',
    pinned ? 'pinned' : '',
  ].filter(Boolean).join(' ');
  const pin = pinned ? '<span class="pin" title="pinned - attention only, never changes status">\u{1F4CC}</span> ' : '';
  return `<tr class="${rowCls}"><td class="pos${numGrey ? ' num-grey' : ''}">${esc(slot)}</td><td>${pin}${esc(p.title)}</td><td>${boardBadge(p.status)}</td><td class="sp">${esc(p.sprint || 'B')}</td>`
    + `<td class="tk">${rel.map((r) => `<a href="https://sonosinc.atlassian.net/browse/${encodeURIComponent(r)}" target="_blank" rel="noopener">${esc(r)}</a>`).join('<br>')}</td>`
    + `<td class="${nn ? 'note-flag' : ''}">${p.waiting_on ? esc(p.waiting_on) : (nn ? '⚠ needs a note' : '')}</td><td class="age">${boardDaysSince(p.source_date || p.status_changed_at)}</td></tr>`;
}

function ghostRow(slot, rowId) {
  let dest = 'moved on';
  try {
    const cur = dbMod.getBoardRow(BOARD_SECTION, rowId);
    if (!cur) dest = 'removed';
    else if (!cur.on_board) dest = 'off-board';
    else if (cur.sprint) dest = '→ S' + esc(cur.sprint);
    else dest = '→ backlog';
  } catch (e) { /* leave default */ }
  return `<tr class="ghost"><td class="pos num-grey">${esc(slot)}</td><td colspan="6" class="ghost-txt">${dest}</td></tr>`;
}

// Sprint-grouped block with FROZEN per-sprint numbering (Board v-next items 1 +
// 5, Atlas work obs 979/980). Slots are assigned once, oldest-first, the first
// time a sprint is rendered (ensureSprintSlots is a no-op once they exist), then
// only ever appended to - never recomputed. A row keeps its slot through
// in_progress/on_hold/done; a row that left this sprint renders as a ghost in
// place instead of vanishing or shifting everything below it up.
function renderSprintBlock(sprintLabel, group, isActive) {
  const liveRows = group.live;
  const oldestFirst = [...liveRows].sort((a, b) => {
    const ka = a.source_date || a.created_at, kb = b.source_date || b.created_at;
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return a.id - b.id;
  });
  try { dbMod.ensureSprintSlots(BOARD_SECTION, sprintLabel, oldestFirst.map((p) => p.id)); } catch (e) { /* render best-effort */ }
  let slots = [];
  try { slots = dbMod.getSprintSlots(BOARD_SECTION, sprintLabel); } catch (e) {}
  const liveById = new Map(liveRows.map((p) => [p.id, p]));
  const closedById = new Map(group.closed.map((p) => [p.id, p]));
  let rowsHtml = '';
  for (const s of slots) {
    const p = liveById.get(s.row_id);
    if (p) { rowsHtml += slotRow(s.slot, p, false); continue; }
    const c = closedById.get(s.row_id);
    if (c) { rowsHtml += slotRow(s.slot, c, true); continue; }
    rowsHtml += ghostRow(s.slot, s.row_id);
  }
  const hdrLabel = 'SPRINT ' + esc(sprintLabel) + (isActive ? ' · ACTIVE' : '');
  return `<tr class="zonehdr ${isActive ? 'zh-active' : 'zh-sprint'}"><td colspan="7">${hdrLabel}</td></tr>` + rowsHtml;
}

// No-sprint backlog: plain oldest-first, recomputed each render (frozen
// numbering is a per-sprint concept per obs 980 - backlog has no sprint).
function renderBacklogBlock(rows) {
  const ordered = [...rows].sort((a, b) => {
    const ka = a.source_date || a.created_at, kb = b.source_date || b.created_at;
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return a.id - b.id;
  });
  let n = 0;
  const rowsHtml = ordered.map((p) => slotRow(++n, p, false)).join('');
  return `<tr class="zonehdr zh-backlog"><td colspan="7">BACKLOG · NO SPRINT</td></tr>` + rowsHtml;
}

// Activity strip (Board v-next item 4): what moved or closed recently, so
// coming back to the board doesn't require re-deriving state from scratch.
function activityStrip(activity) {
  if (!activity || !activity.length) return '<div class="activity empty-act">Nothing moved recently.</div>';
  const items = activity.map((a) => {
    let rel = [];
    try { rel = JSON.parse(a.related); } catch (e) { rel = [a.related]; }
    const key = rel[0] || ('#' + a.row_id);
    const verb = a.kind === 'closed' ? 'closed'
      : a.kind === 'started' ? 'started'
      : a.kind === 'held' ? 'on hold'
      : a.kind === 'moved' ? ('→ S' + esc(a.sprint || ''))
      : 'back to todo';
    return `<span class="act-item"><b>${esc(key)}</b> ${esc(verb)}</span>`;
  }).join('<span class="act-sep">·</span>');
  return `<div class="activity"><span class="activity-label">RECENT</span> ${items}</div>`;
}

function renderBoard() {
  let pieces = [], pending = [], reminders = [], activity = [];
  try { pieces = dbMod.listBoardRows(BOARD_SECTION, true); } catch (e) { /* render empty on error */ }
  try { pending = dbMod.listPending(BOARD_SECTION); } catch (e) {}
  try { reminders = dbMod.listReminders(BOARD_SECTION, false); } catch (e) {}
  try { activity = dbMod.recentActivity(BOARD_SECTION, 7); } catch (e) {}

  const live = pieces.filter((p) => p.status !== 'done');
  const closed = pieces.filter((p) => p.status === 'done');

  // ---- sprint grouping (item 1) + frozen numbering (item 5) ----------------
  const bySprint = new Map();
  const backlog = [];
  for (const p of live) {
    const sp = (p.sprint || '').trim();
    if (!sp) { backlog.push(p); continue; }
    if (!bySprint.has(sp)) bySprint.set(sp, { live: [], closed: [] });
    bySprint.get(sp).live.push(p);
  }
  for (const p of closed) {
    const sp = (p.sprint || '').trim();
    if (!sp || !bySprint.has(sp)) continue; // sprint fully wound down - history ages out with it
    bySprint.get(sp).closed.push(p);
  }

  const inSprintCounts = new Map();
  for (const p of live) if (p.in_sprint && p.sprint) inSprintCounts.set(p.sprint, (inSprintCounts.get(p.sprint) || 0) + 1);
  let activeSprint = '', bestCount = 0;
  for (const [sp, c] of inSprintCounts) if (c > bestCount) { bestCount = c; activeSprint = sp; }

  const otherSprints = [...bySprint.keys()].filter((sp) => sp !== activeSprint).sort((a, b) => {
    const na = parseFloat(a), nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return nb - na;
    return String(b).localeCompare(String(a));
  });
  const sprintOrder = activeSprint ? [activeSprint, ...otherSprints] : otherSprints;

  let body = '';
  for (const sp of sprintOrder) body += renderSprintBlock(sp, bySprint.get(sp), sp === activeSprint);
  if (backlog.length) body += renderBacklogBlock(backlog);

  const pendRows = pending.map((p, i) =>
    `<tr><td class="pos">${i + 1}</td><td class="id">${p.id}</td><td>${esc(p.summary)}</td><td class="src">${esc(p.source)}</td><td class="age">${boardDaysSince(p.source_date || p.created_at)}</td></tr>`
  ).join('');
  const remRows = reminders.map((r, i) =>
    `<tr><td class="pos">${i + 1}</td><td class="id">${r.id}</td><td>${esc(r.content)}</td><td class="sp">${esc(r.trigger_date || '')}${r.trigger_time ? ' ' + esc(r.trigger_time) : ''}</td><td class="src">${esc(r.entity || '')}</td><td class="age">${boardDaysSince(r.created_at)}</td></tr>`
  ).join('');

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atlas</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(ATLAS_SVG)}">
<style>
  body{font:15px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f1115;color:#e6e6e6}
  header{padding:14px 18px;border-bottom:1px solid #2a2f3a;display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
  h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.06em}
  .logo{display:inline-flex;align-items:center}
  .logo svg{width:30px;height:30px}
  .meta{color:#8b94a3;font-size:12px}
  .activity{padding:8px 18px;font-size:12px;color:#cfd6e2;border-bottom:1px solid #2a2f3a;background:#141822;white-space:nowrap;overflow-x:auto}
  .activity.empty-act{color:#5b6472;font-style:italic}
  .activity-label{color:#6b7280;letter-spacing:.08em;font-size:10px;margin-right:10px}
  .act-item b{color:#e0b24a;font-weight:600}
  .act-sep{color:#3a4150;margin:0 8px}
  .tabs{display:flex;gap:6px;padding:12px 18px 0}
  .tabs button{background:#1a1f29;color:#cfd6e2;border:1px solid #2a2f3a;padding:7px 14px;border-radius:8px 8px 0 0;cursor:pointer;font-size:13px}
  .tabs button.on{background:#232a36;color:#fff}
  .panel{display:none;padding:0 18px 24px}
  .panel.on{display:block}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #222833;vertical-align:top}
  th{color:#8b94a3;font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em;position:sticky;top:0;background:#0f1115;z-index:5;box-shadow:inset 0 -1px 0 #222833}
  td.id{color:#6b7280;font-variant-numeric:tabular-nums;width:38px}
  td.pos{color:#4b5563;font-variant-numeric:tabular-nums;width:30px}
  td.pos.num-grey{color:#3a4150}
  td.sp{color:#9fb0c3;font-variant-numeric:tabular-nums;width:54px;text-align:center}
  td.note-flag{color:#e0a04a;font-style:italic}
  tr.zonehdr td{font-size:11px;letter-spacing:.09em;text-transform:uppercase;font-weight:700;padding:16px 10px 6px;border-bottom:2px solid #313846;background:#0f1115}
  tr.zh-active td{color:#7ab3ff}
  tr.zh-sprint td{color:#86efac}
  tr.zh-backlog td{color:#fde68a}
  tr.pinned td{box-shadow:inset 3px 0 0 #e0b24a}
  .pin{filter:grayscale(.15)}
  tr.hold td{opacity:.5}
  tr.hold td.id{border-left:2px solid #4a3a12}
  tr.closed td{text-decoration:line-through;opacity:.45}
  tr.ghost td{opacity:.35;font-style:italic}
  td.ghost-txt{color:#8b94a3}
  td.age{color:#8b94a3;font-variant-numeric:tabular-nums;width:52px}
  td.tk{color:#7aa2f7;font-family:ui-monospace,monospace;font-size:12px;line-height:1.7}
  td.tk a{color:#7aa2f7;text-decoration:none}
  td.tk a:hover{text-decoration:underline}
  td.src{color:#8b94a3;font-size:12px}
  .b{font-size:11px;padding:2px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap;display:inline-block}
  .b-todo{background:#26303f;color:#9fb0c3}
  .b-in_progress{background:#14532d;color:#86efac}
  .b-on_hold{background:#4a3a12;color:#fde68a}
  .b-done{background:#26303f;color:#93a3b8}
  .empty{color:#8b94a3;padding:24px 0}
  footer{color:#5b6472;font-size:11px;padding:0 18px 22px}
</style></head><body>
<header>
  <span class="logo">${ATLAS_SVG}</span>
  <h1>ATLAS</h1>
  <span class="meta">as of ${esc(boardStamp())}</span>
  <span class="meta">${live.length} live pieces &middot; ${pending.length} pending</span>
</header>
${activityStrip(activity)}
<div class="tabs">
  <button id="tb" class="on" onclick="show('board')">Board (${live.length})</button>
  <button id="tp" onclick="show('pending')">Tray (${pending.length})</button>
  <button id="tr" onclick="show('reminders')">Reminders (${reminders.length})</button>
</div>
<div id="board" class="panel on">
  ${body ? `<table><thead><tr><th>Slot</th><th>Title</th><th>Status</th><th>Sprint</th><th>Tickets</th><th>Note</th><th>Age</th></tr></thead><tbody>${body}</tbody></table>` : `<div class="empty">No live pieces.</div>`}
</div>
<div id="pending" class="panel">
  ${pending.length ? `<table><thead><tr><th>Pos</th><th>#</th><th>Item</th><th>Source</th><th>Age</th></tr></thead><tbody>${pendRows}</tbody></table>` : `<div class="empty">Tray empty.</div>`}
</div>
<div id="reminders" class="panel">
  ${reminders.length ? `<table><thead><tr><th>Pos</th><th>#</th><th>Reminder</th><th>When</th><th>Topic</th><th>Age</th></tr></thead><tbody>${remRows}</tbody></table>` : `<div class="empty">No reminders.</div>`}
</div>
<footer>Read-only. Grouped by sprint, active sprint on top, oldest-first within each. Slot numbers are frozen per sprint (obs 980) - closed items stay crossed out in place, moved items leave a marker, pin only highlights (never changes status). Auto-refreshes every 30s.</footer>
<script>
function show(w){for(const [id,name] of [['board','tb'],['pending','tp'],['reminders','tr']]){document.getElementById(id).classList.toggle('on',id===w);document.getElementById(name).classList.toggle('on',id===w);}try{localStorage.setItem('atlasTab',w);}catch(e){}}
(function(){try{var t=localStorage.getItem('atlasTab');if(t==='pending'||t==='reminders')show(t);}catch(e){}})();
setInterval(function(){location.reload();},30000);
</script>
</body></html>`;
}


const boardApp = express();
boardApp.get('/', (req, res) => { res.set('Content-Type', 'text/html; charset=utf-8'); res.send(renderBoard()); });
boardApp.get('/health', (req, res) => res.json({ ok: true, service: 'atlas-board', section: BOARD_SECTION, port: BOARD_PORT }));

// JSON feed of the board — what the SessionStart hook curls to inject the live
// board into Claude's context deterministically at every chat start. LAN, no auth.
boardApp.get('/api', (req, res) => {
  let pieces = [], pending = [], activity = [];
  try { pieces = dbMod.listBoardRows(BOARD_SECTION, false); } catch (e) {}
  try { pending = dbMod.listPending(BOARD_SECTION); } catch (e) {}
  try { activity = dbMod.recentActivity(BOARD_SECTION, 7); } catch (e) {}
  const rel = (r) => { try { return JSON.parse(r); } catch (e) { return [r]; } };
  res.json({
    as_of: boardStamp(),
    section: BOARD_SECTION,
    counts: { pieces: pieces.length, pending: pending.length },
    pieces: pieces.map((p) => ({ id: p.id, title: p.title, status: p.status, sprint: p.sprint, related: rel(p.related), waiting_on: p.waiting_on, pinned: p.priority !== null && p.priority !== undefined, needs_note: (p.status !== 'todo' && p.status !== 'done' && !(p.waiting_on && String(p.waiting_on).trim())), age_days: boardDaysSince(p.source_date || p.status_changed_at) })),
    pending: pending.map((p) => ({ id: p.id, summary: p.summary, source: p.source, age_days: boardDaysSince(p.source_date || p.created_at) })),
    // Board v-next item 4: what moved or closed recently (additive field).
    activity: activity.map((a) => ({ row_id: a.row_id, title: a.title, related: rel(a.related), kind: a.kind, sprint: a.sprint, at: a.at })),
  });
});
boardApp.listen(BOARD_PORT, () => console.log('board view (read-only) on port ' + BOARD_PORT + ' section=' + BOARD_SECTION));
