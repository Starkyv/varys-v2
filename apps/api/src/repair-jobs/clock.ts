/**
 * The clock the repair queue reads (Slice 19, slice 03).
 *
 * A Claim is a lease, so "has this claim lapsed?" is the queue's central question — and pinning
 * that behaviour to wall-clock timing would mean tests that sleep and still flake. Injecting the
 * clock instead lets an E2E move time forward by minutes in a millisecond and assert on the
 * OUTCOME (the job is back in the queue) rather than on how long it waited.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = "REPAIR_CLOCK";

/** Production's clock: the actual time. */
export const SYSTEM_CLOCK: Clock = { now: () => new Date() };
