# Atlas — Mission

## What Atlas is

Atlas is a small, self-hosted MCP server whose only job is to give every Claude
thread — work or personal, any conversation, any time — a shared sense of
"what's going on."

## The problem it solves

Every Claude conversation starts from zero. If Dan tells one thread about a
decision, a change, or a piece of infrastructure, no other thread knows about
it unless Dan repeats himself. Claude's own memory across sessions is not
reliable enough to depend on. Atlas exists so Dan doesn't have to rehash
history to catch a thread up, and so Claude doesn't have to depend on its own
memory to do it.

## The end goal

Claude learns about Dan over time — his projects, decisions, standing rules,
context, ongoing work — well enough to actually help him, without Dan having
to re-explain himself every session.

## Design principles (established, not up for re-litigation)

- **Sections are hard-scoped.** work / personal / shared. A token only ever
  reaches its own section plus shared. Out-of-scope requests are refused
  server-side (403), not filtered client-side.
- **Nothing is silently destroyed.** Deletes leave a trace where possible
  (graveyard/headstone convention). Protected rows are physically
  undeletable by any automated process.
- **Every rule is a deterministic DB fence** (CHECK / FK / trigger), not a
  convention someone has to remember to enforce.
- **Propose-then-confirm, not auto-act.** Automated processes (groom) find
  and flag; a human (Dan, in conversation or via a review page) decides and
  confirms; Claude executes on confirmation.
- **Full-landscape ingestion, no vector/graph layer.** Deliberately simple —
  SQLite, direct reads. This is a design choice, not a gap.

## Known standing tension (as of 2026-08-09)

Atlas captures a lot — Dan chats and researches heavily ("spitfire" mode),
and most of what gets discussed is exploration, not commitment. Volume grows
faster than anything trims it. The system needs a real decay/compaction path
so growth doesn't outpace usefulness, and it needs that path to run mostly
without demanding Dan's constant attention — otherwise the review burden
becomes its own version of the original problem (rehashing, just in a
different shape).

This tension is the direct motivation for the Level/Groom-Review design
(see GROOM-REVIEW-DESIGN.md).
