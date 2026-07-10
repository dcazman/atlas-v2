# ATLAS V2 BUILD RUNBOOK — 2026-07-09
# READ THIS FIRST. This file is Atlas-independent. If you are a Claude session
# with no Atlas connection: this file is the source of truth for build state
# and rollback. Update the STATE line after every step.

STATE: COMPLETE 2026-07-09 evening — v2 verified in production. Acceptance test passed from live claude.ai session: work landscape returns on scoped token, personal returns 403. Checklist done: obs 478 updated to final cutover record + protected; obs 470, 471, 426 protected; duplicate obs 476 removed; reminder 5 dismissed; time-discipline rule = PROTECTED obs 479 in shared section (Standing Rules entity); Atlas Split entity removed. REMAINING: Dan pulls B3 backup via FileBrowser; c-v token swaps; home token to personal clients; anchor time tools deploy (below); retire v1 ~July 16.  POST-CLOSE: anchor time tools DEPLOYED (24 tools live); shared section seeded — Standing Rules obs 479/481/482, Skill Files obs 484-488, all protected; groom reminder 7 armed for 2026-07-16; tokens recorded in Anchor note 307 (type pi); Atlas work credential-scrubbed (obs 212/264/8).

## CUTOVER PROCEDURE (Phase 3 — run only on Dan's go)
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

## TOPOLOGY (verified 2026-07-09)
- atlas.thecasmas.com -> cloudflared-home tunnel (remote-managed, do NOT touch)
  -> mcp-auth-proxy-atlas container :8080 (GitHub OAuth, user dcazman)
  -> upstream http://192.168.50.23:7784 = atlas container (v1)
- v1: container "atlas", image dcazman/atlas:latest, port 7784,
  DB /mnt/user/appdata/atlas/atlas.db, code /warehouse/atlas (git, clean, auto-backup nightly)
- v2 (being built): code /warehouse/atlas-v2, container "atlas-v2", image dcazman/atlas:v2,
  port 7790, DB /mnt/user/appdata/atlas-v2/atlas.db
- NOTE: this anchor-mcp container cannot see /mnt/user directly. Use:
  docker exec atlas ...   OR   docker run --rm -v /mnt/user/appdata:/x alpine ...

## BACKUPS (locations filled in as taken)
- B1: /mnt/user/appdata/atlas/atlas-backup-20260709.db  (pending)
- B2: /warehouse/atlas-backups/atlas-backup-20260709.db (pending)
- B3: Dan pulls B2 to his laptop via FileBrowser (:5555)  (pending)

## FULL ROLLBACK — RESTORE V1 FROM ANY STATE (no Atlas needed)
1. docker stop atlas-v2 2>/dev/null (ok if absent)
2. Ensure proxy points at v1:
   docker rm -f mcp-auth-proxy-atlas
   docker run -d --name mcp-auth-proxy-atlas --restart unless-stopped -p 8080:80 \
     -e GITHUB_CLIENT_ID=Ov23li4VZrt0rQ4i9GDI \
     -e GITHUB_CLIENT_SECRET=3becfcf1bcc9a6d969198c4202c76d1041668f12 \
     -e GITHUB_ALLOWED_USERS=dcazman \
     -e EXTERNAL_URL=https://atlas.thecasmas.com \
     ghcr.io/sigbit/mcp-auth-proxy:latest \
     --external-url=https://atlas.thecasmas.com --no-auto-tls -- http://192.168.50.23:7784
3. docker start atlas
4. If DB corrupted: docker stop atlas, then
   docker run --rm -v /mnt/user/appdata/atlas:/x alpine sh -c \
     'cp /x/atlas-backup-20260709.db /x/atlas.db && rm -f /x/atlas.db-wal /x/atlas.db-shm'
   then docker start atlas
5. Verify: wget -qO- http://192.168.50.23:7784/health  -> {"ok":true,...}
6. Old tokens (v1 ATLAS_TOKEN in /warehouse/atlas/.env) remain valid for v1 —
   client configs need NO change if rolling back before token swap.

## 2026-07-10 (later): PHASE 3 KEY WIRED + FULL TEST PASSED
ANTHROPIC_API_KEY added to /warehouse/atlas-v2/.env by Dan (dedicated capped key; value never entered chat).
Container recreated with --env-file /warehouse/atlas-v2/.env (drops the -e ATLAS_TOKEN pattern — future
recreates use --env-file). Test results: key in container (length check only), live Haiku call from inside
container OK (GROOM-KEY-OK, 18in/10out), groom rerun clean with change-detection proven (0 scanned / 85
skipped), footer intact post-recreate, health OK. Groom Report entity live (personal id 101).
TEMPORAL SKILL DECISION: external temporal-awareness skill / passage-of-time-mcp import is DEAD — footer +
Atlas get_time supersede it. Anchor time toolkit (parse_timestamp/add_time/etc.) STAYS for scheduling math.
Standing rule obs 479 left unchanged deliberately — Dan tests footer at work first, single-variable; slim 479
only after a week proves the footer. Phase 3 build (Batches judgment layer) is now unblocked.

## 2026-07-10: TIME FOOTER + GET_TIME + GROOM WORKER (MECHANICAL) DEPLOYED
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

## 2026-07-09: SHARED AUTO-MERGE DEPLOYED
get_landscape now merges shared into any pull (entities + due reminders tagged with origin section;
writes remain explicit). Code: atlas-v2/src/db.js (sectionEntities + merged getLandscape), tools.js
description updated. Image dcazman/atlas:v2 rebuilt, container recreated same config (port 7790,
appdata/atlas-v2). Verified live: personal pull returned 50 personal + 3 shared entities.
NOTE: ATLAS_TOKEN string was echoed into a claude.ai chat during this deploy. Dan reviewed — no rotation
needed: tokens are internal-only (proxy→atlas); external access gated by mcp-auth-proxy OAuth (dcazman only).

## BUILD LOG
- 2026-07-09: runbook created. Nothing else done yet.

## POST-CUTOVER STAGED WORK + FIRST-RECONNECTED-SESSION TODO (added 2026-07-09 evening)
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
