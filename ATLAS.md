# Atlas

## What this is

Atlas is a small, self-hosted MCP server whose only job is to give every Claude thread —
work or personal, any conversation, any time — a shared sense of "what's going on."

The problem it solves: each Claude conversation starts from zero. If Dan tells one
thread about a decision, change, or piece of infrastructure, no other thread knows about
it unless Dan repeats himself. Atlas is a small shared landscape that any Claude can read
at the start of a conversation and write to as things change, so that stops happening.

It is explicitly **not** a tool for Dan. There's no UI, and he doesn't need to read or
maintain it directly — Claude does that.

## Data model

Two sections: `work` and `personal`. Each tool call takes a `section` argument — that's
the actual separation between work and personal data ("different tables"), not a
different credential. Both projects use the same connector and the same token.

Within a section:

- **entities** — topics/projects (e.g. "Linkhouse", "RV Search", "Atlas" itself). Each
  has a `name` and an optional one-line `summary`.
- **observations** — individual facts attached to an entity. This is "current state" —
  added, updated, or removed as things change. Claude is expected to keep this current
  (upsert in place, remove stale facts) rather than let it grow forever.
- **events** — append-only history log, optionally linked to an entity. "What happened
  and when."
- **reminders** — a fact with a future `trigger_date`. Invisible until that date, then
  shows up automatically in `get_landscape` (under a `reminders` key) without Dan having
  to bring it up. Stays visible until dismissed (kept, marked handled) or removed
  (deleted outright). Optionally linked to an entity, same as observations/events.

Crossing sections (e.g. personal Claude reading or writing `work`) is technically
unrestricted — the gate is conversational. Claude only does this when Dan explicitly
says so ("go look at work for X", "write that for work too"). Otherwise each project
stays in its own section.

## Tools (18 total)

| Tool | Purpose |
|---|---|
| `get_landscape(section)` | All entities + observations, plus any due reminders, for a section. Shared section is auto-merged in (entities/reminders tagged with origin `section`) — any pull from work or personal sees shared without prompting. Writes stay explicit per-section. Call at start of chat. |
| `get_time()` | Current date/time (America/New_York) + elapsed time since your token's last Atlas call. Very cheap. Call on any turn involving dates/scheduling/elapsed time when you haven't touched Atlas this turn. Never do date math from memory. |
| `get_entity(section, name)` | Full detail on one topic: summary, observations, recent events. |
| `get_observation(section, ids[])` | Fetch 1–20 observations directly by id — the fetch half of obs-number addressing ("Section work, obs 800"). Scope resolves from each obs's ACTUAL section (own + shared), never from the section argument; out-of-scope and nonexistent ids come back identically in `missing` (no scope probing). Ids are AUTOINCREMENT, never recycled — a missing id was deleted or never issued; deleted topics may have a headstone in The Ledger (graveyard). Added 2026-07-20. |
| `update_observation(section, observation_id, content)` | Edit a fact in place — id stays stable for life (permanent address), timestamp refreshes. Works on protected rows. |
| `protect_observation(section, observation_id)` | Mark a fact undeletable (update-only). For skill files, standing rules, incident lessons. |
| `unprotect_observation(section, observation_id)` | Lift protection so a fact can be deleted again. |
| `upsert_entity(section, name, summary?)` | Create/update a topic's summary. |
| `remove_entity(section, name)` | Delete a topic and all its observations. |
| `add_observation(section, entity, content)` | Add a fact (creates entity if needed). |
| `remove_observation(section, observation_id)` | Delete a stale/wrong fact. |
| `log_event(section, content, entity?)` | Append to history log. |
| `get_history(section, limit?, entity?)` | Recent history entries. |
| `search(section, query)` | Keyword search across entities, observations, events. |
| `create_reminder(section, content, trigger_date, entity?)` | Create a reminder that surfaces in `get_landscape` on/after `trigger_date` (YYYY-MM-DD). |
| `list_reminders(section, include_dismissed?)` | List reminders, including not-yet-due or dismissed ones (`get_landscape` only shows due ones). |
| `dismiss_reminder(section, reminder_id)` | Mark handled - stops showing up, kept for history. |
| `remove_reminder(section, reminder_id)` | Permanently delete a reminder. |

### Reminders design notes (added June 30 2026)

The need: things like cert/license expirations shouldn't depend on Dan remembering to
bring them up. A reminder is a `reminders` row (`section`, `content`, `trigger_date`,
optional `entity_id`, `dismissed_at`). `getActiveReminders()` filters
`trigger_date <= date('now') AND dismissed_at IS NULL`, and `getLandscape()` now returns
`{ reminders: [...], entities: [...] }` instead of a bare entity array - a breaking shape
change for anything that destructured the old array directly, but Claude reads this as
JSON fresh each session so it's a non-issue in practice.

Deliberately simple: date granularity only (no time-of-day), no recurrence, no severity
levels. A reminder is due or it isn't. `dismiss_reminder` (soft - keeps the row, visible
via `list_reminders(include_dismissed=true)`) is separate from `remove_reminder` (hard
delete) so a handled reminder's record can be kept or not, Dan's choice.

First reminder created (inserted directly via `docker exec atlas node -e ...` calling
`db.createReminder()`, since the session that built this had already cached the old
9-tool list before the redeploy - the new tools are visible to fresh sessions going
forward): work section, "Apple Push Cert renewal — expires September 2026. Viktor did NOT
renew. Dan owns it. Action needed now.", trigger_date 2026-08-01, linked to entity
"Apple Push Cert".

## Stack & deployment

- Node/Express + Node's built-in `node:sqlite` (experimental but works fine on Node 22) —
  **no native dependencies**, so the Docker build needs nothing beyond `npm install`.
- Single file per concern: `src/db.js` (schema + queries), `src/tools.js` (MCP tool
  definitions), `src/server.js` (Express app + auth + MCP transport).
- Runs as Docker container `atlas` on Gem (Unraid), port `7784`, image
  `dcazman/atlas:latest` (built locally, not pushed to Docker Hub — nothing on this host
  is logged into a registry).
- Data: `/mnt/user/appdata/atlas/atlas.db` (SQLite, WAL mode).
- Repo: `/warehouse/atlas`, git-initialized, full build history in the commit log.
- Public URL: `https://atlas.thecasmas.com`, via the existing Cloudflare tunnel
  (`cloudflared-home`).

### Redeploy

```bash
cd /warehouse/atlas
docker build -t dcazman/atlas:latest .
docker stop atlas && docker rm atlas
source .env
docker run -d --name atlas --restart unless-stopped \
  -p 7784:7784 -e ATLAS_TOKEN=$ATLAS_TOKEN \
  -v /mnt/user/appdata/atlas:/app/data dcazman/atlas:latest
```

## Connecting a Claude project

Add as a custom connector (Settings → Connectors → Add custom connector):

```
https://atlas.thecasmas.com/atlas-mcp?token=<see .env or Anchor pending notes>
```

Same URL/token for every project — `section` on each tool call is what differs. Add the
matching project custom instructions block from `README.md` to each project (tells
Claude its home section and to call `get_landscape` proactively at the start of chats and
keep things updated as it goes).

## How this was built (and the one big gotcha)

Built in one session, June 14 2026. The design went through a few iterations before
landing here — worth knowing if you're reading the git history and wondering why early
commits look more complicated:

1. **First pass**: per-project tokens (`work-claude:secret`, `personal-claude:secret`),
   modeled after a misreading of how Anchor-MCP's auth worked.
2. **OAuth detour**: Claude.ai's custom connector UI has no field for a Bearer token or
   header — only authless or OAuth. Built a full OAuth 2.1 shim (discovery, dynamic
   client registration, PKCE, a one-time "enter your token" page) to satisfy that.
3. **Simplification**: after looking at anchor-mcp's actual code, realized it's just a
   single `caller:secret` token via `?token=`/header, with **no** OAuth — and yet it
   works as a connector. Stripped the OAuth shim entirely and matched anchor-mcp
   byte-for-byte: one token, `POST /atlas-mcp` only, no GET/DELETE routes.
4. **The real bug**: even matching anchor-mcp exactly, adding the connector still failed
   with "Couldn't register with atlas-mcp's sign-in service." Root cause was **not**
   Atlas at all — it was a Cloudflare zone-level security rule, **"Allow MCP Claude
   Code"** (action: Skip), which exempts specific hostnames from a separate "MCP Rate
   Limit" (Block) rule. `mcp-home.thecasmas.com` was in that allowlist; `atlas.thecasmas.com`
   wasn't. Every `/mcp`-ish request to atlas.thecasmas.com — including Claude.ai's
   connector-setup probes — was getting blocked by Cloudflare before it ever reached the
   server, which is why even a perfect server-side match to anchor-mcp didn't help.
5. **Fix**: added `atlas.thecasmas.com` to the "Allow MCP Claude Code" rule's hostname
   list (same Skip rule mcp-home.thecasmas.com is in). Connector worked immediately
   after.

**If you ever add another MCP server on a new `*.thecasmas.com` subdomain and the
Claude.ai connector fails with "Couldn't register with X's sign-in service" despite the
server looking correct, check this Cloudflare rule first** (Security → Security rules →
Custom rules → "Allow MCP Claude Code"). It needs the new hostname added to its `http.host
eq "..."` OR-list.

## Planned / Ideas

**MCP Auth Gateway (2FA)** — [REVIVED / RESCOPED, July 2 2026] Google Authenticator
(TOTP) layer in addition to Cloudflare, in front of **Anchor** (`mcp-anchor.thecasmas.com`)
and **Ledger** (`ledger.thecasmas.com`, port 7783) specifically — no longer a fully
general any-app gateway. Distinct from "MCP Protect App" below (which is Atlas + Anchor
via mcp-auth-proxy OAuth, already locked in) — this adds TOTP on top of/alongside that
for Anchor, and newly brings Ledger into scope even though Ledger isn't an MCP server.
Concept stage only, nothing built. See personal Atlas entity "MCP Auth Gateway (2FA /
brute-force block)".

**MCP Protect App** — [FINAL PHASED PLAN LOCKED IN — July 2 2026]

**Phase 1 (deploy now, when back at PC):** mcp-auth-proxy (sigbit) in front of whichever
apps Dan wants protected — Atlas (`atlas.thecasmas.com`), Anchor-MCP
(`mcp-anchor.thecasmas.com`), and/or Ledger (port 7783, `ledger.thecasmas.com`). Despite
the name, mcp-auth-proxy is a generic OAuth gate for any HTTP backend, not MCP-specific —
each protected app is just another instance/config block pointed at it (config-per-app,
add or remove as needed; target shape is a YAML list of app name / upstream URL /
hostname / auth type). This phase alone delivers: (1) an OAuth login requirement blocking
access even if a URL leaks, and (2) rotate-on-demand as the emergency cutoff — changing
the OAuth allowlist/app credentials instantly kicks everyone and forces re-auth. Nothing
else gets built until Phase 1 is deployed and working.

**Phase 1 kickoff (July 2 2026):** starting with **Atlas** first (not Anchor/Ledger yet —
prove it on one before expanding). IdP choice: **GitHub OAuth** (not Google) — ties to
Dan's existing dev identity. GitHub OAuth App setup: Homepage URL = external URL (e.g.
`https://atlas.thecasmas.com`), Authorization callback URL =
`{external-url}/.auth/github/callback` (confirmed from official docs). Leave **Device
Flow disabled** — mcp-auth-proxy uses the standard callback-redirect flow, not GitHub's
browserless Device Flow. Config flags needed: `--github-client-id`,
`--github-client-secret`, `--github-allowed-users` (or `--github-allowed-orgs`). Deploy
mcp-auth-proxy pointed at Atlas's local port — **correction: Atlas runs on port 7784**,
not 1234 (1234 is Anchor's port, was mixed up earlier).

Docker Compose draft:
```yaml
services:
  mcp-auth-proxy-atlas:
    image: ghcr.io/sigbit/mcp-auth-proxy:latest
    container_name: mcp-auth-proxy-atlas
    restart: unless-stopped
    ports: ["8443:443", "8080:80"]
    environment:
      - EXTERNAL_URL=https://atlas.thecasmas.com
      - GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}
      - GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}
      - GITHUB_ALLOWED_USERS=<dan-github-username>
    command:
      - "--external-url=https://atlas.thecasmas.com"
      - "--tls-accept-tos"
      - "--"
      - "http://atlas:7784"
```

Open items before deploy: (1) Cloudflare tunnel needs to route to this proxy's port
instead of straight to Atlas's 7784, so Atlas becomes unreachable except through the
proxy. (2) **TLS mode confirmed: `--no-auto-tls`** (NOT `--no-tls`, which doesn't exist —
first deploy attempt crashed with "unknown flag: --no-tls") — cloudflared-home tunnel
(remotely managed via Zero Trust dashboard, no local config.yml) terminates TLS itself;
container side is plain HTTP. `--no-auto-tls` disables the proxy's automatic TLS
self-provisioning that it would otherwise attempt since `--external-url` uses `https://`.

Updated Docker Compose (final for Phase 1 / Atlas):
```yaml
services:
  mcp-auth-proxy-atlas:
    image: ghcr.io/sigbit/mcp-auth-proxy:latest
    container_name: mcp-auth-proxy-atlas
    restart: unless-stopped
    ports: ["8080:80"]
    environment:
      - EXTERNAL_URL=https://atlas.thecasmas.com
      - GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}
      - GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}
      - GITHUB_ALLOWED_USERS=dcazman
    command:
      - "--external-url=https://atlas.thecasmas.com"
      - "--no-auto-tls"
      - "--"
      - "http://192.168.50.23:7784"
```
NOTE: backend target must be `http://192.168.50.23:7784` (host IP), NOT
`http://atlas:7784` — container-name DNS fails because mcp-auth-proxy-atlas and the atlas
container aren't on the same Docker network (`dial tcp: lookup atlas on 127.0.0.11:53: no
such host`). Same root cause as the earlier Cloudflare tunnel fix — use host IP
everywhere for this pairing.

**GitHub OAuth login flow confirmed fully working** (July 2 2026): redirect to GitHub,
login, and token exchange all succeeded per proxy logs. The only remaining bug was this
backend DNS issue above. Note: stale `/.auth/github/callback` URLs return 500 on
refresh/retry — expected, codes are single-use, not a bug.

**Phase 1 for Atlas is DONE and verified working (July 2 2026).** Confirmed with a real
MCP client: this chat's own Atlas connector authenticated through the proxy successfully
(`POST /atlas-mcp` → 202 then 200 in proxy logs). Also clarified: a browser visiting bare
`/` will always return 401 even after a successful GitHub login — that's expected, not a
bug. mcp-auth-proxy isn't a browsable site; a GitHub login only grants a valid
session/token for the actual MCP endpoint, not a generic homepage. Don't test this by
browsing to `/` — test via an actual MCP client connection instead.

**Connecting a DIFFERENT Claude instance (e.g. work Claude) to a protected MCP server:**
nothing special to configure manually. Just add/reconnect the connector pointed at the
normal URL (e.g. `https://atlas.thecasmas.com/atlas-mcp`). Claude will hit the auth wall
automatically, register itself as an OAuth client, and prompt a GitHub login. Log in once
with GitHub (must be an allowed user per `--github-allowed-users`) and that Claude
instance gets its own valid session — same mechanism already proven working. No manual
URLs, tokens, or config need to be shared — just tell the other Claude/user to reconnect
and log in with GitHub when prompted.

Cloudflare tunnel Service URL: original was `http://192.168.50.23:7784` (LAN IP, not a
Docker container name — cloudflared isn't on the proxy's Docker network). Correct new
value is **`http://192.168.50.23:8080`** — same host IP, new port for the proxy's
published `8080:80` mapping. NOT `http://mcp-auth-proxy-atlas:8080` (container-name
resolution won't work here).

Full flag reference captured from live `--help` output for future reference: supports
google/github/oidc/password auth, `--repository-backend` (local/sqlite/postgres/mysql)
for session persistence, `--header-mapping` for forwarding claims to the backend,
`--trusted-proxies`, `--proxy-forward-authorization`. Note for Phase 2: setting
`--repository-backend sqlite` could directly feed the known-connections GUI idea without
extra tooling, since sessions would already persist to a queryable SQLite file.

Steps: deploy mcp-auth-proxy (binary or Docker, one instance/config block per app) →
Google OAuth with locked-down allowed user email(s) → route through the existing
Cloudflare tunnel on a subdomain per proxied service → point at chosen backends → update
existing Claude connections (3 to Atlas, 2 to Anchor-MCP) to the new proxied URLs.

**Phase 2 (later, only after Phase 1 is proven out):** a thin custom visibility layer —
not new auth logic, just reading/displaying data mcp-auth-proxy already generates:
- Failed-login/brute-force logging (not native to mcp-auth-proxy)
- Known-connections GUI — simple view of active/recent sessions, since that data already
  lives in mcp-auth-proxy's repository backend but isn't exposed anywhere visible

**Explicitly deferred / not part of this plan:** TOTP (Google Authenticator) for
Anchor/Ledger (parked separately, see "MCP Auth Gateway (2FA)"), brute-force IP
auto-blocking, any custom gateway build, a general any-app TOTP gateway.

**Known limitation:** mcp-auth-proxy has no admin UI to revoke one specific active
session and no built-in audit-log dashboard — this is exactly what Phase 2's
known-connections GUI is meant to add. AuthMCP Gateway (loglux) has this natively but
mcp-auth-proxy remains the choice for Phase 1 simplicity.

See personal Atlas entity "MCP Protect App" for full history/reasoning.

**MCP Protect App — PHASE 1 COMPLETE (July 2 2026).** Both Atlas and Anchor are now
protected by mcp-auth-proxy with GitHub OAuth (`dcazman` only). Confirmed working
end-to-end for both with real MCP client traffic (200/202 responses in proxy logs after
full OAuth handshake).

- **Atlas**: `atlas.thecasmas.com` → `mcp-auth-proxy-atlas` (port 8080) → Atlas backend
  `192.168.50.23:7784`.
- **Anchor**: `mcp-anchor.thecasmas.com` (renamed from `mcp-home.thecasmas.com`, avoids
  clash with anchor3's `anchor.thecasmas.com`) → `mcp-auth-proxy-anchor` (port 8081) →
  Anchor-MCP backend `192.168.50.23:8000` (host network mode, no published port).

Final compose for Anchor:
```yaml
services:
  mcp-auth-proxy-anchor:
    image: ghcr.io/sigbit/mcp-auth-proxy:latest
    container_name: mcp-auth-proxy-anchor
    restart: unless-stopped
    ports: ["8081:80"]
    environment:
      - GITHUB_CLIENT_ID=${ANCHOR_GITHUB_CLIENT_ID}
      - GITHUB_CLIENT_SECRET=${ANCHOR_GITHUB_CLIENT_SECRET}
    command:
      - "--external-url=https://mcp-anchor.thecasmas.com"
      - "--no-auto-tls"
      - "--github-allowed-users=dcazman"
      - "--"
      - "http://192.168.50.23:8000"
```
Separate GitHub OAuth App from Atlas's — Homepage `https://mcp-anchor.thecasmas.com`,
callback `https://mcp-anchor.thecasmas.com/.auth/github/callback`, Device Flow disabled.

**The Anchor debugging saga (postmortem):** took multiple wrong turns before finding the
real cause. In order: (1) `--no-tls` isn't a real flag, correct one is `--no-auto-tls`;
(2) Cloudflare tunnel Service URL needed the host IP, not a Docker container name
(cloudflared isn't on the proxy's Docker network); (3) same DNS issue on the backend side
— proxy needed `192.168.50.23:8000`, not `anchor-mcp:8000`; (4) hostname rename to
`mcp-anchor.thecasmas.com` needed to propagate through the OAuth App callback URL and the
proxy's `--external-url` flag consistently; (5) briefly suspected a Cloudflare Access
Application was double-gating Anchor — turned out that Access app targets
`anchor.thecasmas.com` (the anchor3 UI), unrelated; (6) briefly suspected the WAF Skip
Rate Limit rule's allowlist broke on rename — plausible but never confirmed. **The actual
root cause: the `mcp-auth-proxy-anchor` container simply wasn't running** — got
stopped/lost somewhere during the editing/troubleshooting process. Once restarted, Phase
1 worked immediately with no further changes needed. Lesson: check `docker ps` for the
container's actual running state early, before chasing config-level theories.

**Atlas Public Repo** — concept stage, not built. Idea (Dan, July 1 2026): publish a
sanitized copy of Atlas (stripped of personal tokens/config) as a public GitHub repo with
proper deployment and usage instructions, so it can be self-hosted by others. The private
`/warehouse/atlas` repo stays as-is; this would be a separate public export/fork. See
personal Atlas entity "Atlas Public Repo" for the full write-up.

## Reference

- `/warehouse/atlas/README.md` — operational reference (tools, schema, deploy, auth,
  connecting, project instructions to copy-paste)
- `/warehouse/atlas/.env` — the token (gitignored)
- `git log` in `/warehouse/atlas` — full build history including the detours above

---

# V2 ADDENDUM (2026-07-09)

v2 shipped per the build spec (Atlas work obs 470) and migration safety plan (obs 471). Summary of what changed — full operational detail in README.md V2 section and /warehouse/ATLAS-V2-RUNBOOK.md:

1. Server-side token scoping (caller:secret:scope; work/personal/shared; 403 on out-of-scope) — kills the June 18 cross-section breach class permanently.
2. Third section: `shared` — readable/writable by both work and personal scoped tokens. Intended home for skill files and cross-context material.
3. `update_observation` — in-place edit, observation IDs become permanent addresses for living documents.
4. `protected` flag on observations — protected rows cannot be deleted (only updated); entity deletion refuses while protected children exist. Groom passes physically cannot destroy protected rows.
5. `audit_log` — every tool call recorded (caller, tool, section, allowed). Feeds a possible future read-only /status gauge; the full dashboard idea was cut (Dan, July 9).
6. Migration is automatic, idempotent (user_version), preserves every row ID. Verified 24/24 checks including full row-identity diff against production.
7. Deliberately NOT changed: SQLite stays, full-landscape ingestion stays, no vector/graph layer (spec item 7).

Supersedes the "Atlas Split — Work vs Home" side project (spec item 8) — remove that entity from the work section on first connected session.

## Shared Section Contents (seeded July 9, 2026)

**Standing Rules** entity (all protected):
- obs 479 — Time discipline (get_time at session start + before any scheduling/date math; slack_ts from anchor time tools)
- obs 481 — Credential hygiene (no token/secret values in Atlas, any section; placeholders + pointers to .env / Anchor note 307)
- obs 482 — Groom/distillation pass discipline (PROMOTE / COMPRESS / DELETE per cold entity; recurring via work reminder, re-arm each pass)

**Skill Files** entity (all protected — Atlas is source of truth, G:\My Drive\skills is backup only):
- obs 484 — PCT_STORY_SKILL (consolidated, confirmed Cloud field map: points 10016, sprint 10020 API-settable, epic link 10014)
- obs 485 — PCT_EPIC_SKILL (server-era field IDs flagged; verify on Cloud before first epic, then update in place)
- obs 486 — SONOS_ORG_REFERENCE (June 26, 2026 version)
- obs 487 — GMAIL_INBOX_SKILL (inbox triage protocol; Rovo replaces dead sonos-jira)
- obs 488 — MIRO_MIGRATION_INTEL (stale June 18 base + known-deltas block; refresh after migration week)

Skills evolve via update_observation on these stable IDs — never delete-and-recreate. Groom passes cannot touch protected rows by design.

---

## Time Awareness (deployed 2026-07-10)

Push-based clock — the client model never has to remember to ask what time it is.

- **Footer on every tool response:** every guarded tool appends
  `[server_time: Fri 2026-07-10 09:05 EDT | since your last Atlas call: 10h 18m]`.
  Elapsed time is computed per-token from the audit log, so both work and personal
  Claude get an accurate "how long since I last touched Atlas" on every call —
  including the gap across sleep/overnight, which is the classic stale-clock failure.
- **`get_time` tool:** unguarded (no section), still audited. For turns involving dates,
  scheduling, or elapsed time when no other Atlas call happens that turn.
- Implementation: `timeLine()` / `withFooter()` in `src/tools.js`, `lastCallTime()` in `src/db.js`.
- Rationale: instructions to "check the time" fail in practice (pull-based); the footer is
  push-based and cannot be forgotten. Origin: repeated time errors in work sessions;
  design locked 2026-07-10 (shared entity "Time Awareness + Reminder Wake").

## Groom Worker (deployed 2026-07-10 — mechanical layer)

Nightly offline memory maintenance — the "sleep-time compute" pattern (Letta et al.):
conversation agents react during the day; a background worker consolidates at night.
This keeps full-landscape pulls affordable without a tiered landscape.

- **Scheduler:** in-image (src/server.js). Every 5 min, if past 4am ET and not yet run
  today (`groom_meta.last_groom_date`), spawns `src/groom.js`. Self-healing: missed
  windows run at first check after recovery. No host cron dependency.
- **Mechanical layer (live, zero API cost):**
  - Near-dupe detection per entity (token Jaccard >= 0.85) — report only
  - Dormant entities (60+ days untouched) — report only
  - Stale dismissed reminders (90+ days) — report only
  - Audit log rotation (90 days) — auto-applied (only destructive op)
  - Change detection: entities untouched since last groom are skipped (`groom_meta.last_groomed:<section>`)
  - WAL checkpoint after each run
- **Groom Report:** findings land as observations on a reserved "Groom Report" entity
  per section; previous unprotected report observations are replaced each run. Claude +
  Dan review the report in normal conversation and act via the standard tools
  (PROMOTE / COMPRESS / DELETE taxonomy per Standing Rules obs 482).
- **Protected observations are physically untouchable** by the groom — same guarantee
  as everywhere else.
- **Phase 3 (planned, not built):** judgment layer — Claude API via Message Batches
  (50% off, async) for dedupe confirmation (Haiku) and cross-topic prospecting (Sonnet):
  finding buried important observations and proposing promotion to summaries/shared.
  Requires an Anthropic API key available to the worker. Report-only for first two weeks.
  Est. cost at current data size: under $0.25/night.
- Manual run: `docker exec atlas-v2 node /app/src/groom.js`
