const { z } = require('zod');
const db = require('./db');

const SECTION = z.enum(['work', 'personal', 'shared']).describe(
  'Which section of Atlas to operate on. Your token reaches its own section plus "shared"; anything else is refused server-side (403).'
);

function json(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function text(str) {
  return { content: [{ type: 'text', text: str }] };
}

// board_rows helpers (v3). age is a RENDER rule, never a stored column: it is
// computed here from the trigger-owned timestamps. related is stored as a JSON
// string; hand callers the parsed array.
function ageDays(ts) {
  if (!ts) return null;
  // SQLite datetimes are "YYYY-MM-DD HH:MM:SS" (UTC, needs T+Z); Jira/email dates
  // are already ISO/RFC and parse directly. Return null (not NaN) if unparseable.
  const iso = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(ts) ? ts.replace(' ', 'T') + 'Z' : ts;
  const t = new Date(iso);
  return isNaN(t.getTime()) ? null : Math.floor((Date.now() - t.getTime()) / 86400000);
}
function safeParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

function denied(auth, section) {
  return {
    isError: true,
    content: [{ type: 'text', text: `403: token "${auth.caller}" (scope: ${auth.scope}) cannot access section "${section}". Allowed sections: ${auth.sections.join(', ')}.` }],
  };
}

// ---------------------------------------------------------------------------
// Time footer: every tool response carries fresh server time + elapsed time
// since the token's last call. Push-based clock — the client model never has
// to remember to ask what time it is.
// ---------------------------------------------------------------------------
function fmtEastern(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
  }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  const days = Math.floor(h / 24);
  return `${days}d ${h % 24}h`;
}

function timeLine(caller, prevTs) {
  const now = new Date();
  let line = `server_time: ${fmtEastern(now)}`;
  if (prevTs) {
    const prev = new Date(prevTs.replace(' ', 'T') + 'Z');
    line += ` | since your last Atlas call: ${fmtElapsed(now - prev)}`;
  } else {
    line += ` | first Atlas call from this token`;
  }
  return line;
}

function withFooter(result, caller, prevTs) {
  try {
    if (result && Array.isArray(result.content)) {
      result.content.push({ type: 'text', text: `[${timeLine(caller, prevTs)}]` });
    }
  } catch (e) { /* footer must never break a response */ }
  return result;
}

// registerTools is called per-request with the authenticated token's identity.
// Every tool that takes a section is scope-checked here, server-side, and the
// call (allowed or denied) is written to audit_log.
function registerTools(server, auth) {
  function guarded(name, config, handler) {
    server.registerTool(name, config, async (args) => {
      const section = args.section;
      const allowed = auth.sections.includes(section);
      const prev = db.lastCallTime(auth.caller);
      db.audit(auth.caller, name, section, allowed, allowed ? summarize(args) : 'DENIED out-of-scope');
      if (!allowed) return denied(auth, section);
      const result = await handler(args);
      return withFooter(result, auth.caller, prev);
    });
  }

  function summarize(args) {
    const parts = [];
    if (args.entity) parts.push(`entity=${args.entity}`);
    if (args.name) parts.push(`name=${args.name}`);
    if (args.observation_id !== undefined) parts.push(`obs=${args.observation_id}`);
    if (Array.isArray(args.ids)) parts.push(`ids=${args.ids.join(',')}`);
    if (args.reminder_id !== undefined) parts.push(`rem=${args.reminder_id}`);
    if (args.query) parts.push(`q=${args.query}`);
    return parts.join(' ') || null;
  }

  // get_time: unguarded (no section), still audited. Cheap clock check for
  // turns that involve dates/elapsed time without another Atlas touch.
  server.registerTool('get_time', {
    title: 'Get time',
    description:
      'Get the current date and time (America/New_York) plus elapsed time since your last Atlas call. ' +
      'Very cheap. Call this on any turn involving dates, scheduling, or elapsed time when you have not ' +
      'already touched Atlas this turn — never do date math from memory.',
    inputSchema: {},
  }, async () => {
    const prev = db.lastCallTime(auth.caller);
    db.audit(auth.caller, 'get_time', null, true, null);
    return text(timeLine(auth.caller, prev));
  });

  guarded('get_landscape', {
    title: 'Get landscape',
    description:
      'Get the current state of a section: every known entity (topic/project) and its observations (facts), ' +
      'plus any due reminders (trigger_date today or earlier, not yet dismissed). ' +
      'The "shared" section is automatically merged in - entities and reminders are tagged with their origin section. ' +
      'Call this at the start of a conversation to get oriented on what is going on. ' +
      'If reminders come back non-empty, surface them to the user near the top of your reply - ' +
      'that is the whole point of a reminder. Dismiss one with dismiss_reminder once handled or acknowledged.',
    inputSchema: { section: SECTION },
  }, async ({ section }) => {
    return json(db.getLandscape(section));
  });

  guarded('get_entity', {
    title: 'Get entity',
    description:
      'Get full detail on one topic/project: its summary, all observations, and recent events. ' +
      'Use this when asked to "look at X".',
    inputSchema: {
      section: SECTION,
      name: z.string().describe('Entity name, e.g. "Linkhouse" or "NJ House Sale".'),
    },
  }, async ({ section, name }) => {
    const entity = db.getEntity(section, name);
    if (!entity) return text(`No entity named "${name}" in ${section}.`);
    return json(entity);
  });

  guarded('get_observation', {
    title: 'Get observation(s) by id',
    description:
      'Fetch one or more observations directly by id - the fetch half of obs-number addressing ' +
      '(handoffs like "Section work, obs 800"). Returns content, entity, section, protected flag, ' +
      'and updated_at for each id. Scope is resolved from each observation\'s ACTUAL section ' +
      '(your own section + shared), not from the section argument. Ids that do not resolve come ' +
      'back in "missing": deleted, never issued, or outside your scope - ids are never recycled, ' +
      'so a deleted topic may have a headstone in The Ledger (graveyard).',
    inputSchema: {
      section: SECTION,
      ids: z.array(z.number().int()).min(1).max(20).describe('One or more observation ids to fetch (max 20 - this is not a landscape substitute).'),
    },
  }, async ({ ids }) => {
    const { observations, missing } = db.getObservationsByIds(auth.sections, ids);
    const out = { observations, missing };
    if (missing.length > 0) {
      out.note = 'Missing ids were deleted, never issued, or are outside your token scope. Deleted topics may have a headstone in The Ledger (graveyard).';
    }
    return json(out);
  });

  guarded('upsert_entity', {
    title: 'Create or update entity',
    description:
      'Create a new topic/project, or update its one-line summary. Does not touch its observations.',
    inputSchema: {
      section: SECTION,
      name: z.string().describe('Entity name.'),
      summary: z.string().optional().describe('Short one-line summary of what this entity is / current status.'),
    },
  }, async ({ section, name, summary }) => {
    return json(db.upsertEntity(section, name, summary));
  });

  guarded('remove_entity', {
    title: 'Remove entity',
    description:
      'Delete a topic/project entirely, including all of its observations. Refuses if the entity ' +
      'contains any protected observations - unprotect them first if the deletion is really intended.',
    inputSchema: {
      section: SECTION,
      name: z.string().describe('Entity name to delete.'),
    },
  }, async ({ section, name }) => {
    const r = db.removeEntity(section, name);
    if (r.ok) return text(`Removed "${name}" from ${section}.`);
    if (r.reason === 'protected') return text(`Refused: "${name}" contains ${r.count} protected observation(s). Unprotect them first if you really mean to delete this entity.`);
    return text(`No entity named "${name}" in ${section}.`);
  });

  guarded('add_observation', {
    title: 'Add observation',
    description:
      'Add a fact to a topic/project. Creates the entity if it does not exist yet. ' +
      'Use this to record current state, e.g. "deployed on port 7782" or "waiting on PennyMac callback".',
    inputSchema: {
      section: SECTION,
      entity: z.string().describe('Entity name this observation belongs to.'),
      content: z.string().describe('The fact itself, written plainly.'),
    },
  }, async ({ section, entity, content }) => {
    return json(db.addObservation(section, entity, content));
  });

  guarded('update_observation', {
    title: 'Update observation',
    description:
      'Edit an observation in place: content changes, the ID stays stable for life, timestamp refreshes. ' +
      'Use this instead of delete-and-recreate when a fact evolves - it keeps observation IDs usable as ' +
      'permanent addresses (e.g. for skill files and standing rules). Allowed on protected observations.',
    inputSchema: {
      section: SECTION,
      observation_id: z.number().int().describe('The id of the observation to update.'),
      content: z.string().describe('The new full content (replaces the old content entirely).'),
    },
  }, async ({ section, observation_id, content }) => {
    const r = db.updateObservation(section, observation_id, content);
    if (!r.ok) return text(`No observation ${observation_id} found in ${section}.`);
    return json(r);
  });

  guarded('protect_observation', {
    title: 'Protect observation',
    description:
      'Mark an observation as protected: it can no longer be deleted (remove_observation refuses), only ' +
      'updated in place. Use for skill files, standing rules, permanent URLs, and incident lessons - ' +
      'anything where the cost of forgetting is high and the trigger to re-learn may never come.',
    inputSchema: {
      section: SECTION,
      observation_id: z.number().int().describe('The id of the observation to protect.'),
    },
  }, async ({ section, observation_id }) => {
    const r = db.setObservationProtected(section, observation_id, true);
    if (!r.ok) return text(`No observation ${observation_id} found in ${section}.`);
    return text(`Observation ${observation_id} (${r.entity}) is now protected.`);
  });

  guarded('unprotect_observation', {
    title: 'Unprotect observation',
    description:
      'Remove the protected flag from an observation so it can be deleted again. ' +
      'Only do this deliberately - protection exists so groom passes cannot silently destroy load-bearing facts.',
    inputSchema: {
      section: SECTION,
      observation_id: z.number().int().describe('The id of the observation to unprotect.'),
    },
  }, async ({ section, observation_id }) => {
    const r = db.setObservationProtected(section, observation_id, false);
    if (!r.ok) return text(`No observation ${observation_id} found in ${section}.`);
    return text(`Observation ${observation_id} (${r.entity}) is no longer protected.`);
  });

  guarded('remove_observation', {
    title: 'Remove observation',
    description:
      'Delete a single observation by id (get the id from get_landscape or get_entity first). ' +
      'Use this to clean up facts that are now stale or wrong. Refuses on protected observations - ' +
      'update them instead, or unprotect first if deletion is truly intended.',
    inputSchema: {
      section: SECTION,
      observation_id: z.number().int().describe('The id of the observation to remove.'),
    },
  }, async ({ section, observation_id }) => {
    const r = db.removeObservation(section, observation_id);
    if (r.ok) return text(`Removed observation ${observation_id}.`);
    if (r.reason === 'protected') return text(`Refused: observation ${observation_id} is protected. Use update_observation to change it, or unprotect_observation first if you really mean to delete it.`);
    return text(`No observation ${observation_id} found in ${section}.`);
  });

  guarded('log_event', {
    title: 'Log event',
    description:
      'Append a one-line entry to the history log. Use for things that happened ' +
      '("closed on NJ house sale", "started recasting mortgage with PennyMac"). ' +
      'Optionally link it to an entity/topic.',
    inputSchema: {
      section: SECTION,
      content: z.string().describe('What happened, written plainly.'),
      entity: z.string().optional().describe('Optional entity/topic name to link this event to.'),
    },
  }, async ({ section, content, entity }) => {
    return json(db.logEvent(section, content, entity));
  });

  guarded('get_history', {
    title: 'Get history',
    description:
      'Get recent history log entries for a section, optionally filtered to one entity/topic.',
    inputSchema: {
      section: SECTION,
      limit: z.number().int().min(1).max(200).optional().describe('Max entries to return (default 20).'),
      entity: z.string().optional().describe('Optional entity/topic name to filter to.'),
    },
  }, async ({ section, limit, entity }) => {
    return json(db.getHistory(section, limit, entity));
  });

  guarded('search', {
    title: 'Search',
    description:
      'Search entities, observations, and history events for a keyword. Use when you need ' +
      'to find something but do not know the exact entity name. Observation results include ' +
      'their ids - usable directly with get_observation and obs-number handoffs.',
    inputSchema: {
      section: SECTION,
      query: z.string().describe('Keyword or phrase to search for.'),
    },
  }, async ({ section, query }) => {
    return json(db.search(section, query));
  });

  guarded('create_reminder', {
    title: 'Create reminder',
    description:
      'Create a time-based reminder that will automatically appear in get_landscape output ' +
      'on or after its trigger date - no need for the user to bring it up again. ' +
      'Use for things like cert/license expirations, "start flagging X on date Y", or anything ' +
      'with a known future date it should resurface on. ' +
      'OPTIONAL trigger_time (HH:MM, 24h, America/New_York): set it to make this a TIMED reminder ' +
      'that actively fires a Slack DM to Dan at/after that time (e.g. "ask Josh at 12:00", ' +
      '"call the hotel at 15:00"), in addition to appearing in get_landscape. Omit trigger_time for ' +
      'a date-only reminder (surfaces in get_landscape on/after the date, no active push).',
    inputSchema: {
      section: SECTION,
      content: z.string().describe('The reminder text, written plainly, e.g. "Apple Push Cert expires September 2026 - action needed."'),
      trigger_date: z.string().describe('Date (YYYY-MM-DD) on or after which this reminder should start appearing in get_landscape.'),
      trigger_time: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'trigger_time must be HH:MM (24h)').optional().describe('Optional HH:MM (24h), America/New_York. When set, the reminder actively fires a Slack DM to Dan at/after trigger_date+trigger_time (once). Omit for a date-only reminder.'),
      entity: z.string().optional().describe('Optional entity/topic name to link this reminder to.'),
    },
  }, async ({ section, content, trigger_date, trigger_time, entity }) => {
    return json(db.createReminder(section, content, trigger_date, entity, trigger_time));
  });

  guarded('list_reminders', {
    title: 'List reminders',
    description:
      'List reminders for a section, including ones not yet due. Use this to check what is ' +
      'scheduled, or pass include_dismissed to see resolved ones too. get_landscape only shows ' +
      'reminders that are already due - use this tool for the full picture.',
    inputSchema: {
      section: SECTION,
      include_dismissed: z.boolean().optional().describe('Include dismissed reminders too (default false).'),
    },
  }, async ({ section, include_dismissed }) => {
    return json(db.listReminders(section, include_dismissed));
  });

  // --- Due-reminder surfacing + timed firing ------------------------------------------
  // list_due_reminders returns EVERYTHING currently due: date-only reminders (passive,
  // stay due until dismissed) plus timed ones that have not yet fired. danfeed polls it,
  // DMs Dan for the TIMED rows only (it skips rows without a trigger_time), then calls
  // mark_reminder_fired so a timed reminder never re-fires.
  guarded('list_due_reminders', {
    title: 'List due reminders',
    description:
      'List every reminder that is currently due and not dismissed: date-only reminders ' +
      '(no trigger_time) whose trigger_date has arrived in America/New_York - these stay ' +
      'due until dismissed - plus TIMED reminders whose date+time has arrived and that ' +
      'have NOT yet fired. The reminder loop that DMs Dan polls this and delivers only ' +
      'the timed rows (then calls mark_reminder_fired); date-only rows are passive and ' +
      'are cleared with dismiss_reminder.',
    inputSchema: {
      section: SECTION,
    },
  }, async ({ section }) => {
    return json(db.getDueReminders(section));
  });

  guarded('mark_reminder_fired', {
    title: 'Mark reminder fired',
    description:
      'Stamp a TIMED reminder as fired (delivered) so it will not fire again. Call this right ' +
      'after successfully DMing Dan for a timed reminder returned by list_due_reminders. ' +
      'Idempotent: a second call for the same id is a no-op. Does not dismiss the reminder - it ' +
      'still shows in get_landscape until dismissed. Not for date-only reminders: they have no ' +
      'firing step and stay due until dismissed regardless of fired_at.',
    inputSchema: {
      section: SECTION,
      reminder_id: z.number().int().describe('The id of the reminder that was just delivered.'),
    },
  }, async ({ section, reminder_id }) => {
    const ok = db.markReminderFired(section, reminder_id);
    return text(ok ? `Marked reminder ${reminder_id} fired.` : `No unfired reminder ${reminder_id} found in ${section}.`);
  });

  guarded('dismiss_reminder', {
    title: 'Dismiss reminder',
    description:
      'Mark a reminder as handled/acknowledged so it stops appearing in get_landscape. ' +
      'Get the id from get_landscape (for due ones) or list_reminders (for any). ' +
      'This keeps the reminder around (dismissed) rather than deleting it - use remove_reminder ' +
      'if it should be gone entirely.',
    inputSchema: {
      section: SECTION,
      reminder_id: z.number().int().describe('The id of the reminder to dismiss.'),
    },
  }, async ({ section, reminder_id }) => {
    const ok = db.dismissReminder(section, reminder_id);
    return text(ok ? `Dismissed reminder ${reminder_id}.` : `No active reminder ${reminder_id} found in ${section}.`);
  });

  guarded('remove_reminder', {
    title: 'Remove reminder',
    description: 'Permanently delete a reminder (dismissed or not). Use dismiss_reminder instead if you just want it to stop showing up but keep a record.',
    inputSchema: {
      section: SECTION,
      reminder_id: z.number().int().describe('The id of the reminder to delete.'),
    },
  }, async ({ section, reminder_id }) => {
    const ok = db.removeReminder(section, reminder_id);
    return text(ok ? `Removed reminder ${reminder_id}.` : `No reminder ${reminder_id} found in ${section}.`);
  });

  // -------------------------------------------------------------------------
  // v3 STRUCTURED BOARD (PCT-15801 Phase 2). Typed rows on the board_rows
  // table. All fences live in the DB (CHECK/NOT NULL/FK/triggers); these tools
  // are just the guarded single-writer path to them. Timestamps and age are
  // owned by the DB + render, never by the model (governing rule, shared obs
  // 873). No delete tool yet: deletion and its closure-refuse fence land
  // together in item 3, so the destructive path never ships without its fence.
  // -------------------------------------------------------------------------
  const BOARD_STATUS = z.enum(['todo', 'in_progress', 'on_hold', 'done']);

  function decorate(row) {
    return {
      ...row,
      related: safeParse(row.related),
      age_days: ageDays(row.source_date || row.status_changed_at),   // true ticket age when known, else stuck-ness
      lifespan_days: ageDays(row.source_date || row.created_at),      // true ticket age when known, else time-on-board
      needs_note: row.status !== 'todo' && row.status !== 'done' && !(row.waiting_on && String(row.waiting_on).trim()),  // FLAG: non-todo piece missing its comment -> Claude fills or asks Dan
    };
  }

  guarded('board_add', {
    title: 'Add board row',
    description:
      'Add a typed row to the v3 structured work board. Returns the immutable row number. ' +
      'Status defaults to "active". Use related for linked Jira keys. Nothing auto-promotes onto ' +
      'the board - a row exists because a human decision put it here.',
    inputSchema: {
      section: SECTION,
      title: z.string().describe('Short row headline.'),
      status: BOARD_STATUS.optional().describe('Defaults to "todo".'),
      related: z.array(z.string()).min(1).describe('Required - one or more ticket numbers, e.g. ["PCT-15801"]. A board piece must carry a ticket ("on the board => it has a ticket").'),
      waiting_on: z.string().optional().describe('Claude\'s OWN internal note/context on this row - NOT a mirror of the Jira ticket and never assumed to reflect its current state (Atlas obs 1086, Aug 10, after PCT-16053 carried forward a stale name mix-up). Write what Claude currently understands, re-check Jira before trusting it.'),
      source_date: z.string().optional().describe('The ticket real date (e.g. Jira created, ISO) so board age reflects true ticket age, not time-on-board.'),
      in_sprint: z.boolean().optional().describe('True if the ticket is in the current active sprint (drives current-sprint-first ordering). danfeed supplies this.'),
      sprint: z.string().optional().describe('Sprint number/label for display, e.g. "15" (danfeed supplies from Jira). Display only.'),
    },
  }, async ({ section, title, status, related, waiting_on, source_date, in_sprint, sprint }) => {
    return json(db.addBoardRow(section, title, { status, related, waiting_on, source_date, in_sprint: in_sprint ? 1 : 0, sprint }));
  });

  guarded('board_list', {
    title: 'List board rows',
    description:
      'List structured board rows for a section, lowest row number first. Hides done rows by ' +
      'default (the live board); pass include_done for everything. age_days = time in the current ' +
      'status (stuck-ness); lifespan_days = time since the row was created.',
    inputSchema: {
      section: SECTION,
      include_done: z.boolean().optional().describe('Include done rows too (default false).'),
    },
  }, async ({ section, include_done }) => {
    return json(db.listBoardRows(section, include_done).map(decorate));
  });

  guarded('board_get', {
    title: 'Get board row',
    description: 'Get one board row by its immutable row number.',
    inputSchema: {
      section: SECTION,
      row_id: z.number().int().describe('The immutable row number.'),
    },
  }, async ({ section, row_id }) => {
    const row = db.getBoardRow(section, row_id);
    if (!row) return text(`No board row ${row_id} in ${section}.`);
    return json(decorate(row));
  });

  guarded('board_update', {
    title: 'Update board row',
    description:
      'Update a board row by its number - any subset of title / status / related / waiting_on. ' +
      'Timestamps are the database\'s job: updated_at bumps on every change, status_changed_at moves ' +
      'only when status actually changes. Status is CHECK-enforced (active/waiting/blocked/done). ' +
      'waiting_on is Claude\'s OWN note, not ticket truth (see its describe) - it can go stale; the ' +
      'view\'s Last Comment column is the intended live Jira-side check (not yet populated by anyone - ' +
      'that\'s danfeed\'s follow-up, obs 1086/1087), this field never is that check.',
    inputSchema: {
      section: SECTION,
      row_id: z.number().int().describe('The immutable row number to update.'),
      title: z.string().optional(),
      status: BOARD_STATUS.optional(),
      related: z.array(z.string()).optional().describe('Replaces the related list.'),
      waiting_on: z.string().optional().describe('Claude\'s OWN internal note/context - NOT a mirror of the Jira ticket, never assumed current (obs 1086). Re-check Jira before trusting an existing one; don\'t just carry it forward.'),
      in_sprint: z.boolean().optional().describe('Mark whether the ticket is in the current active sprint (danfeed maintains this).'),
      sprint: z.string().optional().describe('Sprint number/label for display, e.g. "15" (danfeed supplies from Jira). Display only.'),
      last_comment: z.string().optional().describe('The actual last Jira comment text - live ticket-side truth, kept separate from waiting_on on purpose (obs 1086). This is danfeed\'s field to write (it already polls Jira), not Claude\'s in a chat session - atlas-v2 itself never fetches Jira.'),
    },
  }, async ({ section, row_id, title, status, related, waiting_on, in_sprint, sprint, last_comment }) => {
    const fields = {};
    if (title !== undefined) fields.title = title;
    if (status !== undefined) fields.status = status;
    if (related !== undefined) fields.related = related;
    if (waiting_on !== undefined) fields.waiting_on = waiting_on;
    if (in_sprint !== undefined) fields.in_sprint = in_sprint;
    if (sprint !== undefined) fields.sprint = sprint;
    if (last_comment !== undefined) fields.last_comment = last_comment;
    const r = db.updateBoardRow(section, row_id, fields);
    if (!r.ok) return text(`No board row ${row_id} in ${section}.`);
    return json(r);
  });

  guarded('board_close', {
    title: 'Close a board piece',
    description:
      'Close a board piece the sanctioned way: writes a ledger line (an events entry) and sets ' +
      'status=done with closure_ref pointing at it. The DB refuses status=done without a closure_ref ' +
      '(item 3 fence), so this is how closing happens. Closed pieces drop from the live view but are ' +
      'retained forever. Propose to Dan; run on his confirm.',
    inputSchema: {
      section: SECTION,
      row_id: z.number().int(),
      closure: z.string().describe('The closure reason / outcome - becomes the ledger line.'),
    },
  }, async ({ section, row_id, closure }) => {
    const piece = db.getBoardRow(section, row_id);
    if (!piece) return text(`No board piece ${row_id} in ${section}.`);
    if (piece.status === 'done') return text(`Board piece ${row_id} is already done.`);
    const ev = db.logEvent(section, `Closed board piece #${row_id} ${piece.related} - ${closure}`);
    const r = db.updateBoardRow(section, row_id, { status: 'done', closure_ref: ev.event_id });
    if (!r.ok) return text(`Close failed for ${row_id}: ${r.reason || 'unknown'}.`);
    return json({ ok: true, closed: row_id, closure_ref: ev.event_id });
  });

  guarded('board_reconcile', {
    title: 'Reconcile board against a ticket snapshot',
    description:
      'Deterministic drift check between the live board and an authoritative ticket snapshot (pass ' +
      'current tickets from Jira or danfeed). Returns: drifted (piece not done but its ticket is done ' +
      'in the snapshot), orphaned (piece whose ticket is absent from the snapshot), missing (open ' +
      'snapshot tickets not on any live piece). The diff is the mechanism; the caller supplies the ' +
      'snapshot. Report only - changes nothing. This is the reconcile-at-boot core; danfeed/hook feed it.',
    inputSchema: {
      section: SECTION,
      tickets: z.array(z.object({
        key: z.string(),
        done: z.boolean().describe('True if the source considers this ticket resolved/closed.'),
      })).describe('Authoritative current ticket snapshot (Jira or danfeed /jira).'),
    },
  }, async ({ section, tickets }) => {
    const snap = new Map(tickets.map((t) => [t.key, !!t.done]));
    const pieces = db.listBoardRows(section, false); // live pieces only
    const onBoard = new Set();
    const drifted = [], orphaned = [];
    for (const p of pieces) {
      let rel = [];
      try { rel = JSON.parse(p.related); } catch (e) { rel = [p.related]; }
      rel.forEach((k) => onBoard.add(k));
      const known = rel.filter((k) => snap.has(k));
      if (known.length === 0) { orphaned.push({ row_id: p.id, related: rel, title: p.title }); continue; }
      if (known.some((k) => snap.get(k) === true)) {
        drifted.push({ row_id: p.id, related: rel, status: p.status, title: p.title, note: 'ticket done in source, piece not' });
      }
    }
    const missing = tickets.filter((t) => !t.done && !onBoard.has(t.key)).map((t) => t.key);
    return json({ checked_tickets: tickets.length, live_pieces: pieces.length, drifted, orphaned, missing });
  });

  guarded('board_bump', {
    title: 'Bump a board piece to the top',
    description:
      'Dan override: bump a piece to the top of the board ("work on N"). Default order is oldest-first; ' +
      'a bumped piece floats above that. The most recently bumped sits highest. Use board_unbump to clear.',
    inputSchema: { section: SECTION, row_id: z.number().int() },
  }, async ({ section, row_id }) => {
    const r = db.bumpBoardRow(section, row_id);
    if (!r.ok) return text(`No board piece ${row_id} in ${section}.`);
    return json({ ok: true, bumped: row_id });
  });

  guarded('board_unbump', {
    title: 'Clear a board piece bump',
    description: 'Remove a piece\'s bump so it returns to the default oldest-first order.',
    inputSchema: { section: SECTION, row_id: z.number().int() },
  }, async ({ section, row_id }) => {
    const r = db.bumpBoardRow(section, row_id, true);
    if (!r.ok) return text(`No board piece ${row_id} in ${section}.`);
    return json({ ok: true, unbumped: row_id });
  });

  guarded('board_move', {
    title: 'Move a board piece to a slot',
    description:
      'Dan override: "move X to Y" - pin piece X at slot Y within the pinned band (top of the board). ' +
      'Pinned pieces always sit above the auto (oldest-first) band; the slot is clamped to the pinned ' +
      'band length. Renumbers the pinned band to clean 1..k. Pin is visual ordering ONLY - it never ' +
      'touches status (Atlas obs 979/984 item 3, fixed 2026-08-10): a held piece stays On Hold when moved.',
    inputSchema: { section: SECTION, row_id: z.number().int(), position: z.number().int().min(1).describe('Target slot, 1 = top.') },
  }, async ({ section, row_id, position }) => {
    const r = db.moveBoardRow(section, row_id, position);
    if (!r.ok) return text(`No board piece ${row_id} in ${section}.`);
    return json(r);
  });

  guarded('board_hold', {
    title: 'Put a piece On Hold (bottom band)',
    description:
      'Dan "drop X" / "hold X": set the piece to On Hold - sinks it to the bottom band (not lost, just ' +
      'last) and clears any pin. A reason is preferred; if omitted the piece is ' +
      'flagged needs_note for Claude to fill or ask Dan - never blocked. Pair with Jira -> On Hold + comment (board-ops skill). ' +
      'The reason is Claude\'s OWN note (obs 1086) - not ticket truth, can go stale, re-check Jira before trusting an old one.',
    inputSchema: { section: SECTION, row_id: z.number().int(), reason: z.string().optional().describe('Claude\'s OWN short reason it is on hold - NOT a mirror of the Jira ticket, never assumed current (obs 1086, after PCT-16053 carried a stale name mix-up forward). Optional - omit and it is flagged as needing a note.') },
  }, async ({ section, row_id, reason }) => {
    const r = db.holdBoardRow(section, row_id, reason);
    if (!r.ok) return text(`No board piece ${row_id} in ${section}.`);
    return json({ ok: true, on_hold: row_id });
  });

  guarded('board_release', {
    title: 'Release a piece from holding',
    description: 'Take a piece off On Hold - back to To Do in the normal order (clears the hold reason).',
    inputSchema: { section: SECTION, row_id: z.number().int() },
  }, async ({ section, row_id }) => {
    const r = db.releaseBoardRow(section, row_id);
    if (!r.ok) return text(`No board piece ${row_id} in ${section}.`);
    return json({ ok: true, released: row_id });
  });

  guarded('board_offboard', {
    title: 'Take a piece off the board (not closed)',
    description:
      'Remove a piece from the live board WITHOUT closing it (does not touch Jira, does not fake Done). For ' +
      'pieces that are not real board work: epics/capabilities (documents that make work), or a driver ticket ' +
      '(GSSD/INFRA/CHANGE/PIRISK) whose work now lives in a PCT story. Kept in the store with an events trace ' +
      '(VIEW vs STORE); reversible via board_restore.',
    inputSchema: { section: SECTION, row_id: z.number().int(), reason: z.string().min(1).describe('Why it is not a board item (e.g. "Capability - a document that makes work" or "superseded by PCT-XXXX").') },
  }, async ({ section, row_id, reason }) => {
    const piece = db.getBoardRow(section, row_id);
    if (!piece) return text(`No board piece ${row_id} in ${section}.`);
    const r = db.updateBoardRow(section, row_id, { on_board: 0 });
    if (!r.ok) return text(`Off-board failed for ${row_id}: ${r.reason || 'unknown'}.`);
    db.logEvent(section, `Off-board piece #${row_id} ${piece.related} - ${reason}`);
    return json({ ok: true, offboard: row_id });
  });

  guarded('board_restore', {
    title: 'Restore a piece to the board',
    description: 'Bring an off-board piece back onto the live board (on_board=1).',
    inputSchema: { section: SECTION, row_id: z.number().int() },
  }, async ({ section, row_id }) => {
    const r = db.updateBoardRow(section, row_id, { on_board: 1 });
    if (!r.ok) return text(`No board piece ${row_id} in ${section}.`);
    db.logEvent(section, `Restored piece #${row_id} to the board`);
    return json({ ok: true, restored: row_id });
  });

  // -------------------------------------------------------------------------
  // PENDING TRAY (PCT-15801 Phase 2, item 2). Candidates with no ticket yet.
  // Three fates, each leaving an events trace: merge into a piece / promote to a
  // new piece (needs a ticket) / dismiss (logged). Merge & promote are propose-
  // then-confirm (obs 874 #8): the tool runs only when Dan says go. Resolved
  // items drop out of pending_list by design (VIEW vs STORE, obs 875).
  // -------------------------------------------------------------------------
  function decoratePending(p) {
    // age from the ticket's real date when danfeed supplied it, else tray-arrival.
    return { ...p, age_days: ageDays(p.source_date || p.created_at) };
  }

  guarded('pending_add', {
    title: 'Add pending item',
    description:
      'Add an untriaged candidate to the pending tray (no ticket yet). Use for a Slack line / email / raw ' +
      'signal that might be real work. It sits in the tray, oldest first, until a human decision merges it ' +
      'into a piece, promotes it to a new piece, or dismisses it.',
    inputSchema: {
      section: SECTION,
      summary: z.string().describe('One line: what this is.'),
      source: z.enum(['slack', 'jira', 'email', 'calendar', 'manual']).optional().describe('Where it came from (default manual).'),
      source_ref: z.string().optional().describe('Origin id: slack ts+channel, jira key, etc.'),
      source_date: z.string().optional().describe('The origin ticket/message real date (e.g. the Jira created date, ISO). Age is computed from this when present, so it reflects the ticket\'s true age, not time-in-tray.'),
    },
  }, async ({ section, summary, source, source_ref, source_date }) => {
    return json(db.addPendingItem(section, summary, { source, source_ref, source_date }));
  });

  guarded('pending_list', {
    title: 'List pending tray',
    description:
      'List untriaged pending items for a section, oldest first. Resolved items (merged / promoted / ' +
      'dismissed) are hidden by design - they are retained in the store, just not shown.',
    inputSchema: { section: SECTION },
  }, async ({ section }) => {
    return json(db.listPending(section).map(decoratePending));
  });

  guarded('pending_merge', {
    title: 'Merge pending item into a piece',
    description:
      'Fold a pending item into an EXISTING board piece (it was more info about a ticket you already have). ' +
      'The item leaves the tray but is retained, linked to the piece as provenance. Propose to Dan; run only on his confirm.',
    inputSchema: {
      section: SECTION,
      pending_id: z.number().int(),
      into_row_id: z.number().int().describe('The board piece to merge into.'),
    },
  }, async ({ section, pending_id, into_row_id }) => {
    const piece = db.getBoardRow(section, into_row_id);
    if (!piece) return text(`No board piece ${into_row_id} in ${section}.`);
    const p = db.getPending(section, pending_id);
    if (!p) return text(`No pending item ${pending_id} in ${section}.`);
    const r = db.resolvePending(section, pending_id, 'merged', { merged_into: into_row_id });
    if (!r.ok) return text(`Pending ${pending_id}: ${r.reason}${r.state ? ' (' + r.state + ')' : ''}.`);
    db.logEvent(section, `Board: merged pending #${pending_id} (${p.source}${p.source_ref ? ' ' + p.source_ref : ''}) into piece #${into_row_id} ${piece.related} - ${p.summary}`);
    return json({ ok: true, merged: pending_id, into: into_row_id });
  });

  guarded('pending_promote', {
    title: 'Promote pending item to a new piece',
    description:
      'Turn a pending item into a NEW board piece. Requires at least one ticket number ("on the board => it ' +
      'has a ticket"). The pending item is retained, linked to the new piece. Propose to Dan; run only on his confirm.',
    inputSchema: {
      section: SECTION,
      pending_id: z.number().int(),
      title: z.string().describe('The new piece headline.'),
      related: z.array(z.string()).min(1).describe('One or more ticket numbers - required.'),
      status: BOARD_STATUS.optional(),
      waiting_on: z.string().optional(),
    },
  }, async ({ section, pending_id, title, related, status, waiting_on }) => {
    const p = db.getPending(section, pending_id);
    if (!p) return text(`No pending item ${pending_id} in ${section}.`);
    if (p.state !== 'pending') return text(`Pending ${pending_id} already ${p.state}.`);
    const { row_id } = db.addBoardRow(section, title, { related, status, waiting_on, source_date: p.source_date });
    db.resolvePending(section, pending_id, 'promoted', { merged_into: row_id });
    db.logEvent(section, `Board: promoted pending #${pending_id} (${p.source}${p.source_ref ? ' ' + p.source_ref : ''}) to new piece #${row_id} ${JSON.stringify(related)} - ${title}`);
    return json({ ok: true, promoted: pending_id, new_piece: row_id });
  });

  guarded('pending_dismiss', {
    title: 'Dismiss pending item',
    description:
      'Drop a pending item as not real work. It leaves the tray but is retained with the reason - logged, ' +
      'never silently deleted (a silent drop is just a new way to lose a pawn).',
    inputSchema: {
      section: SECTION,
      pending_id: z.number().int(),
      reason: z.string().describe('Why it is not real work.'),
    },
  }, async ({ section, pending_id, reason }) => {
    const p = db.getPending(section, pending_id);
    if (!p) return text(`No pending item ${pending_id} in ${section}.`);
    if (p.state !== 'pending') return text(`Pending ${pending_id} already ${p.state}.`);
    db.resolvePending(section, pending_id, 'dismissed', { resolution_note: reason });
    db.logEvent(section, `Board: dismissed pending #${pending_id} (${p.source}${p.source_ref ? ' ' + p.source_ref : ''}) - ${reason}`);
    return json({ ok: true, dismissed: pending_id });
  });

  guarded('pending_reopen', {
    title: 'Recover a resolved tray item',
    description:
      'Un-dismiss / recover a resolved (dismissed / merged / promoted) pending item back into the tray. ' +
      'For fixing a wrong dismissal - the item was retained in the store; this brings it back to pending.',
    inputSchema: { section: SECTION, pending_id: z.number().int() },
  }, async ({ section, pending_id }) => {
    const r = db.reopenPending(section, pending_id);
    if (!r.ok) return text(`No pending item ${pending_id} in ${section}.`);
    db.logEvent(section, `Board: recovered pending #${pending_id} back to the tray`);
    return json({ ok: true, reopened: pending_id });
  });
}

module.exports = { registerTools };
