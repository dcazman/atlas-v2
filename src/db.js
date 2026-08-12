const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = process.env.ATLAS_DB_PATH || path.join(__dirname, '..', 'data', 'atlas.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');

// ---------------------------------------------------------------------------
// v2 MIGRATION (idempotent, guarded by PRAGMA user_version)
// v1 schema = user_version 0. v2 = user_version 2.
// Changes: section CHECK gains 'shared' (table rebuild, IDs preserved),
// observations gains protected flag (additive ALTER), audit_log table added.
// Runs BEFORE the CREATE IF NOT EXISTS block so old tables get rebuilt.
// ---------------------------------------------------------------------------
const userVersion = db.prepare('PRAGMA user_version').get().user_version;
const hasEntities = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entities'").get();

if (userVersion < 2 && hasEntities) {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN;');

  db.exec(`
    CREATE TABLE entities_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
      name TEXT NOT NULL,
      summary TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(section, name)
    );
    INSERT INTO entities_new (id, section, name, summary, updated_at)
      SELECT id, section, name, summary, updated_at FROM entities;
    DROP TABLE entities;
    ALTER TABLE entities_new RENAME TO entities;

    CREATE TABLE events_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
      entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO events_new (id, section, entity_id, content, created_at)
      SELECT id, section, entity_id, content, created_at FROM events;
    DROP TABLE events;
    ALTER TABLE events_new RENAME TO events;

    CREATE TABLE reminders_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
      entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
      content TEXT NOT NULL,
      trigger_date TEXT NOT NULL,
      dismissed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO reminders_new (id, section, entity_id, content, trigger_date, dismissed_at, created_at)
      SELECT id, section, entity_id, content, trigger_date, dismissed_at, created_at FROM reminders;
    DROP TABLE reminders;
    ALTER TABLE reminders_new RENAME TO reminders;

    ALTER TABLE observations ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;

    PRAGMA user_version = 2;
  `);

  db.exec('COMMIT;');
  db.exec('PRAGMA foreign_keys = ON;');

  const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
  if (fkErrors.length > 0) {
    console.error('FATAL: foreign_key_check failed after migration:', JSON.stringify(fkErrors));
    process.exit(1);
  }
  console.log('atlas v2 migration complete (user_version 2)');
}

// ---------------------------------------------------------------------------
// v4 MIGRATION (PCT-15801, hard-require-ticket). board_rows gains a CHECK that
// `related` is a non-empty JSON array: a board piece must carry >=1 ticket
// number ("on the board => it has a ticket", Dan Jul 27). SQLite cannot
// ALTER-ADD a CHECK, so rebuild the table. Rows are copied as-is (prod
// board_rows is empty; a non-conforming row would fail the copy loudly rather
// than be silently dropped). Triggers/indexes are re-established by the
// CREATE ... IF NOT EXISTS block below. pending_items is additive (created
// below). Runs BEFORE that block so the rebuilt table wins.
// ---------------------------------------------------------------------------
const hasBoardRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='board_rows'").get();
if (userVersion < 4 && hasBoardRows) {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN;');
  db.exec(`
    CREATE TABLE board_rows_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','waiting','blocked','done')),
      related TEXT NOT NULL CHECK (json_valid(related) AND json_array_length(related) >= 1),
      waiting_on TEXT,
      closure_ref INTEGER REFERENCES events(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      status_changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO board_rows_new (id, section, title, status, related, waiting_on, closure_ref, created_at, updated_at, status_changed_at)
      SELECT id, section, title, status, related, waiting_on, closure_ref, created_at, updated_at, status_changed_at FROM board_rows;
    DROP TABLE board_rows;
    ALTER TABLE board_rows_new RENAME TO board_rows;
  `);
  db.exec('COMMIT;');
  db.exec('PRAGMA foreign_keys = ON;');
  const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
  if (fkErrors.length > 0) {
    console.error('FATAL: foreign_key_check failed after v4 migration:', JSON.stringify(fkErrors));
    process.exit(1);
  }
  console.log('atlas v4 migration complete (board_rows require-ticket)');
}

// ---------------------------------------------------------------------------
// v10 MIGRATION (status vocabulary = the real Jira/GSSD states, board-only).
// active/waiting/blocked -> todo/in_progress/on_hold/done. Drops the separate
// `holding` column (On Hold IS the bottom band now, driven by status) and adds a
// CHECK that an On Hold piece MUST carry a waiting_on reason (Dan Jul 29: "on
// hold always has a reason"). Remap: done->done; active->in_progress;
// waiting/blocked WITH a reason->on_hold; waiting/blocked with NO reason->todo
// (a blank "waiting" was really never-looked-at = To Do). Table rebuild (a CHECK
// cannot be ALTERed). Runs before the CREATE block so the rebuilt table wins.
// ---------------------------------------------------------------------------
const hasBoardRowsV10 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='board_rows'").get();
if (userVersion < 10 && hasBoardRowsV10) {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN;');
  db.exec(`
    CREATE TABLE board_rows_v10 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','on_hold','done')),
      related TEXT NOT NULL CHECK (json_valid(related) AND json_array_length(related) >= 1),
      waiting_on TEXT,
      source_date TEXT,
      priority INTEGER,
      in_sprint INTEGER NOT NULL DEFAULT 0,
      closure_ref INTEGER REFERENCES events(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      status_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (status <> 'on_hold' OR (waiting_on IS NOT NULL AND length(trim(waiting_on)) > 0))
    );
    INSERT INTO board_rows_v10 (id, section, title, status, related, waiting_on, source_date, priority, in_sprint, closure_ref, created_at, updated_at, status_changed_at)
      SELECT id, section, title,
        CASE
          WHEN status = 'done' THEN 'done'
          WHEN status = 'active' THEN 'in_progress'
          WHEN status IN ('waiting','blocked') AND waiting_on IS NOT NULL AND length(trim(waiting_on)) > 0 THEN 'on_hold'
          ELSE 'todo'
        END,
        related, waiting_on, source_date, priority, in_sprint, closure_ref, created_at, updated_at, status_changed_at
      FROM board_rows;
    DROP TABLE board_rows;
    ALTER TABLE board_rows_v10 RENAME TO board_rows;
  `);
  db.exec('COMMIT;');
  db.exec('PRAGMA foreign_keys = ON;');
  const fkErrorsV10 = db.prepare('PRAGMA foreign_key_check').all();
  if (fkErrorsV10.length > 0) { console.error('FATAL: foreign_key_check failed after v10 migration:', JSON.stringify(fkErrorsV10)); process.exit(1); }
  db.exec('PRAGMA user_version = 10');
  console.log('atlas v10 migration complete (Jira-state status vocab + on_hold reason fence)');
}

// ---------------------------------------------------------------------------
// v12 MIGRATION: convert the On Hold "reason required" fence into a FLAG. Dan Jul
// 29: Jira is master, the board is a partner/mirror - it must never REFUSE a Jira
// state. Rebuild board_rows WITHOUT the on_hold CHECK. A missing comment on a
// non-todo piece is surfaced as needs_note (computed at read time) for Claude to
// fill or ask Dan - never blocked. All columns/rows preserved (incl v11 sprint).
// ---------------------------------------------------------------------------
const hasBoardRowsV12 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='board_rows'").get();
if (userVersion < 12 && hasBoardRowsV12) {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN;');
  db.exec(`
    CREATE TABLE board_rows_v12 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','on_hold','done')),
      related TEXT NOT NULL CHECK (json_valid(related) AND json_array_length(related) >= 1),
      waiting_on TEXT,
      source_date TEXT,
      priority INTEGER,
      in_sprint INTEGER NOT NULL DEFAULT 0,
      sprint TEXT,
      closure_ref INTEGER REFERENCES events(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      status_changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO board_rows_v12 (id, section, title, status, related, waiting_on, source_date, priority, in_sprint, sprint, closure_ref, created_at, updated_at, status_changed_at)
      SELECT id, section, title, status, related, waiting_on, source_date, priority, in_sprint, sprint, closure_ref, created_at, updated_at, status_changed_at FROM board_rows;
    DROP TABLE board_rows;
    ALTER TABLE board_rows_v12 RENAME TO board_rows;
  `);
  db.exec('COMMIT;');
  db.exec('PRAGMA foreign_keys = ON;');
  const fkErrorsV12 = db.prepare('PRAGMA foreign_key_check').all();
  if (fkErrorsV12.length > 0) { console.error('FATAL: foreign_key_check failed after v12 migration:', JSON.stringify(fkErrorsV12)); process.exit(1); }
  db.exec('PRAGMA user_version = 12');
  console.log('atlas v12 migration complete (on_hold fence -> flag; board mirrors Jira, never refuses)');
}

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
    name TEXT NOT NULL,
    summary TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(section, name)
  );

  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    protected INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
    entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
    entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    trigger_date TEXT NOT NULL,
    trigger_time TEXT,
    dismissed_at TEXT,
    fired_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caller TEXT NOT NULL,
    tool TEXT NOT NULL,
    section TEXT,
    allowed INTEGER NOT NULL DEFAULT 1,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_entities_section ON entities(section);
  CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
  CREATE INDEX IF NOT EXISTS idx_events_section ON events(section);
  CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_id);
  CREATE INDEX IF NOT EXISTS idx_reminders_section ON reminders(section);
  CREATE INDEX IF NOT EXISTS idx_reminders_trigger ON reminders(trigger_date);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

  -- v3: structured board rows (PCT-15801 Phase 2). Typed, rule-enforcing rows
  -- that replace the prose board. Every rule here is a DB fence, not a
  -- convention: CHECK (status / section / related-is-JSON), NOT NULL (title),
  -- FK (closure_ref -> events), and triggers own the timestamps. Schema of
  -- record: Atlas work obs 872. Governing rule: shared obs 873.
  CREATE TABLE IF NOT EXISTS board_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','on_hold','done')),
    related TEXT NOT NULL CHECK (json_valid(related) AND json_array_length(related) >= 1),
    waiting_on TEXT,
    source_date TEXT,
    priority INTEGER,
    in_sprint INTEGER NOT NULL DEFAULT 0,
    sprint TEXT,
    on_board INTEGER NOT NULL DEFAULT 1,
    closure_ref INTEGER REFERENCES events(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    status_changed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_board_rows_section ON board_rows(section);
  CREATE INDEX IF NOT EXISTS idx_board_rows_status  ON board_rows(status);

  -- updated_at bumps on EVERY write (info-freshness clock). recursive_triggers
  -- is OFF (SQLite default), so this trigger's own UPDATE does not re-fire.
  CREATE TRIGGER IF NOT EXISTS board_rows_touch
    AFTER UPDATE ON board_rows FOR EACH ROW
    BEGIN UPDATE board_rows SET updated_at = datetime('now') WHERE id = NEW.id; END;

  -- status_changed_at moves ONLY on a real status transition (stuck-ness clock).
  -- The engine stamps it, not the write path and not the model. Un-forgettable.
  CREATE TRIGGER IF NOT EXISTS board_rows_status_stamp
    AFTER UPDATE OF status ON board_rows FOR EACH ROW
    WHEN OLD.status <> NEW.status
    BEGIN UPDATE board_rows SET status_changed_at = datetime('now') WHERE id = NEW.id; END;

  -- item 3 (lifecycle fences). A piece cannot be marked done without a closure_ref
  -- (a ledger line = events.id): close-without-a-record is refused by the engine.
  CREATE TRIGGER IF NOT EXISTS board_rows_close_needs_ledger
    BEFORE UPDATE OF status ON board_rows FOR EACH ROW
    WHEN NEW.status = 'done' AND NEW.closure_ref IS NULL
    BEGIN SELECT RAISE(ABORT, 'cannot close a board piece without closure_ref (a ledger line)'); END;

  -- Board pieces are NEVER hard-deleted (immutable addresses; closed pieces drop
  -- from view but are retained forever). Retire a piece by closing it, not deleting.
  -- (DROP TABLE in a migration is DDL and does not fire this row trigger.)
  CREATE TRIGGER IF NOT EXISTS board_rows_no_delete
    BEFORE DELETE ON board_rows FOR EACH ROW
    BEGIN SELECT RAISE(ABORT, 'board pieces are not deleted; close them (status=done + closure_ref)'); END;

  -- v4: PENDING TRAY (PCT-15801 Phase 2, item 2). Candidates with no ticket yet.
  -- Own immutable ids (never reused). A pending item's fate is merge / promote /
  -- dismiss - each leaves a trace (nothing silently vanishes). state != 'pending'
  -- means resolved: DISMISSED FROM VIEW but retained in store (VIEW vs STORE,
  -- obs 875). merged_into links to the piece that absorbed it = its provenance.
  CREATE TABLE IF NOT EXISTS pending_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('slack','jira','email','calendar','manual')),
    source_ref TEXT,
    source_date TEXT,
    summary TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','merged','promoted','dismissed')),
    merged_into INTEGER REFERENCES board_rows(id) ON DELETE SET NULL,
    resolution_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_pending_section_state ON pending_items(section, state);

  -- resolved_at is stamped by the engine the moment an item leaves 'pending'.
  CREATE TRIGGER IF NOT EXISTS pending_items_resolve
    AFTER UPDATE OF state ON pending_items FOR EACH ROW
    WHEN OLD.state = 'pending' AND NEW.state <> 'pending'
    BEGIN UPDATE pending_items SET resolved_at = datetime('now') WHERE id = NEW.id; END;

  -- v17: WORKERS (see /worker skill). A structured record for a spawned worker
  -- thread scoped to one board piece, so "what are my workers doing" is a query
  -- instead of unstructured free text. obs_id points at the Atlas observation
  -- the worker itself writes short plain-text progress lines to - this table is
  -- the queryable index, not a replacement for that obs.
  CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL CHECK (section IN ('work','personal','shared')),
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    related TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(related)),
    board_row_id INTEGER REFERENCES board_rows(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_hold','done')),
    obs_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_workers_section ON workers(section);

  -- updated_at bumps on every write, same pattern as board_rows_touch.
  CREATE TRIGGER IF NOT EXISTS workers_touch
    AFTER UPDATE ON workers FOR EACH ROW
    BEGIN UPDATE workers SET updated_at = datetime('now') WHERE id = NEW.id; END;
`);

// schema version marker. board_rows + pending_items are created above via
// CREATE ... IF NOT EXISTS, and the v4 block above rebuilt board_rows to add the
// require-ticket CHECK. This bump records the DB is at v4 for future migrations.
if (db.prepare('PRAGMA user_version').get().user_version < 4) {
  db.exec('PRAGMA user_version = 4');
}

// v5: pending_items.source_date — the origin ticket's real date (e.g. Jira
// created), so age reflects the ticket's TRUE age, not time-in-tray. Additive
// ALTER guarded by user_version so it runs once; try/catch covers the fresh
// install where the CREATE block already added the column.
if (db.prepare('PRAGMA user_version').get().user_version < 5) {
  try { db.exec('ALTER TABLE pending_items ADD COLUMN source_date TEXT'); } catch (e) { /* already present */ }
  db.exec('PRAGMA user_version = 5');
}

// v6: board_rows.source_date — the piece's ticket real date (e.g. Jira created),
// so board age reflects the ticket's TRUE age, not time-on-board. Additive ALTER,
// guarded; try/catch covers fresh installs where CREATE already added it.
if (db.prepare('PRAGMA user_version').get().user_version < 6) {
  try { db.exec('ALTER TABLE board_rows ADD COLUMN source_date TEXT'); } catch (e) { /* already present */ }
  db.exec('PRAGMA user_version = 6');
}

// v7: board_rows.priority — Dan's manual override. Default order is oldest-first;
// a bumped piece (lower priority number) floats to the top; NULL = unbumped.
if (db.prepare('PRAGMA user_version').get().user_version < 7) {
  try { db.exec('ALTER TABLE board_rows ADD COLUMN priority INTEGER'); } catch (e) { /* already present */ }
  db.exec('PRAGMA user_version = 7');
}

// v8: board_rows.in_sprint — 1 if the ticket is in the current active sprint
// (danfeed supplies it). Drives "current sprint first" ordering.
if (db.prepare('PRAGMA user_version').get().user_version < 8) {
  try { db.exec('ALTER TABLE board_rows ADD COLUMN in_sprint INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* already present */ }
  db.exec('PRAGMA user_version = 8');
}

// v9 (holding column) was superseded by v10 below, which drops it: On Hold IS the
// bottom band now, driven by status, not a separate flag. This ensures the schema
// version reaches 10 on FRESH installs (table created new with the current schema,
// where the v10 rebuild block is skipped).
if (db.prepare('PRAGMA user_version').get().user_version < 10) {
  db.exec('PRAGMA user_version = 10');
}

// v11: board_rows.sprint - the sprint number/label for display (e.g. "15"), so the
// board can show a Sprint column next to Status. danfeed populates it from the
// ticket's active Jira sprint; blank when not in a sprint. Ordering still uses
// in_sprint (boolean) - this is display only. Additive ALTER, guarded.
if (db.prepare('PRAGMA user_version').get().user_version < 11) {
  try { db.exec('ALTER TABLE board_rows ADD COLUMN sprint TEXT'); } catch (e) { /* already present */ }
  db.exec('PRAGMA user_version = 11');
}

// ensure fresh installs reach 12 (the v12 rebuild is skipped when the table is
// created new by the CREATE block, which already omits the on_hold CHECK).
if (db.prepare('PRAGMA user_version').get().user_version < 12) {
  db.exec('PRAGMA user_version = 12');
}

// v13: board_rows.on_board - a piece can leave the live board WITHOUT being closed
// (Dan Jul 30: epics/capabilities are documents that make work, not board items;
// a driver ticket leaves once its story exists). on_board=0 hides it from the view
// but keeps it in the store (VIEW vs STORE) and never fakes a Jira-done. Additive.
if (db.prepare('PRAGMA user_version').get().user_version < 13) {
  try { db.exec('ALTER TABLE board_rows ADD COLUMN on_board INTEGER NOT NULL DEFAULT 1'); } catch (e) { /* already present */ }
  db.exec('PRAGMA user_version = 13');
}

// v14: reminders.trigger_time (HH:MM, section tz = America/New_York) + reminders.fired_at.
// A reminder WITH a trigger_time is a TIMED reminder: danfeed's reminder loop fires a
// Slack DM to Dan at/after trigger_date+trigger_time (exactly once), then stamps fired_at
// so it never re-fires. NULL trigger_time = date-only reminder (passive: surfaces as due
// in get_landscape AND list_due_reminders on/after the date and stays due until
// dismissed - fired_at does not apply; no active push). Additive ALTERs, guarded; try/catch
// covers fresh installs where the CREATE block already added the columns.
if (db.prepare('PRAGMA user_version').get().user_version < 14) {
  try { db.exec('ALTER TABLE reminders ADD COLUMN trigger_time TEXT'); } catch (e) { /* already present */ }
  try { db.exec('ALTER TABLE reminders ADD COLUMN fired_at TEXT'); } catch (e) { /* already present */ }
  db.exec('PRAGMA user_version = 14');
}

// v15: sprint_slots - FROZEN PER-SPRINT NUMBERING (Board v-next item 5, Atlas
// work obs 980). A slot number is assigned once per (section, sprint, row) the
// first time that sprint is rendered, oldest-first, and held for the sprint's
// whole life - the view must never recompute 1..N live (that is the drift bug
// this replaces). New tickets appended mid-sprint get the next slot; a ticket
// that leaves the sprint keeps its old slot as a "moved" marker (view-layer)
// while earning a fresh slot in its new sprint. Numbering resets per sprint
// because this table is keyed by sprint, not globally. board_rows itself is
// untouched - this is a pure additive ledger table.
if (db.prepare('PRAGMA user_version').get().user_version < 15) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sprint_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT NOT NULL,
      sprint TEXT NOT NULL,
      row_id INTEGER NOT NULL REFERENCES board_rows(id),
      slot INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(section, sprint, row_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_slots_section_sprint ON sprint_slots(section, sprint);
    CREATE INDEX IF NOT EXISTS idx_sprint_slots_row ON sprint_slots(row_id);
  `);
  db.exec('PRAGMA user_version = 15');
}

// v16: board_rows.last_comment - the actual last Jira comment text, kept
// separate from waiting_on on purpose (Dan Aug 10, after PCT-16053's own
// description carried forward a stale name mix-up with no way to tell it was
// stale). waiting_on is Claude's OWN internal note/context and is never
// assumed to mirror the ticket; last_comment is meant to be the live Jira-
// side truth for comparison. IMPORTANT: atlas-v2 does NOT fetch Jira itself -
// this column is a pure additive ledger field. Populating it is danfeed's
// job (it already polls Jira for board_update the same way it maintains
// status/sprint/in_sprint) via a future board_update {last_comment} call;
// until that lands this column is written by nobody and renders blank. Do
// not add Jira-fetching code to this service - see obs 1086/1087.
if (db.prepare('PRAGMA user_version').get().user_version < 16) {
  try { db.exec('ALTER TABLE board_rows ADD COLUMN last_comment TEXT'); } catch (e) { /* already present */ }
  db.exec('PRAGMA user_version = 16');
}

// v17: workers table (see CREATE block above) - CREATE ... IF NOT EXISTS already
// added it for both fresh and existing installs; this just records the bump.
if (db.prepare('PRAGMA user_version').get().user_version < 17) {
  db.exec('PRAGMA user_version = 17');
}

// v18: board_rows.queue_pos - Dan's declared work order ("order 10, 5, 1").
// Pure intention: Jira never sees it, status never changes, frozen sprint_slots
// numbering untouched. NULL = not in the queue. Written only by setBoardOrder
// (whole-queue replace via the board_order tool); cleared automatically when a
// row is pinned (bump/move), closed, or offboarded. On Hold does NOT clear it -
// Dan may still intend to work a held piece later.
if (db.prepare('PRAGMA user_version').get().user_version < 18) {
  try { db.exec('ALTER TABLE board_rows ADD COLUMN queue_pos INTEGER'); } catch (e) { /* already present */ }
  db.exec('PRAGMA user_version = 18');
}

function findEntity(section, name) {
  return db.prepare('SELECT id, name, summary, updated_at FROM entities WHERE section = ? AND name = ?').get(section, name);
}

function touchEntity(id) {
  db.prepare("UPDATE entities SET updated_at = datetime('now') WHERE id = ?").run(id);
}

function ensureEntity(section, name) {
  let entity = findEntity(section, name);
  if (!entity) {
    db.prepare('INSERT INTO entities (section, name) VALUES (?, ?)').run(section, name);
    entity = findEntity(section, name);
  }
  return entity;
}

function sectionEntities(section) {
  const entities = db.prepare(
    'SELECT id, name, summary, updated_at FROM entities WHERE section = ? ORDER BY updated_at DESC'
  ).all(section);

  for (const e of entities) {
    e.section = section;
    e.observations = db.prepare(
      'SELECT id, content, protected, updated_at FROM observations WHERE entity_id = ? ORDER BY updated_at DESC'
    ).all(e.id);
  }

  return entities;
}

function getLandscape(section) {
  // Own section + shared merged: any landscape pull automatically sees shared.
  // Entities and reminders are tagged with their origin section.
  let entities = sectionEntities(section);
  let reminders = getActiveReminders(section).map((r) => ({ ...r, section }));

  if (section !== 'shared') {
    entities = entities.concat(sectionEntities('shared'));
    reminders = reminders.concat(
      getActiveReminders('shared').map((r) => ({ ...r, section: 'shared' }))
    );
  }

  return { reminders, entities };
}

function getEntity(section, name) {
  const entity = findEntity(section, name);
  if (!entity) return null;

  entity.observations = db.prepare(
    'SELECT id, content, protected, updated_at FROM observations WHERE entity_id = ? ORDER BY updated_at DESC'
  ).all(entity.id);

  entity.recent_events = db.prepare(
    'SELECT id, content, created_at FROM events WHERE entity_id = ? ORDER BY created_at DESC LIMIT 10'
  ).all(entity.id);

  return entity;
}

function upsertEntity(section, name, summary) {
  const existing = findEntity(section, name);
  if (existing) {
    if (summary !== undefined && summary !== null) {
      db.prepare("UPDATE entities SET summary = ?, updated_at = datetime('now') WHERE id = ?").run(summary, existing.id);
    } else {
      touchEntity(existing.id);
    }
  } else {
    db.prepare('INSERT INTO entities (section, name, summary) VALUES (?, ?, ?)').run(section, name, summary ?? null);
  }
  return getEntity(section, name);
}

function removeEntity(section, name) {
  const entity = findEntity(section, name);
  if (!entity) return { ok: false, reason: 'not_found' };
  const prot = db.prepare('SELECT COUNT(*) n FROM observations WHERE entity_id = ? AND protected = 1').get(entity.id);
  if (prot.n > 0) return { ok: false, reason: 'protected', count: prot.n };
  db.prepare('DELETE FROM entities WHERE id = ?').run(entity.id);
  return { ok: true };
}

function addObservation(section, entityName, content) {
  const entity = ensureEntity(section, entityName);
  touchEntity(entity.id);
  const info = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(entity.id, content);
  return { observation_id: info.lastInsertRowid, entity: entityName };
}

function getObservation(section, observationId) {
  return db.prepare(
    `SELECT o.id, o.content, o.protected, o.updated_at, o.entity_id, ent.name AS entity
     FROM observations o JOIN entities ent ON ent.id = o.entity_id
     WHERE o.id = ? AND ent.section = ?`
  ).get(observationId, section);
}

// Fetch one or more observations directly by ID. Scope comes from the ROW,
// not the caller: each obs resolves through its entity to its ACTUAL section,
// which must be in the token's allowed sections. Out-of-scope and nonexistent
// come back identically in "missing", so a token cannot probe whether IDs
// exist outside its scope. (Obs IDs are AUTOINCREMENT - never recycled - so a
// missing id was deleted or never issued; deleted topics may have a headstone
// in The Ledger.)
function getObservationsByIds(allowedSections, ids) {
  const stmt = db.prepare(
    `SELECT o.id, o.content, o.protected, o.updated_at, ent.name AS entity, ent.section AS section
     FROM observations o JOIN entities ent ON ent.id = o.entity_id
     WHERE o.id = ?`
  );
  const observations = [];
  const missing = [];
  for (const id of ids) {
    const row = stmt.get(id);
    if (row && allowedSections.includes(row.section)) observations.push(row);
    else missing.push(id);
  }
  return { observations, missing };
}

function updateObservation(section, observationId, content) {
  const obs = getObservation(section, observationId);
  if (!obs) return { ok: false, reason: 'not_found' };
  db.prepare("UPDATE observations SET content = ?, updated_at = datetime('now') WHERE id = ?").run(content, observationId);
  touchEntity(obs.entity_id);
  return { ok: true, observation_id: observationId, entity: obs.entity, protected: obs.protected };
}

function setObservationProtected(section, observationId, value) {
  const obs = getObservation(section, observationId);
  if (!obs) return { ok: false, reason: 'not_found' };
  db.prepare('UPDATE observations SET protected = ? WHERE id = ?').run(value ? 1 : 0, observationId);
  return { ok: true, observation_id: observationId, entity: obs.entity, protected: value ? 1 : 0 };
}

function removeObservation(section, observationId) {
  const obs = getObservation(section, observationId);
  if (!obs) return { ok: false, reason: 'not_found' };
  if (obs.protected) return { ok: false, reason: 'protected' };
  db.prepare('DELETE FROM observations WHERE id = ?').run(observationId);
  return { ok: true };
}

function logEvent(section, content, entityName) {
  let entityId = null;
  if (entityName) {
    entityId = ensureEntity(section, entityName).id;
  }
  const info = db.prepare('INSERT INTO events (section, entity_id, content) VALUES (?, ?, ?)').run(section, entityId, content);
  return { event_id: info.lastInsertRowid };
}

function createReminder(section, content, triggerDate, entityName, triggerTime) {
  let entityId = null;
  if (entityName) {
    entityId = ensureEntity(section, entityName).id;
  }
  // trigger_time is optional. When present it must be HH:MM (24h), interpreted in the
  // section timezone (America/New_York). It turns a reminder into a TIMED reminder that
  // danfeed actively fires (Slack DM) at/after trigger_date+trigger_time. NULL =
  // date-only reminder (passive: surfaces as due in get_landscape and
  // list_due_reminders on/after the date, stays due until dismissed, no push).
  let time = null;
  if (triggerTime != null && String(triggerTime).trim() !== '') {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(triggerTime).trim());
    if (!m) throw new Error(`trigger_time must be HH:MM (24h); got "${triggerTime}"`);
    time = `${m[1].padStart(2, '0')}:${m[2]}`;
  }
  const info = db.prepare(
    'INSERT INTO reminders (section, entity_id, content, trigger_date, trigger_time) VALUES (?, ?, ?, ?, ?)'
  ).run(section, entityId, content, triggerDate, time);
  return { reminder_id: info.lastInsertRowid, trigger_date: triggerDate, trigger_time: time };
}

// Current wall-clock in America/New_York as a 'YYYY-MM-DDTHH:MM' key, for comparing
// against a reminder's trigger_date+trigger_time (both stored in ET). Lexical string
// compare is valid because every field is zero-padded and ordered most-significant first.
function easternNowKey() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  const hour = p.hour === '24' ? '00' : p.hour; // some engines emit '24' at midnight
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}`;
}

function getActiveReminders(section) {
  return db.prepare(
    `SELECT r.id, r.content, r.trigger_date, r.trigger_time, r.created_at, ent.name AS entity
     FROM reminders r LEFT JOIN entities ent ON ent.id = r.entity_id
     WHERE r.section = ? AND r.dismissed_at IS NULL AND r.trigger_date <= date('now')
     ORDER BY r.trigger_date ASC`
  ).all(section);
}

// Every reminder that is currently due and not dismissed, in two flavors:
//   - date-only (trigger_time NULL): due once trigger_date arrives in ET, and it STAYS
//     due until dismissed (fired_at is ignored - these are passive, never DM-pushed;
//     danfeed skips rows without a trigger_time).
//   - timed: due once its ET date+time arrives and it has NOT yet fired; danfeed DMs
//     these and stamps fired_at so they deliver exactly once.
// danfeed's reminder loop pulls this each tick; chat/sidebar reads it for anything due.
// The date/datetime compares are done in JS against ET (SQLite date/datetime('now') is UTC).
function getDueReminders(section) {
  const rows = db.prepare(
    `SELECT r.id, r.content, r.trigger_date, r.trigger_time, r.created_at, ent.name AS entity
     FROM reminders r LEFT JOIN entities ent ON ent.id = r.entity_id
     WHERE r.section = ? AND r.dismissed_at IS NULL
       AND (r.trigger_time IS NULL OR r.fired_at IS NULL)
     ORDER BY r.trigger_date ASC, r.trigger_time ASC`
  ).all(section);
  const nowKey = easternNowKey();
  const todayEt = nowKey.slice(0, 10);
  return rows.filter((r) => (r.trigger_time == null
    ? r.trigger_date <= todayEt
    : `${r.trigger_date}T${r.trigger_time}` <= nowKey));
}

// Stamp a timed reminder as fired so it never re-fires. The `fired_at IS NULL` guard
// makes concurrent/overlapping poll ticks idempotent (only the first UPDATE wins).
function markReminderFired(section, reminderId) {
  const info = db.prepare(
    "UPDATE reminders SET fired_at = datetime('now') WHERE id = ? AND section = ? AND fired_at IS NULL"
  ).run(reminderId, section);
  return info.changes > 0;
}

function listReminders(section, includeDismissed) {
  if (includeDismissed) {
    return db.prepare(
      `SELECT r.id, r.content, r.trigger_date, r.trigger_time, r.dismissed_at, r.fired_at, r.created_at, ent.name AS entity
       FROM reminders r LEFT JOIN entities ent ON ent.id = r.entity_id
       WHERE r.section = ? ORDER BY r.trigger_date ASC`
    ).all(section);
  }
  return db.prepare(
    `SELECT r.id, r.content, r.trigger_date, r.trigger_time, r.fired_at, r.created_at, ent.name AS entity
     FROM reminders r LEFT JOIN entities ent ON ent.id = r.entity_id
     WHERE r.section = ? AND r.dismissed_at IS NULL ORDER BY r.trigger_date ASC`
  ).all(section);
}

function dismissReminder(section, reminderId) {
  const info = db.prepare(
    "UPDATE reminders SET dismissed_at = datetime('now') WHERE id = ? AND section = ? AND dismissed_at IS NULL"
  ).run(reminderId, section);
  return info.changes > 0;
}

function removeReminder(section, reminderId) {
  const info = db.prepare('DELETE FROM reminders WHERE id = ? AND section = ?').run(reminderId, section);
  return info.changes > 0;
}

function getHistory(section, limit, entityName) {
  const cappedLimit = Math.min(Math.max(limit || 20, 1), 200);

  if (entityName) {
    const entity = findEntity(section, entityName);
    if (!entity) return [];
    return db.prepare(
      'SELECT id, content, created_at FROM events WHERE section = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(section, entity.id, cappedLimit);
  }

  return db.prepare(
    `SELECT e.id, e.content, e.created_at, ent.name AS entity
     FROM events e LEFT JOIN entities ent ON ent.id = e.entity_id
     WHERE e.section = ? ORDER BY e.created_at DESC LIMIT ?`
  ).all(section, cappedLimit);
}

function search(section, query) {
  const like = `%${query}%`;

  const entities = db.prepare(
    'SELECT id, name, summary FROM entities WHERE section = ? AND (name LIKE ? OR summary LIKE ?)'
  ).all(section, like, like);

  const observations = db.prepare(
    `SELECT o.id, o.content, o.protected, o.updated_at, ent.name AS entity
     FROM observations o JOIN entities ent ON ent.id = o.entity_id
     WHERE ent.section = ? AND o.content LIKE ?`
  ).all(section, like);

  const events = db.prepare(
    `SELECT e.id, e.content, e.created_at, ent.name AS entity
     FROM events e LEFT JOIN entities ent ON ent.id = e.entity_id
     WHERE e.section = ? AND e.content LIKE ? ORDER BY e.created_at DESC LIMIT 50`
  ).all(section, like);

  return { entities, observations, events };
}

function audit(caller, tool, section, allowed, detail) {
  try {
    db.prepare('INSERT INTO audit_log (caller, tool, section, allowed, detail) VALUES (?, ?, ?, ?, ?)')
      .run(caller, tool, section ?? null, allowed ? 1 : 0, detail ?? null);
  } catch (e) {
    console.error('audit write failed:', e.message);
  }
}

// Most recent audit timestamp for a caller (UTC 'YYYY-MM-DD HH:MM:SS'), or null.
// Used by the time footer to report elapsed time since the token's last call.
function lastCallTime(caller) {
  const row = db.prepare('SELECT created_at FROM audit_log WHERE caller = ? ORDER BY id DESC LIMIT 1').get(caller);
  return row ? row.created_at : null;
}

// groom_meta: tiny key/value store used by the groom worker and its scheduler.
db.exec(`CREATE TABLE IF NOT EXISTS groom_meta (key TEXT PRIMARY KEY, value TEXT);`);
function getGroomMeta(key) {
  const row = db.prepare('SELECT value FROM groom_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setGroomMeta(key, value) {
  db.prepare('INSERT INTO groom_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ---------------------------------------------------------------------------
// board_rows (v3 structured board, PCT-15801 Phase 2). These helpers NEVER
// write updated_at / status_changed_at - those clocks are owned by the
// triggers above, by design (governing rule, shared obs 873).
// ---------------------------------------------------------------------------
function addBoardRow(section, title, opts = {}) {
  // require-ticket (v4): a board piece must carry >=1 ticket number. The DB
  // CHECK is the real fence; this is the friendly guard with a clear message.
  const arr = Array.isArray(opts.related)
    ? opts.related
    : (typeof opts.related === 'string' ? JSON.parse(opts.related) : []);
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('a board piece requires at least one ticket number in related ("on the board => it has a ticket")');
  }
  const primary = String(arr[0] || '');
  if (!/^PCT-/.test(primary) && !/^GSSD-/.test(primary)) {
    throw new Error('board membership: the primary ticket must be PCT- or GSSD- (Dan is tracked in PCT/GSSD). ' + primary + ' is a driver (INFRA/CHANGE/PIRISK/SECARCH/etc.) and belongs in a needs-a-story state, not a board piece.');
  }
  const info = db.prepare(
    `INSERT INTO board_rows (section, title, status, related, waiting_on, source_date, in_sprint, sprint)
     VALUES (?, ?, COALESCE(?, 'todo'), ?, ?, ?, COALESCE(?, 0), ?)`
  ).run(section, title, opts.status ?? null, JSON.stringify(arr), opts.waiting_on ?? null, opts.source_date ?? null, opts.in_sprint ?? null, opts.sprint ?? null);
  return { row_id: info.lastInsertRowid };
}

function listBoardRows(section, includeDone) {
  // oldest-first, top->down (Dan Jul 27). The order is the query, not memory.
  // bumped pieces (priority set, lowest first) float to the top; the rest are
  // oldest-first by true ticket age (source_date), else created_at.
  const ORDER = "ORDER BY (priority IS NULL), priority ASC, in_sprint DESC, (status = 'on_hold') ASC, COALESCE(source_date, created_at) ASC, id ASC";
  const sql = includeDone
    ? `SELECT * FROM board_rows WHERE section = ? AND on_board = 1 ${ORDER}`
    : `SELECT * FROM board_rows WHERE section = ? AND on_board = 1 AND status != 'done' ${ORDER}`;
  return db.prepare(sql).all(section);
}

function getBoardRow(section, id) {
  return db.prepare('SELECT * FROM board_rows WHERE id = ? AND section = ?').get(id, section);
}

function updateBoardRow(section, id, fields = {}) {
  const row = getBoardRow(section, id);
  if (!row) return { ok: false, reason: 'not_found' };
  const sets = [], vals = [];
  if (fields.title !== undefined)       { sets.push('title = ?');       vals.push(fields.title); }
  if (fields.status !== undefined)      { sets.push('status = ?');      vals.push(fields.status); }
  if (fields.waiting_on !== undefined)  { sets.push('waiting_on = ?');  vals.push(fields.waiting_on); }
  if (fields.related !== undefined)     { sets.push('related = ?');     vals.push(typeof fields.related === 'string' ? fields.related : JSON.stringify(fields.related)); }
  if (fields.closure_ref !== undefined) { sets.push('closure_ref = ?'); vals.push(fields.closure_ref); }
  if (fields.source_date !== undefined) { sets.push('source_date = ?'); vals.push(fields.source_date); }
  if (fields.priority !== undefined) { sets.push('priority = ?'); vals.push(fields.priority); }
  if (fields.in_sprint !== undefined) { sets.push('in_sprint = ?'); vals.push(fields.in_sprint ? 1 : 0); }
  if (fields.sprint !== undefined) { sets.push('sprint = ?'); vals.push(fields.sprint); }
  if (fields.on_board !== undefined) { sets.push('on_board = ?'); vals.push(fields.on_board ? 1 : 0); }
  if (fields.last_comment !== undefined) { sets.push('last_comment = ?'); vals.push(fields.last_comment); }
  if (fields.queue_pos !== undefined) { sets.push('queue_pos = ?'); vals.push(fields.queue_pos); }
  // Order-queue auto-drop (v18): closing or offboarding removes the row from
  // Dan's declared queue; the rest keep their relative order. On Hold keeps it.
  if (fields.queue_pos === undefined && (fields.status === 'done' || (fields.on_board !== undefined && !fields.on_board))) {
    sets.push('queue_pos = NULL');
  }
  if (sets.length === 0) return { ok: true, row_id: id, unchanged: true };
  vals.push(id, section);
  db.prepare(`UPDATE board_rows SET ${sets.join(', ')} WHERE id = ? AND section = ?`).run(...vals);
  return { ok: true, row_id: id };
}

// Bump a piece to the top of the board (Dan's "work on N" override), or clear
// the bump back to default oldest-first. New bumps sit above older bumps.
function bumpBoardRow(section, id, clear = false) {
  const row = getBoardRow(section, id);
  if (!row) return { ok: false, reason: 'not_found' };
  if (clear) return updateBoardRow(section, id, { priority: null });
  const m = db.prepare('SELECT MIN(priority) AS mn FROM board_rows WHERE section = ? AND priority IS NOT NULL').get(section);
  const next = (m && m.mn !== null && m.mn !== undefined) ? m.mn - 1 : 0;
  // Pinning means "working it now" - it graduates out of the intention queue (v18).
  return updateBoardRow(section, id, { priority: next, queue_pos: null });
}

// Move a piece to slot `position` (1-based) within the PINNED band (Dan's "move
// X to Y"). Pinned pieces (priority set, not holding) always sit above the auto
// band; position is clamped to the pinned band length. Renumbers the pinned band
// to clean 1..k so order is explicit. Un-holds the moved piece.
function moveBoardRow(section, id, position) {
  const row = getBoardRow(section, id);
  if (!row) return { ok: false, reason: 'not_found' };
  const pinned = db.prepare(
    "SELECT id FROM board_rows WHERE section = ? AND priority IS NOT NULL AND status NOT IN ('on_hold','done') AND id != ? ORDER BY priority ASC, id ASC"
  ).all(section, id).map((r) => r.id);
  let pos = parseInt(position, 10);
  if (isNaN(pos) || pos < 1) pos = 1;
  const idx = Math.min(pos - 1, pinned.length);
  pinned.splice(idx, 0, id);
  // Pin/reorder is visual attention ordering ONLY (Board v-next item 3, Atlas
  // work obs 979/984) - it must NEVER auto-transition status. This used to
  // un-hold a held piece to To Do just because it got moved, which is exactly
  // the ghost-ticket trap Dan flagged (Jira says "working it" when he only
  // reordered). Status is untouched here; a held piece can be pinned/reordered
  // and will render on-hold (greyed) in its new slot, same as before the move.
  const stmt = db.prepare('UPDATE board_rows SET priority = ? WHERE id = ? AND section = ?');
  pinned.forEach((rid, i) => stmt.run(i + 1, rid, section));
  // Pinning means "working it now" - the moved row graduates out of the
  // intention queue (v18); the other pinned rows only got renumbered, not pinned.
  db.prepare('UPDATE board_rows SET queue_pos = NULL WHERE id = ? AND section = ?').run(id, section);
  return { ok: true, row_id: id, position: idx + 1, pinned_order: pinned };
}

// Drop/hold a piece into the bottom holding band (Dan's "drop X" / "hold X").
// holding=1 sinks it below all non-held pieces; priority cleared so it is no
// longer pinned. The paired Jira -> On Hold is done by the caller/skill.
function holdBoardRow(section, id, reason) {
  const row = getBoardRow(section, id);
  if (!row) return { ok: false, reason: 'not_found' };
  // reason OPTIONAL (board mirrors Jira, never refuses). A missing note is surfaced
  // as needs_note for Claude to fill or ask Dan - not blocked.
  const fields = { status: 'on_hold', priority: null };
  if (reason !== undefined && reason !== null) fields.waiting_on = reason;
  return updateBoardRow(section, id, fields);
}

// ---------------------------------------------------------------------------
// Order queue (v18) - Dan's declared work order, "order 10, 5, 1". Pure
// intention: no Jira, no status writes, no slot renumbering. Whole-queue
// replace: rows not in the list drop out; an empty list clears the queue.
// ---------------------------------------------------------------------------
function setBoardOrder(section, rowIds) {
  const applied = [], skipped = [];
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE board_rows SET queue_pos = NULL WHERE section = ? AND queue_pos IS NOT NULL').run(section);
    const stmt = db.prepare("UPDATE board_rows SET queue_pos = ? WHERE id = ? AND section = ? AND on_board = 1 AND status != 'done'");
    let pos = 0;
    for (const id of (rowIds || [])) {
      const r = stmt.run(pos + 1, id, section);
      if (r.changes === 1) { pos++; applied.push(id); } else { skipped.push(id); }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true, order: applied, skipped };
}

// Queue row ids in declared sequence (live, on-board rows only).
function listOrderQueue(section) {
  return db.prepare(
    "SELECT id FROM board_rows WHERE section = ? AND queue_pos IS NOT NULL AND on_board = 1 AND status != 'done' ORDER BY queue_pos ASC, id ASC"
  ).all(section).map((r) => r.id);
}

// Release a piece from the holding band back to the normal (auto) order.
function releaseBoardRow(section, id) {
  const row = getBoardRow(section, id);
  if (!row) return { ok: false, reason: 'not_found' };
  return updateBoardRow(section, id, { status: 'todo', waiting_on: null });
}

// ---------------------------------------------------------------------------
// pending_items (v4 tray). Primitives only; the merge/promote/dismiss flows are
// composed in tools.js so each leaves an events trace. resolved_at is owned by
// the pending_items_resolve trigger, never written here.
// ---------------------------------------------------------------------------
function addPendingItem(section, summary, opts = {}) {
  const info = db.prepare(
    `INSERT INTO pending_items (section, summary, source, source_ref, source_date)
     VALUES (?, ?, COALESCE(?, 'manual'), ?, ?)`
  ).run(section, summary, opts.source ?? null, opts.source_ref ?? null, opts.source_date ?? null);
  return { pending_id: info.lastInsertRowid };
}

function listPending(section) {
  // untriaged only, oldest-first (VIEW vs STORE obs 875: resolved items are hidden).
  return db.prepare(
    "SELECT * FROM pending_items WHERE section = ? AND state = 'pending' ORDER BY created_at ASC, id ASC"
  ).all(section);
}

function getPending(section, id) {
  return db.prepare('SELECT * FROM pending_items WHERE id = ? AND section = ?').get(id, section);
}

function resolvePending(section, id, newState, opts = {}) {
  const p = getPending(section, id);
  if (!p) return { ok: false, reason: 'not_found' };
  if (p.state !== 'pending') return { ok: false, reason: 'already_resolved', state: p.state };
  db.prepare('UPDATE pending_items SET state = ?, merged_into = ?, resolution_note = ? WHERE id = ?')
    .run(newState, opts.merged_into ?? null, opts.resolution_note ?? null, id);
  return { ok: true, pending_id: id, state: newState };
}

// Recover a resolved (merged/promoted/dismissed) tray item back to pending.
function reopenPending(section, id) {
  const p = getPending(section, id);
  if (!p) return { ok: false, reason: 'not_found' };
  db.prepare("UPDATE pending_items SET state = 'pending', resolution_note = NULL, resolved_at = NULL, merged_into = NULL WHERE id = ?").run(id);
  return { ok: true, pending_id: id, state: 'pending' };
}

// ---------------------------------------------------------------------------
// sprint_slots helpers (Board v-next item 5, obs 980). View-layer only - these
// never touch board_rows.status, so they cannot violate item 3's decoupling.
// ---------------------------------------------------------------------------

// Assign slots for any row in `orderedRowIds` that does not already have one
// in this (section, sprint). Existing slots are never reassigned or reordered
// - this is the "snapshot at sprint start + append-only" persistence obs 980
// requires. Pass candidates already sorted oldest-first on first call for a
// sprint so the initial snapshot lands in the right order.
function ensureSprintSlots(section, sprint, orderedRowIds) {
  const existing = db.prepare(
    'SELECT row_id, slot FROM sprint_slots WHERE section = ? AND sprint = ?'
  ).all(section, sprint);
  const known = new Set(existing.map((r) => r.row_id));
  let maxSlot = existing.reduce((m, r) => Math.max(m, r.slot), 0);
  const insert = db.prepare('INSERT INTO sprint_slots (section, sprint, row_id, slot) VALUES (?, ?, ?, ?)');
  for (const rowId of orderedRowIds) {
    if (known.has(rowId)) continue;
    maxSlot += 1;
    insert.run(section, sprint, rowId, maxSlot);
    known.add(rowId);
  }
}

function getSprintSlots(section, sprint) {
  return db.prepare(
    'SELECT row_id, slot, created_at FROM sprint_slots WHERE section = ? AND sprint = ? ORDER BY slot ASC'
  ).all(section, sprint);
}

// Every sprint a row has ever held a slot in (oldest first) - lets the view
// tell "brand new ticket" (one sprint, ever) from "moved sprints" (more than
// one), for the -> S17 ghost marker and the activity strip.
function getSlotHistoryForRow(section, rowId) {
  return db.prepare(
    'SELECT sprint, slot, created_at FROM sprint_slots WHERE section = ? AND row_id = ? ORDER BY created_at ASC'
  ).all(section, rowId);
}

function listSlottedSprints(section) {
  return db.prepare('SELECT DISTINCT sprint FROM sprint_slots WHERE section = ?').all(section).map((r) => r.sprint);
}

// Activity strip feed (Board v-next item 4): what moved or closed in the last
// `days` days - status changes plus cross-sprint moves. Read-only, view-layer
// only; changes nothing.
function recentActivity(section, days) {
  const cutoff = `-${Math.max(1, days || 7)} days`;
  const statusChanges = db.prepare(
    `SELECT id AS row_id, title, related, status, sprint, status_changed_at AS at
     FROM board_rows WHERE section = ? AND on_board = 1 AND status_changed_at >= datetime('now', ?)
     ORDER BY status_changed_at DESC LIMIT 30`
  ).all(section, cutoff).map((r) => ({
    ...r,
    kind: r.status === 'done' ? 'closed' : r.status === 'in_progress' ? 'started' : r.status === 'on_hold' ? 'held' : 'reopened',
  }));

  const slotMoves = db.prepare(
    `SELECT ss.row_id, ss.sprint, ss.created_at AS at, b.title, b.related
     FROM sprint_slots ss JOIN board_rows b ON b.id = ss.row_id
     WHERE ss.section = ? AND ss.created_at >= datetime('now', ?)
       AND (SELECT COUNT(*) FROM sprint_slots ss2 WHERE ss2.section = ss.section AND ss2.row_id = ss.row_id) > 1
     ORDER BY ss.created_at DESC LIMIT 30`
  ).all(section, cutoff).map((r) => ({ ...r, kind: 'moved' }));

  return [...statusChanges, ...slotMoves]
    .sort((a, b) => (a.at < b.at ? 1 : (a.at > b.at ? -1 : 0)))
    .slice(0, 15);
}

// ---------------------------------------------------------------------------
// workers (v17, see /worker skill). Primitives only, matching the board_rows/
// pending_items shape: section-scoped, related stored as a JSON string, obs_id
// is a plain nullable pointer (no FK - it lives in Atlas, a separate service).
// updated_at is owned by the workers_touch trigger, never written here.
// ---------------------------------------------------------------------------
function createWorker(section, name, title, opts = {}) {
  const arr = Array.isArray(opts.related)
    ? opts.related
    : (typeof opts.related === 'string' ? JSON.parse(opts.related) : []);
  const info = db.prepare(
    `INSERT INTO workers (section, name, title, related, board_row_id, status, obs_id)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, 'active'), ?)`
  ).run(section, name, title, JSON.stringify(arr), opts.board_row_id ?? null, opts.status ?? null, opts.obs_id ?? null);
  return { worker_id: info.lastInsertRowid };
}

function listWorkers(section, includeDone) {
  const sql = includeDone
    ? 'SELECT * FROM workers WHERE section = ? ORDER BY created_at ASC, id ASC'
    : "SELECT * FROM workers WHERE section = ? AND status != 'done' ORDER BY created_at ASC, id ASC";
  return db.prepare(sql).all(section);
}

function getWorker(section, id) {
  return db.prepare('SELECT * FROM workers WHERE id = ? AND section = ?').get(id, section);
}

function updateWorker(section, id, fields = {}) {
  const row = getWorker(section, id);
  if (!row) return { ok: false, reason: 'not_found' };
  const sets = [], vals = [];
  if (fields.name !== undefined)        { sets.push('name = ?');         vals.push(fields.name); }
  if (fields.title !== undefined)       { sets.push('title = ?');        vals.push(fields.title); }
  if (fields.related !== undefined)     { sets.push('related = ?');      vals.push(typeof fields.related === 'string' ? fields.related : JSON.stringify(fields.related)); }
  if (fields.board_row_id !== undefined) { sets.push('board_row_id = ?'); vals.push(fields.board_row_id); }
  if (fields.status !== undefined)      { sets.push('status = ?');       vals.push(fields.status); }
  if (fields.obs_id !== undefined)      { sets.push('obs_id = ?');       vals.push(fields.obs_id); }
  if (sets.length === 0) return { ok: true, worker_id: id, unchanged: true };
  vals.push(id, section);
  db.prepare(`UPDATE workers SET ${sets.join(', ')} WHERE id = ? AND section = ?`).run(...vals);
  return { ok: true, worker_id: id };
}

// Retire a worker the sanctioned way - status=done (kept forever, same
// VIEW-vs-STORE spirit as the rest of this file; no delete tool for workers).
function closeWorker(section, id) {
  const row = getWorker(section, id);
  if (!row) return { ok: false, reason: 'not_found' };
  return updateWorker(section, id, { status: 'done' });
}

module.exports = {
  getLandscape,
  getEntity,
  upsertEntity,
  removeEntity,
  addObservation,
  getObservation,
  getObservationsByIds,
  updateObservation,
  setObservationProtected,
  removeObservation,
  logEvent,
  getHistory,
  search,
  createReminder,
  getActiveReminders,
  getDueReminders,
  markReminderFired,
  listReminders,
  dismissReminder,
  removeReminder,
  audit,
  lastCallTime,
  getGroomMeta,
  setGroomMeta,
  addBoardRow,
  listBoardRows,
  getBoardRow,
  updateBoardRow,
  bumpBoardRow,
  moveBoardRow,
  holdBoardRow,
  releaseBoardRow,
  setBoardOrder,
  listOrderQueue,
  addPendingItem,
  listPending,
  getPending,
  resolvePending,
  reopenPending,
  ensureSprintSlots,
  getSprintSlots,
  getSlotHistoryForRow,
  listSlottedSprints,
  recentActivity,
  createWorker,
  listWorkers,
  getWorker,
  updateWorker,
  closeWorker,
};
