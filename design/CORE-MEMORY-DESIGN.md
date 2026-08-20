# Atlas — Core Memory Tier (Design, shipped)

Status: **Shipped 2026-08-20.** Captured same day, after a talk-only design
session with Dan (explicitly "we do nothing until we agree" until the last
step). Read ATLAS-MISSION.md first if you haven't - this exists to serve
that mission, specifically the "get_landscape doesn't work" complaint.

---

## The problem this solves

`get_landscape` is the default boot call - every session starts with it to
get oriented. It returned every entity in a section, with no bound. On this
host, `all=true` on work+shared came back at 668,939 chars - confirmed by
dry run, not an estimate.

The instinct going in was that this was a *duplication* problem (near-dupe
entities) or a *mega-observation* problem (one huge fact bloating an
entity). Both are real and both have their own fix already recorded
elsewhere (see "Atlas Duplicate Prevention & Cleanup Plan" - shared entity).
But neither explains the boot-call size on its own: the actual cause is
simpler and structural - the default call has no bound at all. Fixing
duplication or oversized observations would shrink the number somewhat;
only bounding the default call fixes the failure mode itself.

## Detour: Obsidian/markdown

Dan's first framing was structural in a different sense - convert Atlas to
an Obsidian vault so he could see and organize it, on the theory that
"structure" (which KB already proves works for him) was the missing piece.
Worth recording why that detour ended without shipping anything:

- KB's structure is topical/status-based (work/personal/dump/closed/...).
  Atlas's actual pain wasn't findability-for-Dan, it was
  boot-call-size-for-Claude - a different axis.
- The addressing problem (board rows point at specific observation IDs;
  files would need a stable pointer that survives renames/moves) was
  solvable - Obsidian block references (`^obsNNN`) reusing the existing
  observation numbering was the concrete answer - but solving it doesn't
  by itself shrink anything or stop duplication.
- The deciding moment: Dan clarified visibility was only ever
  *instrumental* to fixing the bloat, not a goal on its own. Once that was
  on the table, the file-format question dropped out entirely - the actual
  ask was "make get_landscape work," which doesn't require a storage
  format change.

## MemGPT vs MemoryBank

Researched both as the closest real prior art once the "now vs. everything
else" shape came up independently from Dan (his framing: chess - "move X to
Y" is eviction, "move Y to X" is paging something back in, X = now, Y =
wherever it actually lives).

**MemGPT**: two-tier - a small, fixed "core" context always loaded, plus
archival storage reached only through explicit function calls
(`archival_memory_search`, `core_memory_append`, etc.). No equivalent of a
"dump everything" call exists in this design at all. Movement between tiers
is a deliberate, LLM-directed action.

**MemoryBank**: continuous scoring (recency + relevance + importance) with
Ebbinghaus-curve decay - old, unused memories fade automatically. No hard
tier boundary; a bounded view has to be reconstructed on top (e.g. top-K by
score) rather than existing natively.

**Chosen: MemGPT's shape.** Two reasons, both concrete rather than
aesthetic:

1. It has a genuine hard bound by construction. MemoryBank's continuous
   decay still needs a cutoff bolted on to get the same effect - GPT gives
   it natively.
2. It's explicit, matching how the rest of Atlas already works
   (`add_observation` / `remove_observation` / `protect_observation` are
   all deliberate calls, nothing happens silently). Automatic time-decay
   would be a new kind of silent behavior, and a real risk given board rows
   can point at something that's gone quiet for weeks but still matters -
   decay could drop it with nobody deciding to.

## The shape that shipped

- `entities.core` flag. Bounded "now" tier = `core=1`.
- `get_landscape` defaults to `core=1` entities + due reminders.
  `all=true` is the explicit, deliberate full-dump escape hatch - the worst
  case, never the default path.
- `promote_entity` / `evict_entity` - explicit, symmetrical, mirror Dan's
  "move Y to X" / "move X to Y." Eviction never deletes; the entity stays
  fully reachable via `get_entity` / `search` (the archival-search
  equivalent Atlas already had - see Hybrid search / RAG, shipped
  2026-08-15).
- Nothing auto-promotes. A brand-new entity starts at `core=0`, same as
  everything else. The natural trigger going forward: promote what's
  related to whatever's actively being worked (e.g. tied to an open board
  row), evict when that closes - groom.js now flags stale core (5+ days
  untouched) as a report-only nudge toward calling `evict_entity`, it never
  evicts on its own.

Deploy specifics, gotchas hit, and live verification are in the README
("Core memory tier — SHIPPED" section) rather than duplicated here - this
file is the *why*, the README is the *what happened*.
