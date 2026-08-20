# Atlas v2 — Operations Runbook

**Read this first, and trust it over memory.** It is deliberately
Atlas-independent: if Atlas itself is down, or you are a Claude session with no
Atlas connection, everything needed to deploy, back up, restore, and diagnose
this service is in this file.

Operations come first, history comes last. When something changes, update the
operational sections *and* append a dated entry to the history log.

---

## Current state (verified 2026-08-17)

| | |
|---|---|
| Public URL | `https://atlas.thecasmas.com` |
| Path | Cloudflare tunnel (`cloudflared-home`, remote-managed — do NOT touch) → `mcp-auth-proxy-atlas` container `:8080` (GitHub OAuth, user `dcazman`) → `http://192.168.50.23:7790` |
| Container | `atlas-v2`, image `dcazman/atlas:v2`, `restart: unless-stopped` |
| Ports | `7790 → 7784` (MCP), `7795 → 7795` (board view, LAN only, no auth) |
| Code | `/warehouse/atlas-v2` (git, tracks `origin/main`) |
| Database | `/mnt/user/appdata/atlas-v2/atlas.db` (bind-mounted to `/app/data`) |
| Config | `/warehouse/atlas-v2/.env` — not in git |
| Backups | `/warehouse/atlas-backups/` (see below) |

**v1 is gone.** The old `atlas` container was retired and no longer exists on
this host, so any procedure that says `docker start atlas` is dead — see
Rollback for what actually works now.

**This anchor-mcp container cannot see `/mnt/user`.** To reach appdata, go
through docker:

```sh
docker exec atlas-v2 ...
docker run --rm -v /mnt/user/appdata/atlas-v2:/x alpine ...
```

`/warehouse` *is* visible from here, which is why backups land there.

---

## Deploying a code change

**The trap (learned 2026-08-13):** `docker-compose.yml` has **no `build:`
section** — the container runs the prebuilt image `dcazman/atlas:v2`. So
`docker compose up -d --build` does nothing for a code change and will silently
serve stale code, with no error to tell you.

Use the script, which does this correctly and verifies afterwards:

```sh
/warehouse/atlas-v2/scripts/deploy.sh
```

Or by hand:

```sh
cd /warehouse/atlas-v2
docker build -t dcazman/atlas:v2 .
docker compose up -d --force-recreate
wget -qO- http://localhost:7790/health          # MCP
wget -qO- http://localhost:7795/ | grep <thing you changed>
```

Always take a backup before deploying — `scripts/deploy.sh` does it for you.

---

## Backups and restore

```sh
/warehouse/atlas-v2/scripts/backup-db.sh
```

Writes a consistent snapshot (`VACUUM INTO`, safe while the server is running)
to `/warehouse/atlas-backups/atlas-YYYYmmdd-HHMMSS.db`, verifies it with
`PRAGMA integrity_check`, and prunes to the newest 14. Point a cron/User Script
at it, or let a deploy trigger it.

**Restore:**

```sh
docker stop atlas-v2
docker run --rm -v /mnt/user/appdata/atlas-v2:/d -v /mnt/user/warehouse/atlas-backups:/b \
  alpine sh -c 'cp /b/<chosen-backup>.db /d/atlas.db && rm -f /d/atlas.db-wal /d/atlas.db-shm'
docker start atlas-v2
wget -qO- http://localhost:7790/health
```

Deleting the `-wal`/`-shm` files matters: leaving a WAL from a different
database behind is how a "restored" database comes back corrupted.

---

## Rollback

There is no second container to fall back to any more, so rollback is two
independent moves — pick the one that matches what broke.

**Bad code, good data** — redeploy the previous image. `scripts/deploy.sh` tags
every build as `dcazman/atlas:v2-<gitsha>` as well as `:v2`, so:

```sh
docker images dcazman/atlas                       # find the previous sha tag
docker tag dcazman/atlas:v2-<previous-sha> dcazman/atlas:v2
cd /warehouse/atlas-v2 && docker compose up -d --force-recreate
```

If no sha tag exists (build predates the script), check out the previous commit
and rebuild: `git checkout <sha> && docker build -t dcazman/atlas:v2 .`

**Bad data** — restore a backup, as above.

**Proxy trouble** — recreate the gateway. The client secret is not in this file
on purpose; read it off the running container
(`docker inspect mcp-auth-proxy-atlas`) or the GitHub OAuth app:

```sh
docker rm -f mcp-auth-proxy-atlas
docker run -d --name mcp-auth-proxy-atlas --restart unless-stopped -p 8080:80 \
  -e GITHUB_CLIENT_ID=Ov23li4VZrt0rQ4i9GDI \
  -e GITHUB_CLIENT_SECRET=<from the running container or the OAuth app> \
  -e GITHUB_ALLOWED_USERS=dcazman \
  -e EXTERNAL_URL=https://atlas.thecasmas.com \
  ghcr.io/sigbit/mcp-auth-proxy:latest \
  --external-url=https://atlas.thecasmas.com --no-auto-tls -- http://192.168.50.23:7790
```

---

## Quick diagnosis

| Symptom | First check |
|---|---|
| Claude can't connect | `wget -qO- http://localhost:7790/health`, then the proxy: `docker logs mcp-auth-proxy-atlas --tail 50` |
| Connected but no data | Token scope — a `work` token gets 403 on `personal`. Check `/warehouse/atlas-v2/.env` |
| Board page blank/stale | `wget -qO- http://localhost:7795/health`; the page auto-refreshes every 30s |
| Deployed but nothing changed | You hit the build trap above. Rebuild the image, don't just recreate |
| Database looks wrong | Stop, restore a backup, start. Never edit `atlas.db` under a running container |

---

## History log

Contemporaneous records, newest first. These are snapshots of what was true on
the day — they are **not** maintained, and anything operational in them is
superseded by the sections above.

### 2026-08-20: core memory tier (v23) deployed
entities.core flag added. get_landscape now returns only core=1 entities + due reminders by
default (view: "core"); all=true still gives the old full-dump behavior (view: "all"). New tools
promote_entity/evict_entity toggle the flag - eviction never deletes, just drops out of the
default view. Nothing auto-promotes, ever (explicit MemGPT-style tier, not MemoryBank-style
decay). groom.js flags core entities stale after 5+ days, report-only. Full design in
design/CORE-MEMORY-DESIGN.md, ship writeup in README.md.
Deploy gotcha hit: docker compose from the anchor-mcp container failed on
`env file /mnt/user/warehouse/atlas-v2/.env not found` (this container only sees /warehouse, see
the /mnt/user note above) - fixed by mirroring .env to that path inside the container. Mirror is
left in place; re-copy it if .env ever changes.

### 2026-08-13: deploy trap found
atlas-v2 docker-compose.yml has NO build section - the container runs the prebuilt image dcazman/atlas:v2.
`docker compose up -d --build` does NOTHING for code changes and will silently serve stale code.
Correct deploy after editing src/:
  cd /warehouse/atlas-v2 && docker build -t dcazman/atlas:v2 . && docker compose up -d --force-recreate
Then verify with: wget -qO- http://localhost:7795/ and grep for the change.

### 2026-07-20: GET_OBSERVATION (OBS-NUMBER ADDRESSING) DEPLOYED
Spec: shared obs 806 (amended by Dan + personal Claude same day; graveyard design is Dan's).
New tool get_observation(section, ids[1..20]) — fetch obs directly by id, the fetch half of
The Board's obs-number addressing (rule 799). Code: db.js getObservationsByIds (scope from the
ROW: obs -> entity -> actual section must be in token's allowed sections; out-of-scope ==
nonexistent, both land in "missing" — no scope probing). tools.js: new guarded tool + ids in
audit summarize + search description now advertises returned obs ids (search already returned
them). Schema verified AUTOINCREMENT — obs ids never recycled (rule 799's "may be recycled"
caveat is wrong, relax it). Deploy: backup /mnt/user/appdata/atlas-v2/atlas-backup-20260720-pre-obsfetch.db
(WAL checkpointed first), image rebuilt, container recreated with --env-file (config verified
identical: unless-stopped, 7790->7784, appdata bind, all env keys present). Tests passed:
(1) personal token ids[806,649,999999] -> both shared found, bogus missing w/ graveyard note;
(2) SECURITY: work token id 541 (personal section) -> plain "missing", shared 806 found;
(3) work token ids[800,805] -> both work obs returned (the exact c-v handoff path).
Docs: ATLAS.md + README.md tool tables updated (also backfilled missing update/protect/
unprotect rows from the 7/10 deploy — doc drift). Graveyard convention (headstones "NNN was
<clause>" in The Ledger obs 802, groom ages them out ~12-18mo) is convention, not code — no
server changes needed for it. Done from personal claude.ai session per Dan's direct go.


### 2026-07-10 (later): PHASE 3 KEY WIRED + FULL TEST PASSED
ANTHROPIC_API_KEY added to /warehouse/atlas-v2/.env by Dan (dedicated capped key; value never entered chat).
Container recreated with --env-file /warehouse/atlas-v2/.env (drops the -e ATLAS_TOKEN pattern — future
recreates use --env-file). Test results: key in container (length check only), live Haiku call from inside
container OK (GROOM-KEY-OK, 18in/10out), groom rerun clean with change-detection proven (0 scanned / 85
skipped), footer intact post-recreate, health OK. Groom Report entity live (personal id 101).
TEMPORAL SKILL DECISION: external temporal-awareness skill / passage-of-time-mcp import is DEAD — footer +
Atlas get_time supersede it. Anchor time toolkit (parse_timestamp/add_time/etc.) STAYS for scheduling math.
Standing rule obs 479 left unchanged deliberately — Dan tests footer at work first, single-variable; slim 479
only after a week proves the footer. Phase 3 build (Batches judgment layer) is now unblocked.

### 2026-07-10: TIME FOOTER + GET_TIME + GROOM WORKER (MECHANICAL) DEPLOYED
Design session with personal Claude (shared entity "Time Awareness + Reminder Wake"). Deployed in one image:
(1) Time footer on every guarded tool response — server_time ET + elapsed since token's last call (audit-log
based, per-token). (2) get_time tool — unguarded, audited, cheap clock+elapsed check. (3) Groom worker
src/groom.js — mechanical layer only: near-dupe (Jaccard .85), dormant 60d, stale dismissed reminders 90d,
audit rotation 90d (only destructive op), change-detection skip via groom_meta, WAL checkpoint. Report-only:
findings -> "Groom Report" entity per section. (4) In-image scheduler in server.js — 4am ET daily, self-healing,
no host cron (run_command lands in anchor-mcp container, not Unraid host — /boot not reachable from there).
First manual groom: work 32 / personal 50 / shared 3 entities scanned, 0 findings, rotation 0 rows.
PHASE 3 PENDING: judgment layer via Message Batches API (Haiku dedupe confirm, Sonnet prospecting) — needs
Anthropic API key decision from Dan. See ATLAS.md "Groom Worker" section.

### 2026-07-09: SHARED AUTO-MERGE DEPLOYED
get_landscape now merges shared into any pull (entities + due reminders tagged with origin section;
writes remain explicit). Code: atlas-v2/src/db.js (sectionEntities + merged getLandscape), tools.js
description updated. Image dcazman/atlas:v2 rebuilt, container recreated same config (port 7790,
appdata/atlas-v2). Verified live: personal pull returned 50 personal + 3 shared entities.
NOTE: ATLAS_TOKEN string was echoed into a claude.ai chat during this deploy. Dan reviewed — no rotation
needed: tokens are internal-only (proxy→atlas); external access gated by mcp-auth-proxy OAuth (dcazman only).


### POST-CLOSE NOTE (2026-07-12): atlas-public local copy deleted
Dan deleted /warehouse/atlas-public locally (archiving the GitHub repo himself) - public atlas
push was one-time only, no ongoing backup needed. RESOLVED: raid-backup job "atlas-public"
(id 19) deleted via the live API (not just the export file), confirmed gone from
GET /api/jobs and jobs-export.json. Logged to Atlas personal obs 541/542.
- 2026-07-09: runbook created. Nothing else done yet.
- 2026-07-12: atlas-public (public-release scrub workspace, was stale at v1) brought up to v2.
  Ported src/{db,tools,server}.js + groom.js from atlas-v2, verified clean of secrets/hostnames.
  New public README.md, LICENSE (MIT), docker-compose.yml added; .env.example rewritten for the
  caller:secret:scope format; package.json -> 2.0.0. Pushed to dcazman/atlas-public (private) as
  6c8b1a6, then d1979ff. IMPORTANT: initial copy reintroduced personal example strings in
  tools.js descriptions (Linkhouse/NJ House Sale/PennyMac/Apple Push Cert - same ones scrubbed
  once already on 2026-07-06 per Atlas obs 431) plus an "atlas-v2" container name in a groom.js
  comment. All fixed in d1979ff. Any future re-sync of atlas-public from atlas-v2 must grep
  tools.js descriptions for personal examples too, not just hostnames/IPs/secrets - source code
  comments/docstrings are a leak vector, not just docs. Logged to Atlas personal obs 539.
- 2026-07-12 (same day, correction): dcazman/atlas-public is a SEPARATE private staging repo on
  Gem - it is NOT the real public-facing repo. The actual public repo is
  github.com/dcazman/Claude-Atlas-MCP, built directly from Dan's laptop on 2026-07-06, no
  working copy previously existed on Gem. Cloned it fresh, applied the same v2 source update,
  and pushed as commit 2fe0f19 (verified local==remote). That repo had extra content
  atlas-public lacked - SECURITY.md and a CodeQL GitHub Actions workflow - both preserved;
  SECURITY.md's two stale claims (section isolation "logical not cryptographic", "no audit log")
  were corrected to match v2's real server-side scope enforcement + full audit_log. Scratch
  clone directory removed after push. Both dcazman/atlas-public (private) and
  dcazman/Claude-Atlas-MCP (public) now independently reflect v2. Logged to Atlas personal
  obs 540.

### POST-CUTOVER STAGED WORK + FIRST-RECONNECTED-SESSION TODO (added 2026-07-09 evening)
1. ANCHOR TIME TOOLS STAGED, NOT DEPLOYED: /warehouse/anchor-mcp/mcp-server.js now contains 6 new tools
   (parse_timestamp, time_difference, time_since, add_time, timestamp_context, format_duration — all outputs
   include slack_ts = epoch seconds for the Slack scheduler). Syntax-checked OK. anchor-mcp is image-built, so
   the RUNNING container is unaffected until: cd /mnt/user/warehouse/anchor-mcp && docker compose build && docker compose up -d
   WARNING: that restart briefly kills anchor-mcp tools for any active Claude session — deploy between sessions.
2. First session with a working Atlas connection must:
   - add_observation to "Atlas" (work): cutover complete, clients reconnected
   - dismiss reminder ID 5 (Atlas v2 build — DONE)
   - update reminder ID 6 status: part 1 (time tools) staged, pending deploy; part 2 = create the PROTECTED
     time-discipline observation (call get_time at session start, again before any scheduling/deadline math,
     never do date arithmetic mentally) — protect it with protect_observation
   - remove_entity "Atlas Split — Work vs Home" (work) — superseded by v2 token scoping (spec item 8)
   - consider protecting: obs 470/471 (spec+safety plan), SHI play sheet URL obs, Proofpoint TRAP doc obs 426
3. Docs updated: /warehouse/atlas-v2/README.md and ATLAS.md both carry V2 sections.
4. Dan still to do: swap client tokens (from /warehouse/atlas-v2/.env), pull B3 backup via FileBrowser :5555.


### 2026-07-09: v2 cutover — build state at close
STATE: COMPLETE 2026-07-09 evening — v2 verified in production. Acceptance test passed from live claude.ai session: work landscape returns on scoped token, personal returns 403. Checklist done: obs 478 updated to final cutover record + protected; obs 470, 471, 426 protected; duplicate obs 476 removed; reminder 5 dismissed; time-discipline rule = PROTECTED obs 479 in shared section (Standing Rules entity); Atlas Split entity removed. REMAINING: Dan pulls B3 backup via FileBrowser; c-v token swaps; home token to personal clients; anchor time tools deploy (below); retire v1 ~July 16.  POST-CLOSE: anchor time tools DEPLOYED (24 tools live); shared section seeded — Standing Rules obs 479/481/482, Skill Files obs 484-488, all protected; groom reminder 7 armed for 2026-07-16; tokens recorded in Anchor note 307 (type pi); Atlas work credential-scrubbed (obs 212/264/8).

The cutover procedure as run (v1 → v2), kept for the record:

    1. FRESH DB: checkpoint v1 WAL (docker exec atlas node -e "...wal_checkpoint(TRUNCATE)"), docker stop atlas-v2,
       copy live /mnt/user/appdata/atlas/atlas.db -> /mnt/user/appdata/atlas-v2/atlas.db (rm staging wal/shm),
       docker start atlas-v2 (migration reruns automatically, idempotent), verify counts vs live.
    2. REPOINT PROXY: docker rm -f mcp-auth-proxy-atlas; recreate identical but upstream http://192.168.50.23:7790
       (full command in rollback section below, swap the port).
    3. docker stop atlas (v1 stays on disk, do NOT remove).
    4. TOKENS: new scoped tokens live in /warehouse/atlas-v2/.env (sonos:...:work, home:...:personal, shared:...:shared).
       Old single secret (...d4bb) may be added as a temporary scoped alias for continuity — see chat decision.
    5. VERIFY: wget http://192.168.50.23:7790/health; live claude.ai session does get_landscape(work).
    ROLLBACK AT ANY POINT: see FULL ROLLBACK section above (repoint proxy to 7784, docker start atlas). Client
    configs need no change on rollback if old secret alias was used.
