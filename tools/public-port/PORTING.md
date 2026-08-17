# Porting Atlas to the public plane

The public release tree lives in `public/`. It is the source of truth for
[github.com/dcazman/Claude-Atlas-MCP](https://github.com/dcazman/Claude-Atlas-MCP)
— edit it here, gate it here, then push that directory's contents to the public
repo.

## Why the public tree is authored, not generated

The obvious approach — a script that copies `src/` from this repo and strips out
the private parts — was tried in July 2026 by hand and failed in an instructive
way: the copy reintroduced personal example strings that had *already* been
scrubbed once, because the leak was in source comments and tool descriptions
rather than in the docs anyone thought to re-read.

Automating that same copy would automate the same failure, and the private tree
has since grown a large subsystem (the board) that the public tree deliberately
does not have. Stripping it back out mechanically would be brittle text surgery
on a running production server's source.

So: the public tree is authored from the private one feature by feature, and the
**gate** is what's automated.

## The gate

```bash
node tools/public-port/scrub-check.js        # defaults to public/
```

It scans every byte of every file in the release tree — comments and zod
`.describe()` strings included, because that's where the last leak was — against
a deny-list of private identifiers: owner and employer names, tracker vocabulary,
private hostnames and LAN addresses, database row citations, internal doc
references, and credential shapes (GitHub tokens, API keys, 48-char hex secrets).

A hit fails with the file, line, and matched text. Run it before every push to
the public repo. It is deliberately strict: a false positive costs a reworded
sentence, a false negative costs a public leak.

## What crossed, and what didn't

**Ported (v3 of the public tree):**

| Feature | Notes |
|---|---|
| `get_observation` | Obs-number addressing. Scope resolves from the row; out-of-scope is indistinguishable from nonexistent. |
| Timed reminders | `trigger_time` + `fired_at`, `list_due_reminders`, `mark_reminder_fired`. |
| The tray | `pending_*`, 6 tools. Retargeted: promotion creates an **observation** instead of a board row, and `merged_into` points at another tray item. |
| The shelf | `research_*`, 5 tools. Graduates into the tray. |
| Configurable timezone | New `src/tz.js`. Everything that was hardcoded to one zone now reads `ATLAS_TZ`. |
| First-run tokens | Generated per scope, persisted in the data dir, printed once. |
| Tests | Blank-slate migration, scope matrix, funnel, reminder firing. |

**Deliberately not ported:**

- **The board** and its web view (17 tools, ~650 lines of rendering). It is
  welded to one person's working life: issue-tracker keys, sprint vocabulary, a
  required ticket reference, a hardcoded tracker URL, and slot-numbering rules
  that only make sense alongside the skills that drive them. A generic version
  would be a different product, not a scrub.
- **Plan tools** (`board_plan_*`) — they order board pieces.
- **Workers** (`worker_*`) — they pin a board slot.
- **`skills.json`** — a personal skills directory, served on the board's view.
- **`ATLAS.md`, the runbook, `verify.js`, `src/*.bak.*`** — private operational
  material, a one-shot cutover script, and pre-git snapshots.

## Version ladders diverge on purpose

The two trees have separate `PRAGMA user_version` ladders. The private tree is
at 21, most of which is board schema the public tree will never have; the public
tree is at 3. Do not try to align them — map features instead:

| Public | Private origin |
|---|---|
| 2 | v2: shared section, scoped tokens, protected observations, audit log |
| 3 | v14 (timed reminders) + v4/v19 (tray, shelf), rebuilt without board coupling |

## Porting a new feature forward

1. Build it in the private tree first if it's needed in production; the public
   tree is not a staging area for unfinished work.
2. Author the public version in `public/`, writing the descriptions fresh rather
   than copying them — private tool descriptions carry private examples, and
   those descriptions are the leak surface.
3. Add or extend a test. The public suite runs from an empty database, so a new
   table without a migration fails immediately.
4. `cd public && npm test`
5. `node tools/public-port/scrub-check.js`
6. Push `public/`'s contents to the public repo.

## Pushing to the public repo

The public repo keeps its own `README.md`, `SECURITY.md`, `LICENSE`, and
workflows — they are part of the release tree here and travel with it. Nothing
in `public/` should ever reference this repository, the host it runs on, or
anything in the private sections.
