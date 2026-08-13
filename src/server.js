require('dotenv').config({ quiet: true });

const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { registerTools } = require('./tools');
const fs = require('node:fs');
const path = require('node:path');

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

// Workers have their own (smaller) status vocabulary - reuse the board's
// existing badge colors rather than inventing new CSS (active~in_progress).
function workerBadge(status) {
  const map = { active: 'in_progress', on_hold: 'on_hold', done: 'done' };
  return `<span class="b b-${esc(map[status] || 'todo')}">${esc(String(status).replace(/_/g, ' '))}</span>`;
}

function parseRelated(related) {
  let rel = [];
  try { rel = JSON.parse(related); } catch (e) { rel = [related]; }
  return Array.isArray(rel) ? rel : [rel];
}

// Static skills-directory snapshot. atlas-v2 runs on a different host than the
// skill files, so this is written ahead of time (skills.json, repo root) rather
// than read live. Re-read every render (it's tiny) so updating the file alone
// is enough - no redeploy needed. Missing/bad file renders an empty list, never
// a crash.
function loadSkills() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'skills.json'), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

// A "GSSD piece" carries a raw GSSD-* key anywhere in related (Dan, 2026-08-10
// - the service-desk pile, distinct from planned sprint stories).
function hasGssdKey(related) {
  return parseRelated(related).some((k) => /^GSSD-/i.test(String(k)));
}

// The anchor id a row is addressable at (activity strip links here). Ticket
// key when there is one (there always should be - require-ticket CHECK), a
// row-id fallback otherwise so a link never 404s into nothing.
function rowAnchorId(related, rowId) {
  const rel = parseRelated(related);
  return 'row-' + encodeURIComponent((rel[0] || ('id' + rowId)));
}

function slotRow(slot, p, isClosed) {
  const rel = parseRelated(p.related);
  const pinned = p.priority !== null && p.priority !== undefined;
  const numGrey = isClosed || pinned || p.status === 'in_progress';
  const nn = p.status !== 'todo' && p.status !== 'done' && !(p.waiting_on && String(p.waiting_on).trim());
  const rowCls = [
    p.status === 'on_hold' ? 'hold' : '',
    isClosed ? 'closed' : '',
    pinned ? 'pinned' : '',
  ].filter(Boolean).join(' ');
  const pin = pinned ? '<span class="pin" title="pinned - moved to in_progress, shows in the In Progress strip">\u{1F4CC}</span> ' : '';
  return `<tr id="${rowAnchorId(p.related, p.id)}" class="${rowCls}"><td class="pos${numGrey ? ' num-grey' : ''}">${esc(slot)}</td><td>${pin}${esc(p.title)}</td><td>${boardBadge(p.status)}</td><td class="sp">${esc(p.sprint || 'B')}</td>`
    + `<td class="tk">${rel.map((r) => `<a href="https://sonosinc.atlassian.net/browse/${encodeURIComponent(r)}" target="_blank" rel="noopener">${esc(r)}</a>`).join('<br>')}</td>`
    + `<td class="${nn ? 'note-flag' : ''}">${p.waiting_on ? esc(p.waiting_on) : (nn ? '⚠ needs a note' : '')}</td>`
    + `<td class="last-comment">${p.last_comment ? esc(p.last_comment) : '<span class=\"muted\">—</span>'}</td><td class="age">${boardDaysSince(p.source_date || p.status_changed_at)}</td></tr>`;
}

function ghostRow(slot, rowId, sprintLabel) {
  let dest = 'moved on';
  try {
    const cur = dbMod.getBoardRow(BOARD_SECTION, rowId);
    // A done row whose sprint was cleared (or still matches this block) did not
    // MOVE anywhere - it closed. Cross it out in place (obs 980 "free history")
    // instead of the misleading "→ backlog" ghost. Only a done row that left
    // for a DIFFERENT sprint still renders as a moved ghost below.
    const sp = cur ? String(cur.sprint || '').trim() : '';
    if (cur && cur.on_board && cur.status === 'done' && (!sp || sp === String(sprintLabel || '').trim())) {
      return slotRow(slot, cur, true);
    }
    if (!cur) dest = 'removed';
    else if (!cur.on_board) dest = 'off-board';
    else if (cur.sprint) dest = '→ S' + esc(cur.sprint);
    else dest = '→ backlog';
  } catch (e) { /* leave default */ }
  return `<tr class="ghost"><td class="pos num-grey">${esc(slot)}</td><td colspan="7" class="ghost-txt">${dest}</td></tr>`;
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
  // GSSD pile (Dan, 2026-08-10): pieces carrying a raw GSSD-* key cluster as
  // one group at the BOTTOM of their own sprint block, not interleaved by age
  // with the planned PCT stories above them. This is a display-order pass
  // only - it re-sorts how slots are WALKED for rendering, it does not touch
  // the slot NUMBER itself (obs 980's frozen numbering is untouched; a row's
  // number stays whatever it already was).
  const related = (s) => {
    const p = liveById.get(s.row_id) || closedById.get(s.row_id);
    if (p) return p.related;
    try { return dbMod.getBoardRow(BOARD_SECTION, s.row_id)?.related; } catch (e) { return null; }
  };
  const walkOrder = [...slots.filter((s) => !hasGssdKey(related(s))), ...slots.filter((s) => hasGssdKey(related(s)))];
  let rowsHtml = '';
  for (const s of walkOrder) {
    const p = liveById.get(s.row_id);
    if (p) { rowsHtml += slotRow(s.slot, p, false); continue; }
    const c = closedById.get(s.row_id);
    if (c) { rowsHtml += slotRow(s.slot, c, true); continue; }
    rowsHtml += ghostRow(s.slot, s.row_id, sprintLabel);
  }
  const hdrLabel = 'SPRINT ' + esc(sprintLabel) + (isActive ? ' · ACTIVE' : '');
  return `<tr class="zonehdr ${isActive ? 'zh-active' : 'zh-sprint'}"><td colspan="8">${hdrLabel}</td></tr>` + rowsHtml;
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
  return `<tr class="zonehdr zh-backlog"><td colspan="8">BACKLOG · NO SPRINT</td></tr>` + rowsHtml;
}

// In Progress strip (redefined 2026-08-11, Dan): shows only pieces currently
// sitting at status=in_progress, so the strip answers "what am I working on
// right now" instead of a change log. Pinning (board_bump) is now paired with
// moving a story to in_progress + a Jira comment, so every pin surfaces here.
// Same anchor scheme slotRow writes (rowAnchorId), so a click jumps straight
// to the row in its sprint block.
function inProgressStrip(pieces, slotMap) {
  const wip = pieces.filter((p) => p.status === 'in_progress');
  if (!wip.length) return '<div class="activity empty-act">Nothing in progress.</div>';
  // The number shown here IS the same frozen per-sprint Slot from the board
  // table below (Dan, 2026-08-11 - a strip-local 1..N index was confusing,
  // since "spot 17" has to mean the same thing everywhere he says it).
  const items = wip.map((p) => {
    const rel = parseRelated(p.related);
    const key = rel[0] || ('#' + p.id);
    const slot = (slotMap.get(p.id) || {}).slot;
    const anchor = rowAnchorId(p.related, p.id);
    return `<span class="act-item">${slot != null ? `<span class="act-n">${esc(slot)}.</span> ` : ''}<a href="#${anchor}" class="jump-link" data-target="${anchor}"><b>${esc(key)}</b></a> ${esc(p.title)}</span>`;
  }).join('<span class="act-sep">·</span>');
  return `<div class="activity"><span class="activity-label">IN PROGRESS</span> ${items}</div>`;
}

// ORDER band (v18, board_order tool): Dan's declared work order - pure
// intention. Jira never sees it, statuses and frozen Slot numbers untouched.
// Renders below the In Progress strip, grey/neutral so it reads as intent, not
// state; pieces in queue sequence, each with its normal frozen Slot number.
// Hidden entirely when the queue is empty.
function orderBand(pieces, slotMap) {
  let ids = [];
  try { ids = dbMod.listOrderQueue(BOARD_SECTION); } catch (e) {}
  if (!ids.length) return '';
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const queued = ids.map((id) => byId.get(id)).filter(Boolean);
  if (!queued.length) return '';
  const items = queued.map((p) => {
    const rel = parseRelated(p.related);
    const key = rel[0] || ('#' + p.id);
    const slot = (slotMap.get(p.id) || {}).slot;
    const anchor = rowAnchorId(p.related, p.id);
    return `<span class="ord-item">${slot != null ? `<span class="act-n">${esc(slot)}.</span> ` : ''}<a href="#${anchor}" class="jump-link" data-target="${anchor}"><b>${esc(key)}</b></a> ${esc(p.title)}</span>`;
  }).join('<span class="ord-sep">&rarr;</span>');
  return `<div class="orderband"><span class="orderband-label" title="Dan's declared work order (board_order) - intention only, no Jira, no status change. A piece drops out when pinned, closed, or offboarded.">ORDER&nbsp;ⓘ</span> ${items}</div>`;
}

function renderBoard() {
  let pieces = [], pending = [], reminders = [], research = [];
  try { pieces = dbMod.listBoardRows(BOARD_SECTION, true); } catch (e) { /* render empty on error */ }
  try { pending = dbMod.listPending(BOARD_SECTION); } catch (e) {}
  try { reminders = dbMod.listReminders(BOARD_SECTION, false); } catch (e) {}
  try { research = dbMod.listResearch(BOARD_SECTION); } catch (e) {}
  let workers = [];
  try { workers = dbMod.listWorkers(BOARD_SECTION, true); } catch (e) {}
  const skills = loadSkills();
  const live = pieces.filter((p) => p.status !== 'done');
  const closed = pieces.filter((p) => p.status === 'done');

  // ---- sprint grouping (item 1) + frozen numbering (item 5) ----------------
  const bySprint = new Map();
  const backlogCandidates = [];
  for (const p of live) {
    const sp = (p.sprint || '').trim();
    if (!sp) { backlogCandidates.push(p); continue; }
    if (!bySprint.has(sp)) bySprint.set(sp, { live: [], closed: [] });
    bySprint.get(sp).live.push(p);
  }
  for (const p of closed) {
    const sp = (p.sprint || '').trim();
    if (!sp || !bySprint.has(sp)) continue; // sprint fully wound down - history ages out with it
    bySprint.get(sp).closed.push(p);
  }

  // Active sprint = the LOWEST-numbered sprint (sprints are sequential - 16 is
  // current, 17 is next), preferring an in_sprint=1-flagged sprint when that
  // signal is actually populated. Two real bugs lived here (caught live by Dan
  // Aug 10, 17 rendering above 16):
  //  1. It picked the sprint with the MOST in_sprint=1 rows, not the lowest-
  //     numbered one - a bad tie-breaker even when the flag is populated
  //     (pre-planning can pull more tickets into next sprint than remain in
  //     the winding-down current one).
  //  2. In production in_sprint is not populated at all (0 rows), so
  //     activeSprint fell through empty and the code rendered the "other
  //     sprints" list DESCENDING with nothing pulled to the front - i.e.
  //     next-sprint-first, backwards from "active on top".
  // Fix: always sort every sprint ascending first, then pull the active one
  // (in_sprint-flagged if any exist, else simply the lowest number) to the
  // front - so the rest of the list stays in natural ascending order too.
  const numericSort = (a, b) => {
    const na = parseFloat(a), nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  };
  const allSprints = [...bySprint.keys()].sort(numericSort);
  const inSprintSprints = [...new Set(live.filter((p) => p.in_sprint && p.sprint).map((p) => p.sprint))];
  const activeSprint = inSprintSprints.length ? inSprintSprints.slice().sort(numericSort)[0] : (allSprints[0] || '');
  const sprintOrder = activeSprint ? [activeSprint, ...allSprints.filter((sp) => sp !== activeSprint)] : allSprints;

  // GSSD-no-sprint fix (Dan, Aug 10, caught via #76/#77): GSSD tickets carry
  // no Jira sprint field at all, so a GSSD piece always had sp='' above and
  // landed in Backlog - never reaching the bottom-of-sprint GSSD pile, which
  // was exactly the "easy to forget" spot Dan built that pile to avoid. A
  // GSSD-tagged piece with no sprint now defaults into the ACTIVE sprint's
  // block (still bottom-clustered there, same as any other GSSD piece) -
  // non-GSSD sprint-less pieces are unaffected and still go to Backlog.
  // activeSprint, whenever truthy, always already has a bySprint entry (it
  // was derived FROM bySprint's own keys/values above), so this only ever
  // appends to an existing bucket - it never needs to touch sprintOrder.
  const backlog = [];
  for (const p of backlogCandidates) {
    if (activeSprint && hasGssdKey(p.related)) {
      bySprint.get(activeSprint).live.push(p);
    } else {
      backlog.push(p);
    }
  }

  let body = '';
  for (const sp of sprintOrder) body += renderSprintBlock(sp, bySprint.get(sp), sp === activeSprint);
  if (backlog.length) body += renderBacklogBlock(backlog);

  const pendRows = pending.map((p, i) =>
    `<tr><td class="pos">${i + 1}</td><td class="id">${p.id}</td><td>${esc(p.summary)}</td><td class="src">${esc(p.source)}</td><td class="age">${boardDaysSince(p.source_date || p.created_at)}</td></tr>`
  ).join('');
  // Research shelf (v19): Dan's own ideas, undated and unpressured. Age is
  // shown as plain information - old is NOT a problem on this tab, no styling
  // pressure, no nags. Sitting forever is a valid end state.
  const resRows = research.map((r, i) =>
    `<tr><td class="pos">${i + 1}</td><td class="id">${r.id}</td><td>${esc(r.content)}</td><td class="age">${boardDaysSince(r.created_at)}</td></tr>`
  ).join('');
  const remRows = reminders.map((r, i) =>
    `<tr><td class="pos">${i + 1}</td><td class="id">${r.id}</td><td>${esc(r.content)}</td><td class="sp">${esc(r.trigger_date || '')}${r.trigger_time ? ' ' + esc(r.trigger_time) : ''}</td><td class="src">${esc(r.entity || '')}</td><td class="age">${boardDaysSince(r.created_at)}</td></tr>`
  ).join('');
  // Done workers stay on the tab (greyed, after the live ones) — same pattern
  // as closed board rows crossing out in place instead of vanishing.
  const liveWorkers = workers.filter((w) => w.status !== 'done');
  const doneWorkers = workers.filter((w) => w.status === 'done');
  const workerRows = [...liveWorkers, ...doneWorkers].map((w) => {
    const rel = parseRelated(w.related);
    const tickets = rel.length ? rel.map((k) => `<a href="https://sonosinc.atlassian.net/browse/${encodeURIComponent(k)}" target="_blank" rel="noopener">${esc(k)}</a>`).join('<br>') : '';
    return `<tr${w.status === 'done' ? ' class="closed"' : ''}><td>${esc(w.name)}</td><td>${workerBadge(w.status)}</td><td class="tk">${tickets}</td><td>${esc(w.title)}</td><td class="id">${w.obs_id ?? ''}</td><td class="age">${boardDaysSince(w.updated_at)}</td></tr>`;
  }).join('');
  const skillRows = skills.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.description)}</td></tr>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atlas</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(ATLAS_SVG)}">
<style>
  html{scroll-behavior:smooth}
  body{font:15px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f1115;color:#e6e6e6}
  tr:target td{background:rgba(224,178,74,0.22);transition:background 2.5s ease}
  header{padding:14px 18px;border-bottom:1px solid #2a2f3a;display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
  h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.06em}
  .logo{display:inline-flex;align-items:center}
  .logo svg{width:30px;height:30px}
  .meta{color:#8b94a3;font-size:12px}
  .activity{padding:8px 18px;font-size:12px;color:#cfd6e2;border-bottom:1px solid #2a2f3a;background:#141822;white-space:nowrap;overflow-x:auto}
  .activity.empty-act{color:#5b6472;font-style:italic}
  .activity-label{color:#6b7280;letter-spacing:.08em;font-size:10px;margin-right:10px}
  .act-n{color:#6b7280;font-variant-numeric:tabular-nums}
  .act-item b{color:#e0b24a;font-weight:600}
  .act-item a{text-decoration:none}
  .act-item a:hover b{text-decoration:underline}
  .act-sep{color:#3a4150;margin:0 8px}
  .orderband{padding:7px 18px;font-size:12px;color:#8b94a3;border-bottom:1px solid #222833;background:#10131a;white-space:nowrap;overflow-x:auto}
  .orderband-label{color:#5b6472;letter-spacing:.08em;font-size:10px;margin-right:10px}
  .ord-item b{color:#9fb0c3;font-weight:600}
  .ord-item a{text-decoration:none}
  .ord-item a:hover b{text-decoration:underline}
  .ord-sep{color:#3a4150;margin:0 8px}
  .tabs{display:flex;gap:6px;padding:12px 18px 0}
  .tabs button{background:#1a1f29;color:#cfd6e2;border:1px solid #2a2f3a;padding:7px 14px;border-radius:8px 8px 0 0;cursor:pointer;font-size:13px}
  .tabs button.on{background:#232a36;color:#fff}
  .panel{display:none;padding:0 18px 24px}
  .panel.on{display:block}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #222833;vertical-align:top}
  th{color:#8b94a3;font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em;position:sticky;top:0;background:#0f1115;z-index:5;box-shadow:inset 0 -1px 0 #222833}
  td.id{color:#6b7280;font-variant-numeric:tabular-nums;width:38px}
  td.pos{color:#e6e6e6;font-variant-numeric:tabular-nums;width:30px}
  td.pos.num-grey{color:#e6e6e6}
  td.sp{color:#9fb0c3;font-variant-numeric:tabular-nums;width:54px;text-align:center}
  td.note-flag{color:#e0a04a;font-style:italic}
  td.last-comment{color:#cfd6e2;font-size:12px;max-width:260px}
  td.last-comment .muted{color:#4b5563}
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
${inProgressStrip(live, computeSlotMap())}
${orderBand(live, computeSlotMap())}
<div class="tabs">
  <button id="tb" class="on" onclick="show('board')">Board (${live.length})</button>
  <button id="tp" onclick="show('pending')">Tray (${pending.length})</button>
  <button id="tres" onclick="show('research')">Research (${research.length})</button>
  <button id="tr" onclick="show('reminders')">Reminders (${reminders.length})</button>
  <button id="tw" onclick="show('workers')">Workers (${liveWorkers.length})</button>
</div>
<div id="board" class="panel on">
  ${body ? `<table><thead><tr><th title="Frozen per-sprint slot - THE number Dan speaks in chat to move/close a piece (active sprint block by default; name the block for others). Corrected Aug 10 - see ATLAS.md / SPEC-tray-and-commands.md.">Slot&nbsp;ⓘ</th><th>Title</th><th>Status</th><th>Sprint</th><th>Tickets</th><th title="Claude's OWN internal note/context - NOT a mirror of the Jira ticket, can go stale (obs 1086).">Note&nbsp;ⓘ</th><th title="The actual last Jira comment - live ticket-side truth. Not yet populated by anyone (danfeed follow-up, obs 1086/1087) - blank until then.">Last&nbsp;Comment&nbsp;ⓘ</th><th>Age</th></tr></thead><tbody>${body}</tbody></table>` : `<div class="empty">No live pieces.</div>`}
</div>
<div id="pending" class="panel">
  ${pending.length ? `<table><thead><tr><th>Pos</th><th>#</th><th>Item</th><th>Source</th><th>Age</th></tr></thead><tbody>${pendRows}</tbody></table>` : `<div class="empty">Tray empty.</div>`}
</div>
<div id="research" class="panel">
  ${research.length ? `<table><thead><tr><th>Pos</th><th>#</th><th title="Dan's own ideas and loose threads - not yet work, may never be. No dates, no pressure; sitting forever is fine. Exits: graduate to the tray, get killed, or stay.">Idea&nbsp;ⓘ</th><th>Age</th></tr></thead><tbody>${resRows}</tbody></table>` : `<div class="empty">Shelf empty. Research items are Dan's own ideas and loose threads - not yet work, no dates, no pressure.</div>`}
</div>
<div id="reminders" class="panel">
  ${reminders.length ? `<table><thead><tr><th>Pos</th><th>#</th><th>Reminder</th><th>When</th><th>Topic</th><th>Age</th></tr></thead><tbody>${remRows}</tbody></table>` : `<div class="empty">No reminders.</div>`}
</div>
<div id="workers" class="panel">
  <h3 style="margin:18px 0 6px;font-size:12px;color:#8b94a3;text-transform:uppercase;letter-spacing:.04em;font-weight:500">Workers</h3>
  ${workerRows ? `<table><thead><tr><th>Name</th><th>Status</th><th>Ticket(s)</th><th>Task</th><th>Obs&nbsp;#</th><th>Age</th></tr></thead><tbody>${workerRows}</tbody></table>` : `<div class="empty">No workers.</div>`}
  <h3 style="margin:26px 0 6px;font-size:12px;color:#8b94a3;text-transform:uppercase;letter-spacing:.04em;font-weight:500">Skills Directory</h3>
  ${skillRows ? `<table><thead><tr><th>Name</th><th>Description</th></tr></thead><tbody>${skillRows}</tbody></table>` : `<div class="empty">No skills found.</div>`}
</div>
<footer>Read-only. Grouped by sprint, active sprint on top, oldest-first within each. Slot numbers are frozen per sprint (obs 980) - closed items stay crossed out in place, moved items leave a marker, pin moves a story to in_progress (+ a Jira comment) and surfaces it in the In Progress strip up top. The Slot number IS the number Dan uses in chat to move/close a piece (corrected Aug 10) - a bare number means the active sprint's slot; name the block for others ("sprint 17 slot 3", "backlog 2"); it resets only on a new sprint. Claude resolves it against this view and confirms by title (the board_rows id itself is never shown anywhere). When pointing at a row, use its ticket key - it's the one identifier that's the same everywhere. Note is Claude's own working context, not Jira - Last Comment is meant to be the live Jira-side check but nothing writes it yet (danfeed follow-up). Auto-refreshes every 30s.</footer>
<script>
function show(w){for(const [id,name] of [['board','tb'],['pending','tp'],['research','tres'],['reminders','tr'],['workers','tw']]){document.getElementById(id).classList.toggle('on',id===w);document.getElementById(name).classList.toggle('on',id===w);}try{localStorage.setItem('atlasTab',w);}catch(e){}}
(function(){try{var t=localStorage.getItem('atlasTab');if(t==='pending'||t==='research'||t==='reminders'||t==='workers')show(t);}catch(e){}})();
// Jump links (e.g. the In Progress strip) can point at a row that's on the
// Board tab while a different tab is active - a plain #anchor can't scroll to
// something inside a display:none panel, so switch tabs first (Dan, 2026-08-11).
document.addEventListener('click', function(e){
  const a = e.target.closest('.jump-link');
  if (!a) return;
  e.preventDefault();
  show('board');
  const id = a.getAttribute('data-target');
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({block:'center'});
  location.hash = '#' + id;
});
setInterval(function(){location.reload();},30000);
</script>
</body></html>`;
}


// Slot map for /api (corrected numbering, Aug 10): the Slot on the view IS the
// number Dan speaks in chat, so the API must expose the exact same mapping the
// renderer produces - same grouping, same active-sprint pick, same GSSD-no-
// sprint default, same frozen sprint_slots, same recomputed backlog order.
// Returns Map(row_id -> { block, slot }) where block is 'sprint <N>',
// 'sprint <N> (active)' or 'backlog'.
function computeSlotMap() {
  let pieces = [];
  try { pieces = dbMod.listBoardRows(BOARD_SECTION, true); } catch (e) { return new Map(); }
  const live = pieces.filter((p) => p.status !== 'done');
  const bySprint = new Map();
  const backlogCandidates = [];
  for (const p of live) {
    const sp = (p.sprint || '').trim();
    if (!sp) { backlogCandidates.push(p); continue; }
    if (!bySprint.has(sp)) bySprint.set(sp, []);
    bySprint.get(sp).push(p);
  }
  const numericSort = (a, b) => {
    const na = parseFloat(a), nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  };
  const allSprints = [...bySprint.keys()].sort(numericSort);
  const inSprintSprints = [...new Set(live.filter((p) => p.in_sprint && p.sprint).map((p) => p.sprint))];
  const activeSprint = inSprintSprints.length ? inSprintSprints.slice().sort(numericSort)[0] : (allSprints[0] || '');
  const backlog = [];
  for (const p of backlogCandidates) {
    if (activeSprint && hasGssdKey(p.related)) bySprint.get(activeSprint).push(p);
    else backlog.push(p);
  }
  const oldestFirst = (rows) => [...rows].sort((a, b) => {
    const ka = a.source_date || a.created_at, kb = b.source_date || b.created_at;
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return a.id - b.id;
  });
  const map = new Map();
  for (const sp of allSprints) {
    try { dbMod.ensureSprintSlots(BOARD_SECTION, sp, oldestFirst(bySprint.get(sp)).map((p) => p.id)); } catch (e) {}
    let slots = [];
    try { slots = dbMod.getSprintSlots(BOARD_SECTION, sp); } catch (e) {}
    const block = 'sprint ' + sp + (sp === activeSprint ? ' (active)' : '');
    for (const s of slots) map.set(s.row_id, { block, slot: s.slot });
  }
  let n = 0;
  for (const p of oldestFirst(backlog)) map.set(p.id, { block: 'backlog', slot: ++n });
  return map;
}

const boardApp = express();
boardApp.get('/', (req, res) => { res.set('Content-Type', 'text/html; charset=utf-8'); res.send(renderBoard()); });
boardApp.get('/health', (req, res) => res.json({ ok: true, service: 'atlas-board', section: BOARD_SECTION, port: BOARD_PORT }));

// JSON feed of the board — what the SessionStart hook curls to inject the live
// board into Claude's context deterministically at every chat start. LAN, no auth.
boardApp.get('/api', (req, res) => {
  let pieces = [], pending = [], activity = [], research = [];
  try { pieces = dbMod.listBoardRows(BOARD_SECTION, false); } catch (e) {}
  try { pending = dbMod.listPending(BOARD_SECTION); } catch (e) {}
  try { activity = dbMod.recentActivity(BOARD_SECTION, 7); } catch (e) {}
  try { research = dbMod.listResearch(BOARD_SECTION); } catch (e) {}
  const rel = (r) => { try { return JSON.parse(r); } catch (e) { return [r]; } };
  const slotMap = computeSlotMap();
  res.json({
    as_of: boardStamp(),
    section: BOARD_SECTION,
    counts: { pieces: pieces.length, pending: pending.length, research: research.length },
    pieces: pieces.map((p) => ({ id: p.id, slot: (slotMap.get(p.id) || {}).slot ?? null, block: (slotMap.get(p.id) || {}).block ?? null, title: p.title, status: p.status, sprint: p.sprint, related: rel(p.related), waiting_on: p.waiting_on, last_comment: p.last_comment || null, pinned: p.priority !== null && p.priority !== undefined, queue_pos: p.queue_pos ?? null, needs_note: (p.status !== 'todo' && p.status !== 'done' && !(p.waiting_on && String(p.waiting_on).trim())), age_days: boardDaysSince(p.source_date || p.status_changed_at) })),
    // v18 ORDER band (additive field): Dan's declared work order as row ids, queue sequence.
    order: (() => { try { return dbMod.listOrderQueue(BOARD_SECTION); } catch (e) { return []; } })(),
    pending: pending.map((p) => ({ id: p.id, summary: p.summary, source: p.source, age_days: boardDaysSince(p.source_date || p.created_at) })),
    // v19 research shelf (additive field): Dan's own ideas - undated, unpressured, never nag on age.
    research: research.map((r) => ({ id: r.id, content: r.content, age_days: boardDaysSince(r.created_at) })),
    // Board v-next item 4: what moved or closed recently (additive field).
    activity: activity.map((a) => ({ row_id: a.row_id, title: a.title, related: rel(a.related), kind: a.kind, sprint: a.sprint, at: a.at })),
  });
});
boardApp.listen(BOARD_PORT, () => console.log('board view (read-only) on port ' + BOARD_PORT + ' section=' + BOARD_SECTION));
