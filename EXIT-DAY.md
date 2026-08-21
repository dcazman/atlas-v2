# Atlas — Exit Day: burn work, decide shared, work is reborn

The steady-state shape this file assumes: Atlas runs two sections that matter going
forward, **personal** (permanent, never touched by this procedure) and **work**
(the one this procedure tears down and rebirths, board included). `shared` still
exists in the schema and isn't going away structurally, but it's not a third
permanent pillar — see "Shared" below, it's a one-time triage on exit day, not an
ongoing thing.

This is the Atlas-specific, executable companion to the broader plan. The
overall exit inventory (KB, danfeed, anchor, backups, Claude memory dir) lives in
the KB at `personal/research/exit-scrub.md`; the "idea survives, data dies"
policy itself is recorded in Atlas shared, entity "Sonos Exit - Data Retention
Plan" (obs 1295/1296/1297/1550/1551). Both of those stay the plan of record —
this file is just the part that's actually runnable against this database,
written and verified against the live schema on 2026-08-21.

**Why this is safe to leave written down, unexecuted, for weeks or months:** it's
all read from the current schema and re-verified at run time (row counts,
trigger names) rather than hardcoded once and trusted forever. Anyone running
this later should re-run the "current state" query first and compare against
what's below — if the shape of the data has changed, adjust before running the
deletes.

## Current state (verified 2026-08-21)

Row counts by section, across every table that carries Sonos-derived content:

| table | work | personal | shared |
|---|---|---|---|
| entities | 83 | 89 | 21 |
| observations (via entity join — no own `section` column) | 389 | 313 | 91 |
| events | 621 | 61 | 5 |
| reminders | 52 | 5 | 0 |
| board_rows | 107 | 0 | 0 |
| pending_items | 512 | 0 | 0 |
| research_items | 5 | 0 | 0 |
| workers | 36 | 0 | 0 |
| sprint_slots | 68 | 0 | 0 |
| sprint_meta | 4 | 0 | 0 |
| plan_entries | 7 | 0 | 0 |
| plan_notes | 1 | 0 | 0 |
| entity_aliases | 0 | 0 | 0 |
| audit_log | (has a `section` column too — not counted above, see note below) | | |

The board/pending/research/worker/sprint/plan tables are **100% work today** —
nothing personal or shared has ever touched them. That matters for the purge
mechanism below: several of these can be safely handled as "empty the whole
table" rather than a scoped delete, but re-check this is still true before
running it (if a "personal" board experiment ever happens between now and exit
day, this stops being safe and those tables need the scoped-delete treatment
instead, same as `entities`/`events`/`reminders`).

## The one real hazard: `board_rows` can't be `DELETE`d normally

`board_rows` has a `BEFORE DELETE` trigger (`board_rows_no_delete`) that aborts
any row delete — by design, board pieces are meant to be closed, never deleted,
in normal operation. A plain `DELETE FROM board_rows WHERE section='work'` will
fail with `RAISE(ABORT, ...)`. The schema's own comment already names the
escape hatch: `DROP TABLE` is DDL and does not fire row triggers. Since
`board_rows` is 100% work today, dropping and recreating it loses nothing —
just confirm that's still true first (see current-state query above).

No other table in this list has a delete-blocking trigger. `entities` cascades
to `observations` automatically (`ON DELETE CASCADE`), so deleting work-section
entities takes their observations with them — no separate observations delete
needed. `pending_items.merged_into` and `workers.board_row_id` both point at
`board_rows(id) ON DELETE SET NULL`, which is moot once `board_rows` itself is
being dropped, not row-deleted, in the same pass.

## Step 1 — burn `work`

Run from a session whose Atlas token actually reaches `section=work` (a
personal-scoped token gets a structural 403 on `work` — this is the answer to
exit-scrub.md's open question about who holds the key: either a work-scoped
Atlas session doing its own pass, exactly like this one, or direct DB access
via `anchor-mcp`'s `run_command`, which goes straight to the SQLite file on the
host and bypasses Atlas's own token scoping entirely).

Stop the container first so nothing writes mid-purge:

```sh
cd /warehouse/atlas-v2 && docker compose stop
```

Then, against the DB file directly (adjust the exec target if the container
naming has changed by the time this runs):

```sh
docker run --rm -v /mnt/user/appdata/atlas-v2:/data node:22 node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/atlas.db');
db.exec('BEGIN');
// tables mixed with personal/shared - scoped delete only
for (const t of ['entities','events','reminders','entity_aliases']) {
  const r = db.prepare('DELETE FROM ' + t + \" WHERE section='work'\").run();
  console.log(t, 'deleted', r.changes);
}
// audit_log: purge work-section call history too - it can carry entity
// names / query text in its detail column, which is exactly the kind of
// leftover Sonos content the exit plan exists to catch.
console.log('audit_log', 'deleted', db.prepare(\"DELETE FROM audit_log WHERE section='work'\").run().changes);
// tables that are 100% work today - empty via DROP, not DELETE, because
// board_rows' no-delete trigger would abort a scoped DELETE on it anyway.
// Re-confirm the current-state table above still holds before running this -
// if any of these ever picks up a personal/shared row, switch it to a scoped
// DELETE like the block above instead.
for (const t of ['board_rows','pending_items','research_items','workers','sprint_slots','sprint_meta','plan_entries','plan_notes']) {
  db.exec('DROP TABLE IF EXISTS ' + t);
  console.log(t, 'dropped');
}
db.exec('COMMIT');
"
```

Then bring the app back up — its own migration path (`CREATE TABLE IF NOT
EXISTS ...`, guarded by `PRAGMA user_version`) recreates every dropped table
empty on next boot:

```sh
docker compose up -d
```

Verify: re-run the current-state query from above. Every work row in every
table should now read 0, personal/shared rows in `entities`/`events`/
`reminders` should be unchanged, and `board_rows` etc. should exist (freshly
created, empty) rather than missing.

## Step 2 — decide `shared`

Not automatic — this is Dan's call, not a default in this file. The current 21
shared entities split cleanly:

**Sonos-derived, candidates to burn:** PP: Allowed-Google / Sonos_Allow_Google,
PP: BATV bounce rule, PP: DMARC policy, PP: exestrip, PP: extension_delete, PP:
spam policy assignment — six Proofpoint design facts, all Sonos-specific.

**Not Sonos-derived, no reason to touch:** Anchor→Obsidian Migration, Atlas,
Atlas Core Memory Tier (Design), Atlas Duplicate Prevention & Cleanup Plan
(Design), Atlas RAG / Semantic Search (Design), Claude Operating Rules, Groom
Report, Groom Review & Level System (Design), Knowledge Base / KnowledgeHound
(idea), Known Traps, Skill Files, Sonos Exit - Data Retention Plan (this plan
itself — keep it as the record of what happened), Standing Rules, Time
Awareness + Reminder Wake (for Work Claude), Work/Personal Claude Separation —
all of these are about Atlas/Claude's own operation, not Sonos content.

If the six PP: entities are confirmed for burn, same mechanism as above (their
observations cascade automatically):

```sh
# inside the same node -e block, before COMMIT, or as its own pass later:
for (const name of ['PP: Allowed-Google / Sonos_Allow_Google','PP: BATV bounce rule','PP: DMARC policy','PP: exestrip','PP: extension_delete','PP: spam policy assignment']) {
  db.prepare("DELETE FROM entities WHERE section='shared' AND name=?").run(name);
}
```

## Step 3 — work is reborn

There's no redeploy, no new container, no code change here — that's the
point of keeping the idea (the app, the schema, the board mechanism) separate
from the data. The same running `atlas-v2` instance, same schema, same board
code, is immediately usable for a new job's `work` section the moment Step 1
finishes — `board_add {section:'work', ...}` on a freshly-emptied `board_rows`
table just works, because the board has never been section-specific at the
schema level; it only happened to hold exclusively Sonos content because
that's the only work Dan's had since it shipped.

Optional, recommended: rotate the work-scoped token so nothing Sonos-era
still authenticates. Edit `ATLAS_TOKEN` in `/warehouse/atlas-v2/.env` (format:
comma-separated `caller:secret:scope` triples — replace the work caller's
secret, keep personal's and shared's as-is), then:

```sh
cd /warehouse/atlas-v2 && docker compose up -d --force-recreate
```

Point whatever new-job Claude client at the new work token; the old one stops
working the moment the container restarts with the new `.env`.

## Open items carried from the KB plan

- The shared-entity burn list above should get a final look from Dan before
  Step 2 actually runs — it's a recommendation from what's in shared today,
  not a standing decision.
- This file doesn't cover danfeed, the KB itself, anchor, backups, or the
  Claude memory dir on the PC — those are inventoried in
  `personal/research/exit-scrub.md` and are out of scope here on purpose.
