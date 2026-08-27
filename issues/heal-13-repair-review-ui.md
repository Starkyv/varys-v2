# Slice 13 — Repair review: what changed, and why Claude thought it was right

**Type:** AFK · **Label:** `ready-for-agent` · **Blocked by:** 04

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

The surface that decides whether self-healing is trusted or ignored. Slice 04 gave a minimal
accept/reject; this makes the decision fast enough that the queue does not rot.

Side by side: the old locator and the new one, with the signals that changed highlighted — role,
accessible name, text, ancestors, neighbours. Beside it, the `Brief` and Claude's justification
against it, so a reviewer can judge whether the re-pinned element is genuinely the same thing
without navigating away.

The design's whole review gate rests on this being a seconds-long decision. If it takes minutes,
authors will bulk-accept, and bulk-accepting is functionally identical to having no gate at all.

Clustered repairs (slice 07) must show their **blast radius**: a reviewer accepting a fix across
thirty-eight tests needs to see that number before clicking, not after.

## Acceptance criteria

- [ ] The review surface shows the previous and repaired locator side by side
- [ ] Signals that changed are visually distinguished from signals that did not
- [ ] The brief and Claude's justification are shown together with the diff
- [ ] Accept and reject are one click each, from the same view
- [ ] Rejecting reverts the test to its previous version
- [ ] A clustered repair shows how many tests it will affect before it is accepted
- [ ] The count of versions awaiting review is visible from the review queue and links here
- [ ] A screenshot of the page the repair was made against is available for context
- [ ] Verified by hand — UI tests are out of scope per house practice

## Blocked by

- Slice 04 (there must be unreviewed versions to review)
