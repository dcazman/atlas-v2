# Atlas

Atlas is a small, self-hosted MCP server that gives every Claude thread a shared "lay of
the land" — current state of projects/topics, plus a history log — split into `work` and
`personal` sections.

It is not a tool for humans. There is no UI. It exists so that any Claude thread can:

- get oriented at the start of a conversation (`get_landscape`)
- look up one topic in detail (`get_entity`), or fetch facts directly by id (`get_observation`)
- record what's true now (`upsert_entity`, `add_observation`, `remove_observation`)
- record what happened (`log_event`, `get_history`)
- find something when it doesn't know the exact name (`search`)
- get proactively reminded of something on/after a future date (`create_reminder`, `list_reminders`, `dismiss_reminder`, `remove_reminder`)

## Data model

Two sections: `work` and `personal`. Everything below is scoped to one of these.

- **entities** — topics/projects (e.g. "Linkhouse", "NJ House Sale", "RV Search"). Each
  has a `name` and an optional one-line `summary`.
- **observations** — individual facts attached to an entity. This is the "current state."
  Added, updated by re-adding, or removed as things change.
- **events** — append-only history log, optionally linked to an entity.
- **reminders** — time-based notes with a `trigger_date`. Once that date arrives,
  `get_landscape` starts including them (under a `reminders` key, alongside `entities`)
  until dismissed. Optionally linked to an entity.

Crossing sections (e.g. personal Claude reading/writing `work`) is allowed by the server —
there's no hard wall between them. The gate is conversational: Claude should only touch
the other section when the user explicitly says so (see project instructions below).

## Tools

| Tool | Purpose |
|---|---|
| `get_landscape(section)` | All entities + observations, plus any due reminders, for a section. Call at start of chat. |
| `get_entity(section, name)` | Full detail on one topic: summary, observations, recent events. |
| `get_observation(section, ids[])` | Fetch 1–20 observations directly by id (obs-number addressing). Scope resolves from each obs's actual section (own + shared); unresolvable ids return in `missing` identically whether deleted, never issued, or out of scope. |
| `upsert_entity(section, name, summary?)` | Create/update a topic's summary. |
| `remove_entity(section, name)` | Delete a topic and all its observations. |
| `add_observation(section, entity, content)` | Add a fact (creates entity if needed). |
| `update_observation(section, observation_id, content)` | Edit a fact in place — id stays stable, timestamp refreshes. Works on protected rows. |
| `protect_observation(section, observation_id)` | Mark a fact undeletable (update-only). |
| `unprotect_observation(section, observation_id)` | Lift protection. |
| `remove_observation(section, observation_id)` | Delete a stale/wrong fact. |
| `log_event(section, content, entity?)` | Append to history log. |
| `get_history(section, limit?, entity?)` | Recent history entries. |
| `search(section, query)` | Keyword search across entities, observations, events. |
| `create_reminder(section, content, trigger_date, entity?)` | Create a reminder that surfaces in `get_landscape` on/after `trigger_date` (YYYY-MM-DD). |
| `list_reminders(section, include_dismissed?)` | List reminders, including ones not yet due (or dismissed ones). |
| `list_due_reminders(section)` | Everything currently due and not dismissed: date-only reminders (trigger_date arrived, ET) — due until dismissed — plus timed reminders whose ET date+time has arrived and that have not yet fired. danfeed polls this and DMs only the timed rows. |
| `mark_reminder_fired(section, reminder_id)` | Stamp a TIMED reminder as delivered so it never re-fires. Date-only reminders have no firing step; they stay due until dismissed. |
| `dismiss_reminder(section, reminder_id)` | Mark a reminder handled - stops appearing in `get_landscape`, kept for history. |
| `remove_reminder(section, reminder_id)` | Permanently delete a reminder. |

## Running locally

```bash
npm install
cp .env.example .env   # set ATLAS_TOKEN
npm start
```

Server listens on `:7784` (override with `PORT`). Health check at `GET /health`.
MCP endpoint is `POST /atlas-mcp`, stateless Streamable HTTP — same shape as anchor-mcp's
`/mcp`. No GET/DELETE routes (matches anchor-mcp; unmatched methods just 404).

Auth: `ATLAS_TOKEN` is one or more `caller:secret` pairs (comma-separated), same
convention as anchor-mcp's `MCP_TOKEN`. Each request needs one of the secrets via
`?token=`, `x-atlas-token` header, or `Authorization: Bearer`.

No native dependencies — uses Node's built-in `node:sqlite`, so no node-gyp/build tools
needed in the image.

## Quick Reference

| | |
|--|--|
| **URL (internal)** | http://localhost:7784 |
| **Container** | `atlas` |
| **Image** | `dcazman/atlas:latest` (built locally on Gem, not pushed to Hub) |
| **Data volume** | `/mnt/user/appdata/atlas` → `/app/data` |
| **Repo** | `/warehouse/atlas` |
| **Token** | `/warehouse/atlas/.env` (gitignored) — `ATLAS_TOKEN=caller:secret` |

## Deploy / redeploy

```bash
cd /warehouse/atlas
docker build -t dcazman/atlas:latest .
docker stop atlas && docker rm atlas
source .env
docker run -d --name atlas --restart unless-stopped \
  -p 7784:7784 -e ATLAS_TOKEN=$ATLAS_TOKEN \
  -v /mnt/user/appdata/atlas:/app/data dcazman/atlas:latest
docker logs atlas
```

Remaining manual step: add a Cloudflare tunnel public hostname route,
`atlas.thecasmas.com` → `http://atlas:7784` (or `localhost:7784`), in the Zero Trust
dashboard — no local cloudflared config file found on this host to edit directly.

Data lives in the `./data` volume / `/mnt/user/appdata/atlas` (`atlas.db`, WAL mode).
Back it up like the other service DBs.

## Connecting Claude

Same as anchor-mcp, one connector URL with the token in the query string, added per
project (Settings → Connectors → Add custom connector):

```
https://atlas.thecasmas.com/atlas-mcp?token=<secret>
```

Same URL/token for both work and personal projects — each tool call takes a `section`
("work" or "personal") which is the actual data separation; the connector credential
doesn't need to differ. Project custom instructions (below) tell each project which
section is "home."

Note: the MCP endpoint is `/atlas-mcp`, not `/mcp` — `atlas.thecasmas.com/mcp` returns a
pre-origin 403 from something Cloudflare-side (not reproduced on
`mcp-home.thecasmas.com/mcp`), so the path was renamed to dodge it.

**Security — Phase 1 COMPLETE (July 2 2026):** mcp-auth-proxy (GitHub OAuth, `dcazman`
only) now fronts both this connector (`atlas.thecasmas.com` → proxy on 8080) and
Anchor-MCP (`mcp-anchor.thecasmas.com` → proxy on 8081). Confirmed working end-to-end
with real MCP client traffic. Ledger not yet protected — same recipe, not started.
Phase 2 (visibility layer: failed-login logging + known-connections GUI) and TOTP for
Anchor/Ledger remain separate, not-yet-started ideas. See "Planned / Ideas" in
`ATLAS.md` for full history including the Anchor debugging postmortem.

## Project custom instructions

Connecting Atlas sends most of this guidance automatically (the server's MCP
`instructions` field — sent on every `initialize`, see `src/server.js`). The **only**
thing that has to be set per project, because both projects share the same
connector/token, is which section is "yours." Add one line to each project's custom
instructions (Settings → that project → Custom instructions):

**Personal Claude project:**
```
Your Atlas section is "personal".
```

**Work Claude project:**
```
Your Atlas section is "work".
```

That's it — the rest (call `get_landscape` at the start of every chat, keep things
updated proactively, only cross sections when explicitly told) comes from the connection
itself.

---

*Built June 2026 · Dan Cazman · thecasmas.com · Unraid: Gem*

---

# ATLAS V2 (2026-07-09)

Everything above describes v1 and stays for history. v2 changes:

## Token scoping (the security fix)
- ATLAS_TOKEN format is now `caller:secret:scope`, comma-separated. Scope is mandatory; v1-format tokens are rejected at startup.
- Scopes: `work` -> sections work+shared. `personal` -> personal+shared. `shared` -> shared only.
- Enforcement is server-side on every tool call. Out-of-scope section = 403 error result, and the attempt is written to audit_log. A token can never reach the other section regardless of what the client asks for.
- Live tokens are in `.env` (sonos=work, home=personal, shared=shared).

## New tools (16 total now)
- `update_observation(section, observation_id, content)` — edit in place. ID stays stable for life, timestamp refreshes. Works on protected rows. Use instead of delete-and-recreate.
- `protect_observation` / `unprotect_observation` — protected rows refuse deletion (remove_observation refuses; remove_entity refuses if any child is protected). Protect skill files, standing rules, permanent URLs, incident lessons.

## Schema (migration is automatic + idempotent, guarded by PRAGMA user_version=2)
- section CHECK now allows 'shared' (entities/events/reminders rebuilt with all row IDs preserved)
- observations gained `protected INTEGER NOT NULL DEFAULT 0`
- new `audit_log` table: caller, tool, section, allowed, detail, created_at

## Deployment
- Container `atlas-v2`, image `dcazman/atlas:v2`, host port 7790 (internal 7784), DB /mnt/user/appdata/atlas-v2/atlas.db
- Public path unchanged: atlas.thecasmas.com -> cloudflared -> mcp-auth-proxy-atlas :8080 (GitHub OAuth) -> :7790
- v1 container `atlas` stopped but intact (rollback path); retire after ~1 week clean. Backups: atlas-backup-20260709.db in /mnt/user/appdata/atlas/ and /warehouse/atlas-backups/.
- Build/cutover/rollback runbook: /warehouse/ATLAS-V2-RUNBOOK.md (Atlas-independent — readable via anchor-mcp when Atlas is down)

---

# This instance (Dan's deployment) — added 2026-07-10

**Why v2 exists:** v1 had two sections (work/personal) and one shared token. v2 adds a third **shared** section that both work and personal Claude can read/write — the handoff channel — and scoped tokens so each Claude only reaches its own section plus shared.

## How it runs here

- Image: `dcazman/atlas:v2` · container `atlas-v2` · host port **7790** → 7784 inside (MCP) · host port **7795** = the board view + `/api` (BOARD_PORT, same container)
- Data: `/mnt/user/appdata/atlas-v2/atlas.db`
- Public URL: `atlas.thecasmas.com` → **mcp-auth-proxy-atlas** (port 8080, GitHub login, only `dcazman`) → localhost:7790
- `.env` in this folder: three scoped tokens (`sonos`=work, `home`=personal, `shared`) + `ANTHROPIC_API_KEY` for the groom worker. **Copies in Anchor vault note 308.**
- v1 (`atlas`, port 7784) is retired ~2026-07-16. The old `mcp-auth-proxy` compose stack on /boot still points at v1 — do not "compose up" that stack until it's fixed (audit item 3).

## Rebuild from zero

1. `cd /mnt/user/warehouse && git clone https://github.com/dcazman/atlas-v2.git` *(code backs up nightly at 02:00 — raid-backup job "atlas-v2")*
2. Restore data: the DB backs up nightly at 02:15 to the **`data-backup` branch** of the same repo (raid-backup job "atlas-v2-data"). Restore: `cd /mnt/user/appdata && git clone -b data-backup https://github.com/dcazman/atlas-v2.git atlas-v2`
3. Create `.env` from vault note 308.
4. Confirm `skills.json` exists at the repo root (regenerate per the Workers-tab note below if not — the Dockerfile `COPY`s it, so the build fails without it), then `docker compose up -d --build` (compose file corrected 2026-07 — image :v2, port 7790).
5. Bring up mcp-auth-proxy-atlas (OAuth creds in vault note 308, upstream **7790**).
6. Test from Claude: `get_landscape` on both work and personal should answer. Also check the board view: `http://192.168.50.23:7795` renders and `/api` returns the board JSON.
7. After ANY rebuild: Claude clients may hold a stale cached tool schema — if a session throws enum/validation errors on Atlas tools right after a rebuild, reconnect the Atlas connector in that client first; do not chase it as a code bug.

Full server rebuild order: `warehouse/UNRAID-REBUILD.md`.

---
*Recovery references: Atlas → personal → "Unraid Recovery Audit" obs #509 · Secrets: Anchor notes 308/309 · 2026-07-10*

---

# v3 / v4 — Structured Board (PCT-15801, 2026-07-27)

Atlas gained a typed, rule-enforcing **work board** — the prose board (a single big
observation, obs 801) reworked into structured rows Dan can SEE and correct. Design of
record: Atlas work obs **872** (schema), **874** (north star + operating model), **875**
(view-vs-store), **873** (governing rule: every rule is a DB fence, never a convention
someone must remember).

## Tables (migrations: user_version 3 added `board_rows`; 4 added require-ticket + `pending_items`)

**board_rows** — one row per piece of real work. "On the board => it has a ticket."
- `id` immutable PK (never reused = permanent address)
- `title`
- `status` CHECK in (active, waiting, blocked, done)
- `related` JSON array of ticket numbers — **NOT NULL + CHECK json_array_length >= 1** (a piece must carry ≥1 ticket)
- `waiting_on`
- `closure_ref` FK → events.id (the "ledger line"; the refuse-without-it trigger is item 3, not yet wired)
- `created_at` (lifespan clock), `updated_at`, `status_changed_at`
- Triggers: `board_rows_touch` bumps `updated_at` on every write; `board_rows_status_stamp`
  moves `status_changed_at` only on a real status change. The engine owns the clocks — no code path has to remember.

**pending_items** — the tray: candidates with no ticket yet.
- `id`, `section`, `source` (slack/jira/email/calendar/manual), `source_ref`, `summary`
- `state` CHECK in (pending, merged, promoted, dismissed) — non-pending = resolved: hidden from view, retained in store
- `merged_into` FK → board_rows.id (provenance link), `resolution_note`
- `created_at`, `resolved_at` (trigger `pending_items_resolve` stamps it the moment it leaves `pending`)

## Tools (11 new; 29 total)
`board_add` (related **required**), `board_list`, `board_get`, `board_update`, `board_close`, `board_reconcile` ·
`pending_add`, `pending_list`, `pending_merge`, `pending_promote`, `pending_dismiss`.
`board_close` writes a ledger event and sets done+closure_ref (the sanctioned close). `board_reconcile`
is a deterministic drift diff (drifted/orphaned/missing) vs a caller-supplied ticket snapshot (Jira or danfeed).
Lists are **oldest-first** (the order is the query, not memory). Merge/promote/dismiss each
leave an `events` trace and retain the row (nothing silently vanishes). Merge & promote are
**propose-then-confirm** — Claude proposes, Dan confirms; nothing auto-promotes.

## Read-only view
A plain HTTP page on **port 7795** (host-published, **LAN only — NOT on the Cloudflare
tunnel, so no auth gate**). Internal URL: **http://192.168.50.23:7795/**. Four tabs — Board,
Tray (pending), Reminders, and Workers — oldest-first, auto-refresh 30s. Renders straight off
the tables; done/merged/dismissed are dismissed-from-view but kept in the store (VIEW vs
STORE). Env: `BOARD_PORT` (7795), `BOARD_SECTION` (work). Served by a second Express
listener in `src/server.js`. No day-of view — Dan keeps his own calendar; the calendar is
Claude's input, not a rebuilt tab.

**Workers tab (added 2026-08-11):** top panel is a live `workers` table (name, status,
related ticket(s), title, `obs_id`, age) — one row per `/worker N <task>` run, so "what's my
worker doing" is a query, not a chase. CRUD via `worker_add` / `worker_list` / `worker_update`.
Bottom panel is a skills directory (name + description) read from `skills.json` at the repo
root — **that file is a static snapshot Claude generates from the real
`.claude/skills/*/SKILL.md` frontmatter** (those live on Dan's machine, not this server, so
the app can't read them live). **The Dockerfile's `COPY skills.json ./skills.json` means the
image build FAILS if that file is missing** — it must exist (and be committed) before running
`docker build`/`docker compose up --build`. If it's ever lost: regenerate it by reading every
skill's frontmatter (`name` + `description` between the `---` markers) into a JSON array of
`{name, description}` objects, alphabetical by name, and write it to
`/warehouse/atlas-v2/skills.json`.

## Lifecycle fences (item 3)
Two triggers: `board_rows_close_needs_ledger` (status=done is refused unless `closure_ref` is set — no
close without a ledger line) and `board_rows_no_delete` (pieces are never hard-deleted; retire by closing).

## Boot hook + `/api`
`GET /api` on the board server returns the live board as JSON (LAN, no auth). The Claude Code SessionStart
hook curls it and injects the board into context at every new chat, then instructs a `board_reconcile`
against Jira/danfeed. Deterministic board-in-context; the auto-drift-in-hook rides the danfeed upgrade.

## Trust / act-vs-ask
Claude decides act-vs-ask by the Trust model (Atlas shared obs 879) + Known Traps floor (obs 880): act on
source-confirmed facts, propose on judgment, hard must-ask floors for irreversible/trap/low-confidence. The
`/agenda` skill (`.claude/skills/agenda`) runs the full routine under this model.

## Status / remaining
Built & deployed (user_version 4), branded **ATLAS**. Phase 2 items 1–4 done: typed board, require-ticket,
pending tray, lifecycle fences, reconcile, read-only view (port 7795), boot hook, trust model. Board seeded
2026-07-27 (13 pieces + 2 pending). **Remaining:** danfeed→pending auto-feed and auto-drift-injection in the
hook (both ride the danfeed upgrade — Atlas side is ready via `pending_add` + `board_reconcile`); Phase 3
session anchor. Until the auto-feed lands, the board is reconcile-on-demand, not self-updating.

*Board built by the c-atlas conductor thread, 2026-07-27/28.*

---

# Board v-next — SHIPPED (2026-08-10)

Design of record: Atlas work obs **979** (build list), **980** (frozen sprint
numbering), **984** (access model). Built + deployed by the c-board worker
thread. All five items are live in `src/server.js` + `src/db.js`:

1. **Sprint-grouped reorder.** The read-only view groups live pieces into a
   block per sprint (active sprint first, oldest-first within each), plus a
   Backlog block for pieces with no sprint. On Hold pieces stay **inside**
   their sprint block, greyed — no longer exiled to the bottom of the whole
   board. "Active sprint" = the lowest-numbered sprint (sprints are
   sequential; `in_sprint=1` is preferred as a signal when danfeed actually
   populates it, but as of this writing it does not, so the lowest-number
   fallback is what's really running in prod).
2. **Reminders tab** — shipped 2026-07-31 (unchanged by this pass).
3. **Pin decoupled from status.** `bumpBoardRow`/`moveBoardRow` only ever
   write `priority`. Fixed a real bug: `moveBoardRow` used to silently un-hold
   a held piece to To Do just because it got pinned/reordered — that's the
   ghost-ticket trap Dan flagged (Jira says "working it" when he only
   reordered). A held piece can now be pinned and will render on-hold
   (greyed) at its new slot.
4. **Activity strip.** A slim strip above the tabs, last 7 days: status
   changes (closed/started/held/back-to-todo) and cross-sprint moves. Backed
   by `db.recentActivity()`; no new table, derived from `board_rows` +
   `sprint_slots`.
5. **Frozen per-sprint numbering.** New `sprint_slots` table (migration v15):
   a slot is assigned once per `(section, sprint, row)`, oldest-first, the
   first time that sprint is rendered, and never recomputed — only appended
   to. A row keeps its slot through in_progress/on_hold; closing crosses it
   out in place (free history); leaving the sprint leaves a dim "→ S17"
   ghost at the old slot while the row earns a fresh slot in its new sprint.

Also done earlier and untouched by this pass: the PCT-15634 duplicate board
row dedupe (obs 979's "also").

## ORDER band (added 2026-08-12, c-order worker)

Dan's declared work order — "order 10, 5, 1" — without pinning. `board_order`
takes `row_ids` in sequence and REPLACES the whole queue (`[]` clears it);
stored in `board_rows.queue_pos` (migration v18, NULL = not queued). Renders
as a grey band under the In Progress strip, pieces in queue sequence with
their normal frozen Slot numbers; hidden when empty. **Pure intention:** Jira
is never touched, statuses and frozen Slots never change. A piece drops out
automatically when pinned (`board_bump`/`board_move`), closed, or offboarded
(the rest keep their relative order); On Hold keeps it. `/api` exposes a
top-level `order` array (row ids, queue sequence) and per-piece `queue_pos` —
both additive, the existing shape is unchanged.

## Two numbers — the one Dan speaks is the SLOT (corrected 2026-08-10)

The original v-next writeup here described THREE numbers, with the "chat/agenda
running position" (whole-board 1..N recomputed each render) as the number Dan
speaks. **That was wrong in practice and caused a real incident on Aug 10**:
Dan said "pin 2" reading his screen (Sprint 16 Slot 2 = PCT-15853) and Claude
resolved it through the running order to a 1266-day-old backlog ticket
(PCT-9405), wrongly transitioning it in Jira. The running position is DEAD as
a spoken number. What remains:

| # | What it is | Where it appears | Who/what uses it |
|---|---|---|---|
| **the plate** (`board_rows.id`) | The true immutable database primary key. | **Nowhere Dan-facing.** Internal only — the `row_id` param every `board_*` MCP tool takes under the hood. | Tools/danfeed, so the right row is always hit. |
| **the Slot** | 1..N within one sprint's block, frozen at first render, append-only, resets only on a new sprint (backlog block: recomputed oldest-first). | The **"Slot"** column on the web view (`http://192.168.50.23:7795/`), the same numbers printed by `/agenda` (grouped by block), and per-piece `slot` + `block` fields in `/api`. | **This IS the number Dan speaks.** A bare number = the active sprint's slot; other blocks by name ("sprint 17 slot 3", "backlog 2"). Claude resolves via `/api` (same grouping/frozen-slot code as the renderer) and **confirms by title** before calling any tool. |

**The ticket key** (`PCT-XXXX` / `GSSD-XXXX`) remains the one identifier that
is the same everywhere — when in doubt, use the key. The view's Slot tooltip
and page footer state the corrected semantics at the point of use.

## Note vs Last Comment - two different things on purpose (obs 1086)

Added same day, after a real incident: PCT-16053's own Jira description
named the wrong person for a sign-off (mixed up two people sharing a first
name), and the board's waiting_on note just carried that forward with no
way to tell it had gone stale.

- **Note** (column waiting_on) is, and always was, Claude's own internal
  musing/context - never assumed to mirror the real ticket. Re-check Jira
  before repeating an existing note forward; don't just carry it.
- **Last Comment** (new column last_comment, migration v16) is meant to
  show the actual live Jira comment, so ticket-side truth and Claude's own
  note sit side by side and are visibly two different things.
- **This pass only added the column** (schema + board_update param + view
  display, currently blank for every row). It does NOT add any
  Jira-fetching code to atlas-v2 - this service deliberately has no Jira
  credential. Populating last_comment live is an open follow-up for
  whoever next touches danfeed (it already polls Jira for status /
  sprint / in_sprint the same way); polling-vs-on-demand and rate-limit
  handling are that follow-up's call to make, not decided here.

## Two more view refinements (same day)

- **Activity strip links to rows.** Each entry is now `<a href="#row-KEY">`
  pointing at that row's anchor id (every rendered row carries `id="row-<ticket
  key>"`); clicking jumps/scrolls straight to it with a brief highlight flash.
- **GSSD pile.** Pieces carrying a raw `GSSD-*` key in `related` cluster as
  one group at the **bottom of their own sprint block** - same "stays inside
  its sprint block" rule On Hold already follows, just a lower position
  within it, so they read as "the service-desk pile" at a glance instead of
  scattered by age among the planned PCT stories. Display-order only - the
  frozen Slot **number** a row already has is untouched.
  **Fix (same day):** GSSD tickets carry no Jira sprint field at all, so
  every GSSD piece had sprint='' and landed in Backlog - never reaching this
  pile, which was exactly the forgettable spot it exists to avoid. A
  GSSD-tagged piece with no sprint now defaults into the **active** sprint's
  block instead. Non-GSSD sprint-less pieces still go to Backlog.
- Workflow rule (not built here, board-ops skill only): GSSD pieces now get
  a fresh public Jira comment on a real cadence even while On Hold ("Pending
  review this week" style), stricter than the normal hold-comment rule.

*Board v-next shipped by the c-board worker thread, 2026-08-10.*

# Hybrid search / RAG — SHIPPED (2026-08-15)

Design agreed by work-Claude (obs 1304) and reviewed/approved on the
personal side (obs 1306), both on the shared entity "Atlas RAG / Semantic
Search (Design)". Built and deployed same day.

**What it is:** the existing `search` tool is now hybrid keyword + semantic.
Every observation write is embedded in-process (no change to callers, no new
tool). Results are merged/deduped and each observation is tagged
`match: "keyword"` or `match: "semantic"` (semantic hits also carry a
`score`).

**Stack:**
- `src/embeddings.js` — `@huggingface/transformers`, model
  `Xenova/all-MiniLM-L6-v2` (384-dim), lazy-loaded pipeline, mean-pooled +
  L2-normalized so cosine similarity = plain dot product.
- New `embeddings` table (`obs_id` PK, `vector` BLOB, `model`,
  `embedded_at`) — separate table, not a column, so a future model change is
  a table wipe, not a migration.
- `addObservation` fires an async, best-effort embed after every insert.
  Never blocks or throws on the write path — a failed embed just leaves the
  row uncovered until the next sweep.
- `backfillMissingEmbeddings()` runs 5s after server boot, sweeps any
  observation without an `embeddings` row (new failures + the one-time
  backfill of pre-existing data). Idempotent, safe to run repeatedly.
- `db.hybridSearch(section, query)` — keyword pass unchanged, plus a
  brute-force cosine pass over that section's embedded observations
  (`minScore` 0.35, top 8). Degrades silently to keyword-only if the
  semantic pass throws for any reason (model not loaded, nothing embedded
  yet, etc.) — `search` never fails because of this.

**Deploy notes / real gotchas hit along the way:**
- `onnxruntime-node`'s prebuilt binary needs real glibc. The base image was
  `node:22-alpine` (musl) — first build failed outright (missing
  `ld-linux-x86-64.so.2`). Adding `gcompat` got past that but then failed on
  unresolved fortify symbols (`__vsnprintf_chk`) — gcompat's shim doesn't
  cover those. Fix: switched base image to **`node:22-slim`** (Debian,
  glibc). This is now a real dependency of the RAG feature, not a style
  choice — don't revert to Alpine without re-solving this.
- Model is prefetched at **build time** (`scripts/prefetch-model.js`, run
  during `docker build`, baked into `./models`) so the running container
  never calls out to HuggingFace. `env.allowRemoteModels = false` at
  runtime enforces this.
- One-time backfill of pre-existing observations ran automatically on first
  boot after deploy: **366 embedded**, completed within seconds of boot, no
  manual step needed.
- Rollback path: previous image tagged `dcazman/atlas:pre-rag-rollback`
  before rebuild. Schema change is additive-only (new table, nothing
  altered/dropped), so rollback is a straight image swap with no data
  migration needed either direction.
- Verified live post-deploy with a real query with zero keyword overlap
  against the actual note text ("indoor growing without soil" → matched
  observations mentioning "Dutch bucket system", "hydroponic", "aeroponic"
  etc., scores 0.40–0.44, tagged `match: "semantic"`).

*Shipped 2026-08-15, personal-side session, with Anchor-MCP direct access to
the Unraid host (build, test container, live deploy). Scope: observations
only (v1, as designed) — entities/events/board rows can join later per the
original design.*

# Core memory tier — SHIPPED (2026-08-20)

Design from a Dan + personal Claude talk-only session, full reasoning in
`design/CORE-MEMORY-DESIGN.md`. Shared entity: "Atlas Core Memory Tier
(Design)".

**The problem:** `get_landscape` returned every entity in a section, no
bound. Confirmed on this host: `all=true` on work+shared returned 668,939
chars — not driven by entity count or any one oversized observation, just
the lack of a bound on the default call.

**What it is:** a bounded "working memory" tier, modeled on MemGPT's
explicit core-memory design (deliberately chosen over MemoryBank's
automatic recency/decay scoring — Atlas is already all-explicit-tool-call,
and a board row can point at something that's gone quiet for weeks but
still matters, so nothing should evict itself silently).

- `entities.core` (INTEGER, default 0) — v23 migration, additive/idempotent.
- `get_landscape(section)` now returns only `core=1` entities + due
  reminders by default (`view: "core"` in the response). Pass `all: true`
  for the old full-dump behavior (`view: "all"`) — kept as the deliberate
  worst case, not the normal path.
- `promote_entity` / `evict_entity` (new tools) toggle the flag by entity
  name. Eviction never deletes — the entity stays fully intact and
  reachable via `get_entity` or `search`, just out of the default view.
- Nothing is auto-promoted, ever — not on creation, not on write. A brand
  new entity starts at `core=0` like everything else; something has to
  deliberately call `promote_entity`.
- `groom.js` flags `core=1` entities untouched for 5+ days as "STALE CORE"
  findings in the Groom Report — same report-only spirit as the rest of
  groom, no auto-eviction.

**Deploy notes / real gotchas hit along the way:**
- Confirmed via dry run against a copy of the live DB (`docker cp` out,
  tested with the modified `db.js` inside a throwaway path in the `atlas-v2`
  container, `ATLAS_DB_PATH` pointed at the copy) before touching anything
  live — reproduced the exact 668,939-char figure, then verified
  promote/evict/eviction-doesn't-delete all behave as designed.
- `docker compose ... up -d --force-recreate`, run from the anchor-mcp
  container, failed with `env file /mnt/user/warehouse/atlas-v2/.env not
  found` — `docker-compose.yml`'s `env_file` is an absolute host path, and
  this container only has `/warehouse` mounted, not `/mnt/user` (see
  RUNBOOK's existing note on this same limitation). Worked around by
  mirroring `.env` to that same path inside this container
  (`mkdir -p /mnt/user/warehouse/atlas-v2 && cp .env` into it) so the
  `docker compose` CLI running here could resolve it. The mirror is left in
  place so the next deploy from this container doesn't hit the same wall -
  if `.env` ever changes, re-copy it.
- No schema rollback needed either direction: the migration is a single
  additive column with a default, so an old binary against a
  post-migration DB just never reads/writes the new column.
- Verified live post-deploy: image/container source hashes matched
  (`docker exec atlas-v2 md5sum /app/src/*.js` vs the repo), both health
  endpoints responded, and a real `get_landscape` call through the actual
  MCP connection returned `{"entities": [], "reminders": [], "view":
  "core"}` — empty because nothing had been promoted yet, exactly as
  designed.

*Shipped 2026-08-20. Talk-only design session first (MemGPT vs MemoryBank
research, the "now / area" chess analogy), explicit build only after Dan
said go.*
