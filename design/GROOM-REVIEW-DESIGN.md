# Atlas — Groom Review & Level System (Design, not yet built)

Status: **Design phase. Not built. Not approved for code.** Captured 2026-08-09
after a long talk-only design session with Dan. Read ATLAS-MISSION.md first —
this design exists to serve that mission, specifically the growth/decay
tension noted there.

---

## The problem this solves

Dan chats and researches a lot. Atlas captures a lot. Most captured material
is never revisited, and there's currently no system that shrinks or retires
anything automatically. Two existing tools already touch this:

- **Groom worker** (deployed 2026-07-10, mechanical only): nightly, finds
  near-dupes (Jaccard >=0.85), dormant entities (60+ days), stale dismissed
  reminders (90+ days). Report-only — writes findings to a "Groom Report"
  entity, does not act.
- **protected flag**: marks an observation as physically undeletable by
  groom or remove_observation. Currently binary (protected / not).

Neither of these actually reduces volume. Dan's stated goal: something that
surfaces candidates for action on a real cadence, lets him decide fast
(checkbox, not essay), and genuinely trends the database toward smaller over
time — without losing the ability to say "we talked about this once" years
later.

---

## The five levels

Every entity/observation sits at one of five levels:

| Level | Name | Meaning |
|---|---|---|
| 1 | VIP / Protect | Handle with care. Above all other ideas. Can still be edited/grown, but never auto-touched or casually altered — any change here is deliberate. |
| 2 | General | Normal, active. Default level for new material that isn't spitfire/research-only. |
| 3 | Summary / Compress | Condensed version of the idea. Same conceptual action as "Combine." |
| 4 | Gravestone | Bare-minimum, one-line trace. Off the clock — does not resurface on a timer. Permanent unless a new related topic touches it. |
| 5 | Delete | Gone. No trace. The only truly permanent exit alongside Gravestone. |

**Movement rules:**
- Levels 1-3 are freely movable in either direction (promote back up, demote
  down) as importance/relevance changes over time.
- 3 -> 4 is a one-way step onto the shelf.
- 4 -> back is only via **Combine** (see below) — a new/related topic pulls a
  gravestone back into active consideration. Re-entry level (2 or 3) is
  judged at that time, not fixed in advance.
- Anything can go straight to 5 (Delete) from any level, at any time.
- Level 1 is *not* exempt from review — it cycles like 2 and 3. What differs
  at level 1 is the amount of care required and what groom is allowed to
  *propose* about it (see Groom section).

**Protect is not a separate mechanism.** It's the low end of a care/priority
scale, not a lock. "My meds are X" protected doesn't mean the fact can never
change — meds change. It means edits to it require deliberate attention, not
a casual groom-driven reword. Protect shields the *heart* of the idea from
careless erosion, not from ever being touched at all. Moving something in
and out of level 1 should be cheap and expected as life/priorities change.

**Compress and Combine are the same action**, conceptually. Whether the
trigger is "this got long, shrink it" or "these two things are the same
idea, merge them," the output is a single condensed entity.

---

## The review cycle

- **Levels 1-3 resurface every 6 months** on a review page. Nothing at these
  levels is exempt from review, including level 1.
- **Level 4 (Gravestone) is off the clock entirely.** No timer-based
  resurfacing. It only comes back via Combine (see below).
- **Level 5 (Delete) has no cycle** — it's already gone.
- On review, Dan sees each item with a proposed action (from groom, if
  groom flagged it; otherwise a neutral default) in an editable dropdown.
  He can accept the proposed action or change it to any other valid action.
- **Submitting an action executes it immediately** — no "approved" limbo
  state, no second pass. The one exception: outcomes other than Delete leave
  the item sitting at its new level, which will resurface again at that
  level's next cycle (6mo for 1-3; never for 4 unless Combine-triggered).
- **Dismiss** = no action taken, item stays at current level, 6mo snooze,
  re-asked next cycle. Only meaningful pre-gravestone (1-3).
- Nothing is ever silently dropped from the queue except by reaching level 5
  (Delete) or level 4 (Gravestone, which exits the clock but is retained).

---

## Groom's role (mechanical + detection, still no unsupervised writes)

- Groom already runs nightly, mechanical only, report-only. That doesn't
  change in terms of write access — groom never executes an action itself.
- **Detection scope: groom scans and cross-references ALL five levels,
  including 1 (protected) and 4 (gravestones).** No level is invisible to
  detection. This is the fix for the "protected meds should still be
  recognized as related to general Advil note" problem, and it's also how
  gravestones get found for Combine candidates without relying on Dan or
  Claude noticing by accident mid-conversation.
- **Proposal scope is restricted by level:**
  - For level 2/3 items, groom can propose the full range: Compress,
    Combine, Gravestone, Delete.
  - For level 1 items, groom can only ever propose "these look related,
    review together" — it can flag a relationship but can never itself
    propose collapsing, compressing, or downgrading a level-1 item. Dan
    decides what (if anything) happens to the VIP side of a flagged
    relationship.
  - For level 4 (gravestone) items, groom can propose Combine when a new or
    existing item appears related — this is the mechanism that brings a
    gravestone back, rather than requiring Dan or Claude to notice the
    connection by chance in conversation.
- Phase 3 (planned in ATLAS.md, not built) — using Claude via the Message
  Batches API for dedupe confirmation (Haiku) and cross-topic prospecting
  (Sonnet) — is the natural mechanism for generating good compress/combine
  proposals rather than groom just flagging raw similarity. Est. cost at
  current data size: under $0.25/night per ATLAS.md.

---

## The review page

- **New, standalone page** — separate from the existing Board (port 7795).
  Board is not touched or modified by this work.
- Same general pattern as the Board: LAN-only, no external auth, read/act
  view backed by the guarded Atlas tools server-side.
- **Three tabs on one page/URL: Personal, Shared, Work.** Each tab fetches
  via its own section-scoped token, server-side — this does not merge data
  across sections, it's one UI showing three separately-scoped views side
  by side, respecting the same section isolation Atlas enforces everywhere
  else.
- Each tab lists items due for review this cycle (levels 1-3 whose 6mo
  clock is up) plus any groom-flagged Combine candidates (including
  gravestone matches).
- Each row: checkbox + editable action dropdown (Compress/Combine,
  Gravestone, Delete, Dismiss, Protect, Unprotect), pre-populated with
  groom's proposed action where one exists.
- Dan can change the action before submitting.
- Submit executes the final chosen action immediately per-row; unchecked
  rows are left alone and simply reappear next cycle.

---

## Open / deferred question

**"Spitfire" mode** — Dan researches and discusses a lot with no intent to
commit it to Atlas at all. Proposed handling (lighter-weight, not fully
settled): a spoken/typed mode marker (e.g. "/discuss") at the start of a
tangent means nothing gets written to Atlas by default; if something from
that conversation turns out to matter, Dan says so explicitly ("drop this in
Atlas") and it's captured at that point. No slash-command infrastructure or
keyword detection needed — this is a conversational convention, not a code
feature, and doesn't require Atlas changes. Flagged here for completeness
since it came up in the same design session and shapes how much material
enters the level system in the first place.

---

## What this design does NOT change

- Board (port 7795) — untouched.
- Groom's existing mechanical checks — untouched, still nightly, still
  report-only in terms of execution.
- Section isolation / token scoping — untouched, this design operates
  entirely inside existing scoping rules.
- protected flag semantics at the database level — the *meaning* Dan
  assigns to it (care level, not lock) is a usage convention layered on top;
  no schema change implied by that alone. Actual level 1-5 as a first-class
  field would be a schema addition (see Build Spec, not yet written).

---

## Not yet decided / not in scope of this doc

- Exact schema for a `level` field (or reuse of `protected` boolean +
  something else) — needs a real build spec.
- Exact schema/table for tracking 6mo due-dates per item and groom
  proposals awaiting review.
- Whether re-entry from Gravestone via Combine can land directly at level 1,
  or must land at 2/3 first.
- Full Phase 3 (Batches API judgment layer) implementation details.

This document is a full-detail capture of the design conversation for Dan to
review before deciding whether/how to turn it into an actual build spec.
No code has been written. Per standing rule, nothing gets built without
Dan's explicit go-ahead.
