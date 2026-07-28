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

- Image: `dcazman/atlas:v2` · container `atlas-v2` · host port **7790** → 7784 inside
- Data: `/mnt/user/appdata/atlas-v2/atlas.db`
- Public URL: `atlas.thecasmas.com` → **mcp-auth-proxy-atlas** (port 8080, GitHub login, only `dcazman`) → localhost:7790
- `.env` in this folder: three scoped tokens (`sonos`=work, `home`=personal, `shared`) + `ANTHROPIC_API_KEY` for the groom worker. **Copies in Anchor vault note 308.**
- v1 (`atlas`, port 7784) is retired ~2026-07-16. The old `mcp-auth-proxy` compose stack on /boot still points at v1 — do not "compose up" that stack until it's fixed (audit item 3).

## Rebuild from zero

1. `cd /mnt/user/warehouse && git clone https://github.com/dcazman/atlas-v2.git` *(repo being created — until then this folder is the only copy of the code)*
2. Restore data: clone the atlas-v2 data backup into `/mnt/user/appdata/atlas-v2` *(backup job being added — audit item 1; until then the DB exists ONLY on this server)*
3. Create `.env` from vault note 308.
4. `docker compose up -d --build` (compose file corrected 2026-07 — image :v2, port 7790).
5. Bring up mcp-auth-proxy-atlas (OAuth creds in vault note 308, upstream **7790**).
6. Test from Claude: `get_landscape` on both work and personal should answer.

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

## Tools (9 new; 27 total)
`board_add` (related **required**), `board_list`, `board_get`, `board_update` ·
`pending_add`, `pending_list`, `pending_merge`, `pending_promote`, `pending_dismiss`.
Lists are **oldest-first** (the order is the query, not memory). Merge/promote/dismiss each
leave an `events` trace and retain the row (nothing silently vanishes). Merge & promote are
**propose-then-confirm** — Claude proposes, Dan confirms; nothing auto-promotes.

## Read-only view
A plain HTTP page on **port 7795** (host-published, **LAN only — NOT on the Cloudflare
tunnel, so no auth gate**). Internal URL: **http://192.168.50.23:7795/**. Two tabs (Jira
Board / Pending), oldest-first, auto-refresh 30s. Renders straight off the tables;
done/merged/dismissed are dismissed-from-view but kept in the store (VIEW vs STORE). Env:
`BOARD_PORT` (7795), `BOARD_SECTION` (work). Served by a second Express listener in
`src/server.js`. No day-of view — Dan keeps his own calendar; the calendar is Claude's input, not a rebuilt tab.

## Status / remaining
Built & deployed (user_version 4). Board seeded 2026-07-27 with 13 real pieces + 2 pending.
**Not yet built:** item-3 close/delete refuse-without-`closure_ref` trigger; danfeed→pending
auto-feed; reconcile-at-boot fence (board self-checks vs Jira/danfeed). **Until reconcile
exists the seed is a manual snapshot and will drift** — trust it to *see and correct*, not blind.

*Board added by the c-atlas conductor thread, 2026-07-27.*
