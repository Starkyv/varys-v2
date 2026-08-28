# Slice 19 (heal-00 … heal-14) — manual test plan

Everything the self-healing feature promises, and how to see each of it with your own eyes.
Written to be worked through top to bottom: Part 0 gets the stack up, Part 1 runs what the
automated suites already prove, Part 2 walks every slice by hand, Part 3 is the cookbook the
manual steps refer to.

Shorthand used throughout: **drainer** = the process that claims repair jobs (a Claude Code
session on a Repair Agent credential, or `curl` — Part 3.1). **Brief** = a test's plain-language
statement of what it is for (`Brief` card on Test detail).

---

## Part 0 — Start everything

### 0.1 One-time

```bash
pnpm install
pnpm --filter @varys/runner exec playwright install chromium   # the worker's browser
```

Requires Node ≥ 22, pnpm 10, Docker running.

### 0.2 Start the stack

```bash
pnpm db:up      # Postgres on host port 5433, blocks until healthy
pnpm dev        # API :4000 + worker + web :5174 (one command, one terminal)
```

| Service | URL |
|---|---|
| Web app | http://localhost:5174 |
| API | http://localhost:4000 |
| Postgres | `postgres://varys:varys@localhost:5433/varys` |

Open http://localhost:5174 and sign in (first time: create an account with email + password).
The schema — including every heal column — is applied on API startup; there is no migrate step.

Stop with `Ctrl-C`; `pnpm db:down` stops Postgres.

### 0.3 Configure the AI judge — optional, and what changes without one

Since **heal-14** a judge is no longer a precondition for a repair. Configuring one turns the
slice-05 gate ON; leaving it unset means a reported repair stands on the agent's own account,
marked **not independently validated** in the review queue. What still needs a judge:

- **heal-11** the assertion judge fallback (an unpinnable check cannot be answered without one)
- `context` checkpoints
- **heal-05** itself — you can only test the gate's three refusals with a judge configured

**Configurations → AI judge (context comparison)**: provider `anthropic`, model
`claude-sonnet-5`, paste an API key → **Save**. (Env alternative: `VARYS_JUDGE_PROVIDER`,
`VARYS_JUDGE_MODEL`, `VARYS_JUDGE_API_KEY`.) Settings are read per call, so no restart.

Keep this in mind — you will deliberately *remove* the judge later to test the unjudged path
(§2.5, case C).

### 0.4 Provision a Repair Agent credential

**Configurations → Repair Agent credentials** → label e.g. `manual-drainer`, expiry 30 days →
**Create**. Copy the `varys_agent_…` token **now** — it is stored hashed and shown once.

### 0.5 Point Claude Code at Varys — twice, deliberately

Two *different* principals, because the whole security story of the feature is that they see
different tools:

```jsonc
// .mcp.json
{
  "mcpServers": {
    // YOU. Browser OAuth on the web origin. Authors tests, pins assertions.
    "varys":        { "type": "http", "url": "http://localhost:5174/mcp" },
    // THE DRAINER. A service credential. Claims jobs, repairs within them, nothing else.
    "varys-repair": { "type": "http", "url": "http://localhost:4000/mcp",
                      "headers": { "Authorization": "Bearer varys_agent_PASTE_YOURS" } }
  }
}
```

Or: `claude mcp add --transport http varys http://localhost:5174/mcp`. The first call on `varys`
opens a browser to sign in; `/mcp` in Claude Code re-authenticates.

If you would rather not run a second Claude, every drainer step below has a `curl` equivalent in
**Part 3.1** — the automated suites drive exactly those calls, so nothing is lost.

### 0.6 A target app you can break on purpose

The heal feature is about locators that stop resolving, so you need a page whose control you can
rename at will. Your own app works (rename a `data-testid`), but this scratch app reproduces the
exact three-way break the automated suites use, where the renamed control has **no signal left**
to match — which is what makes a run hard-fail instead of fuzzily healing.

```bash
mkdir -p /tmp/varys-target && cd /tmp/varys-target

# ── the ORIGINAL control (record against this) ─────────────────────────────
cat > save.html <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Target</title><style>
*{margin:0}body{background:#fff;font-family:Arial,sans-serif;padding:24px}
#hero{width:240px;height:120px;margin-bottom:24px;background:#3366cc;color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px}
button{width:140px;height:36px;font-size:16px;background:#2e7d32;color:#fff;border:0}
</style></head><body>
<div id="hero">Hero</div>
<section id="form-panel"><button id="save-btn" data-testid="save-btn" role="button" aria-label="Save changes">Save</button></section>
</body></html>
HTML

# ── RENAMED: same control, new id/name/panel/size (heal-04 happy path) ─────
sed -e 's/save-btn/commit-btn/g' -e 's/Save changes/Commit changes/' -e 's/>Save</>Commit</' \
    -e 's/form-panel/editor-panel/' -e 's/width:140px;height:36px/width:260px;height:72px/' \
    save.html > broken.html

# ── DELETED: the control is GONE and a DIFFERENT one sits there (heal-05) ──
sed -e 's/save-btn/refresh-btn/g' -e 's/Save changes/Refresh/' -e 's/>Save</>Refresh</' \
    -e 's/form-panel/toolbar-panel/' -e 's/width:140px;height:36px/width:220px;height:64px/' \
    save.html > deleted.html

# ── the invoice, for assertions (heal-09 … heal-12) ────────────────────────
cat > totals.html <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice</title><style>
*{margin:0}body{background:#fff;font-family:Arial,sans-serif;padding:24px}
table{border-collapse:collapse}td,th{padding:4px 12px;font-size:16px;text-align:left}#summary{margin-top:16px;font-size:18px}
</style></head><body>
<table id="invoice"><tbody>
<tr><td>Widgets</td><td class="amount" data-testid="row-amount">$10.00</td></tr>
<tr><td>Gaskets</td><td class="amount" data-testid="row-amount">$20.00</td></tr>
<tr><td>Flanges</td><td class="amount" data-testid="row-amount">$30.50</td></tr>
</tbody></table>
<div id="summary">Total <span id="total" data-testid="total">$60.50</span></div>
</body></html>
HTML

# arithmetic that does NOT hold — same markup (heal-10: never repairable)
sed 's/\$60\.50/\$70.50/' totals.html > totals-wrong.html
# arithmetic holds, but the element it is read FROM was renamed (heal-10: repairable)
sed -e 's/<span id="total" data-testid="total">/<strong id="invoice-total" data-testid="invoice-total">/' \
    -e 's|</span>|</strong>|' totals.html > totals-missing.html

cp save.html index.html
python3 -m http.server 4200 --bind 127.0.0.1   # http://127.0.0.1:4200/
```

**Switching what the page renders** — the equivalent of the suites' `setVariant`:

```bash
cd /tmp/varys-target && cp broken.html index.html         # break the locator
cd /tmp/varys-target && cp save.html   index.html         # put it back
cd /tmp/varys-target && cp deleted.html index.html        # the "different control" break
cd /tmp/varys-target && cp totals-wrong.html index.html   # a false assertion
```

### 0.7 The test you will break, twice over

Fastest route — ask Claude on the **`varys`** server:

> Using varys, author a test called **"save flow"** against `http://127.0.0.1:4200/`: click the
> Save button, then take a full-page checkpoint. Finish the session.

Then in the web app: **Review queue** → promote the draft. Or record it with the extension
(`pnpm --filter @varys/extension build`, load unpacked from `apps/extension/.output/chrome-mv3`).

Now, on **Tests → "save flow" → Test detail**, set the two things every heal slice depends on:

1. **Brief** — required; a repair with nothing to justify against is refused (§2.5 case A). Use:
   *"Saving the form must work: the primary save control on the form panel commits the changes."*
2. **Repair policy → Auto** — `manual` (the default) deliberately enqueues nothing.

Run it once green (**Run** → approve the first baseline under **Needs review**) so later runs have
a baseline to compare against.

Finally, duplicate the whole thing as **"save flow B"** (same page, same click, Brief + Auto) —
you need two tests on the *same* control for clustering (§2.7).

---

## Part 1 — Run the automated suites first

They prove most of the feature in ~10 minutes and tell you whether anything is broken before you
start clicking. Each API spec runs in its own process; run them one file at a time.

```bash
pnpm typecheck                       # whole monorepo

cd apps/api

# heal-09/10/11: the assertion engine, and which failure earns which job
npx vitest run ../../packages/assertion-engine   # pure vocabulary + evaluator
npx vitest run test/assertions.e2e.spec.ts       # pinned checks on replay
npx vitest run test/assertion-repair.e2e.spec.ts # extraction-failed repairable, relation-false never
npx vitest run test/assertion-judge.e2e.spec.ts  # judge fallback; unavailable judge is never a pass
npx vitest run test/assertion-authoring.e2e.spec.ts  # heal-12: pin/refuse/declare

# heal-01/02/03: policy, enqueue, credential, claim under lease
npx vitest run test/repair-queue.e2e.spec.ts
npx vitest run test/agent-credential.e2e.spec.ts
npx vitest run test/repair-claim.e2e.spec.ts

# heal-04/05/06/07/08: round trip, gate, healed, clustering, triage
npx vitest run test/repair-round-trip.e2e.spec.ts
npx vitest run test/repair-justification-gate.e2e.spec.ts
npx vitest run test/healed-outcome.e2e.spec.ts
npx vitest run test/repair-cluster.e2e.spec.ts
npx vitest run test/triage.e2e.spec.ts

# heal-13: the review surface's evidence
npx vitest run src/repair-jobs/repair-signal-diff.spec.ts   # the diff itself (fast, no containers)
npx vitest run test/repair-review-diff.e2e.spec.ts          # it arrives on the endpoint, screenshot serves

# heal-14: run_test / run_status, and the unjudged repair
npx vitest run test/run-test-tool.e2e.spec.ts
```

**Known**: `test/repair-edit.e2e.spec.ts` fails 2 of its assertions (an inserted step's captured
target has no `role`; a checkpoint rename aimed at a click step). Pre-existing, flagged on slice
04, unrelated to anything below.

**Live-judge check** (spends API tokens, needs `VARYS_JUDGE_API_KEY`): `test/repair-rubric.live.spec.ts`
exercises the real rubric on the real model — worth one run before trusting §2.5.

---

## Part 2 — By hand, slice by slice

Each case is *state → action → what you should see*. Where a step says "as the drainer", use the
`varys-repair` Claude session or Part 3.1's `curl`.

### 2.1 heal-01 — Repair Policy, the enqueue, and a visible queue

| # | Do | Expect |
|---|---|---|
| A | On a test with policy **Manual**, `cp broken.html index.html`, then **Run** | Run fails on the locator. **Repair queue** stays empty — `manual` promises pre-queue behaviour |
| B | Open the failed run → **Queue repair** | One job appears, status **Unclaimed**, broken locator shown as a cluster key |
| C | Set the other test to **Auto**, break it, run | A job appears with no human action |
| D | Look at the queue with nothing draining it | Notice reads *"N jobs are waiting for a repair agent to claim… Varys never starts an agent itself"* — unclaimed must read as a configuration fact, not as slowness |
| E | Hover the **Status** ⓘ in the queue header | Legend distinguishes Unclaimed / In progress / Repaired / Failed / Cancelled |
| F | **Tests** list → select several → **Repair policy** bulk control | Policy set on all of them in one action |
| G | Fail a test on something that is **not** a locator (see §2.8) and press **Queue repair** | Refused — a pixel regression or a crash is not repairable by re-pinning |
| H | Break the same locator again while the first job is still queued | Still **one** job (one app change is one job), its cluster gains the second run |

### 2.2 heal-02 — the Repair Agent credential (second issuer)

| # | Do | Expect |
|---|---|---|
| A | Create a credential | Token shown **once**, with an explicit "leaving this page loses it" |
| B | As the drainer, call `tools/list` | You see `claim_repair_job`, `release_repair_job`, `report_repair`, `report_triage`, the repair tools — and **not** `open_authoring_session`, `checkpoint`, `finish_session`, `pin_assertion`, `declare_unpinnable_assertion` |
| C | As **yourself** (`varys`), call `claim_repair_job` | "Unknown tool" — draining is a machine's job |
| D | As the drainer, try to author: `open_authoring_session` | Refused / unknown — a credential is not a licence to write new tests |
| E | **Revoke** the credential, then call anything | 401 from the very next request |
| F | Set expiry to 0 days / wait past expiry | Same 401 — an expired credential is indistinguishable from an unknown one |
| G | Try a made-up `varys_agent_xxx` token | Identical 401 (agent tokens must not be probeable) |

### 2.3 heal-03 — a claim is a lease

Constants that matter: lease **15 min**, attempt cap **3**.

| # | Do | Expect |
|---|---|---|
| A | `claim_repair_job` with an empty queue | `job: null` — the normal answer, not an error |
| B | Claim with one queued job | You get the job, its test, **its Brief**, the failing step, the run error, `claimExpiresAt`, `attemptsRemaining`, and `clusterTests` |
| C | Claim again from a **second** credential | `job: null` — first-claim-wins, and the holder's job is invisible to others |
| D | Queue view while claimed | **In progress**, claimer name, *"claim expires in Nm"* |
| E | `release_repair_job` | Back to **Unclaimed**, attempts 1 |
| F | Release twice more | Third release takes the job to **Failed** — the cap, not an infinite retry |
| G | Expire a claim by hand (Part 3.2) then reload the queue | Job is back to **Unclaimed**, attempts incremented — the sweep runs on read, so a dead drainer never shows as working |
| H | After a lapse, call `apply_fix` on the still-open session | Refused — losing the claim revokes the tools mid-session |
| I | `close_repair_session` after a lapse | **Allowed** — deliberately exempt, or a real browser would be left running with no way to stop it |

### 2.4 heal-04 — the round trip: an unreviewed version, and the run stays red

State: "save flow" on **Auto**, `broken.html` in place, one failed run, one queued job.

| # | Do | Expect |
|---|---|---|
| A | As the drainer: `claim_repair_job` → `open_repair_session {runId}` | A browser opens, replays the test's own steps, **parks** at the failing step; you get `recordedLocator`, the matcher's `diagnosis`, every node on the page, a screenshot |
| B | `try_locator {sessionId, testId: "commit-btn"}` | `resolved`, `deterministic`, `recommend: true` |
| C | `try_locator {sessionId, testId: "no-such-thing"}` | Not resolved, with advice — and **`apply_fix` with the same patch is refused**: a fix that does not resolve would replace one broken locator with another |
| D | `apply_fix {sessionId, testId: "commit-btn"}` | New version written (v2), `unreviewed`, attributed `Repair Agent "manual-drainer"` |
| E | Web app: **Tests → save flow → history** | v2 present, marked unreviewed. The failing run is **still failed** |
| F | `report_repair` with an empty `justification` | Refused, and the repair is **not** abandoned — you can argue and report again |
| G | `report_repair {jobId, summary, justification}` | Job → **Repaired**; response says plainly that the run is still red and a re-run has been queued |
| H | `report_repair` for a job with **no** version behind it | Refused — a job must never read `done` with nothing to show |
| I | As the drainer, touch a **different** test (`read_test {testId: <other>}`) | Refused — a claim reaches one test's cluster and no other |
| J | **Repair queue → Repaired versions awaiting review → Accept** | Version reviewed; the repaired definition is the active one |
| K | Repeat the whole flow, then **Reject** | Confirm dialog names what reverts; the test goes back to the previous definition **as a new version** (history keeps the rejected attempt), and the job ends terminally |
| L | Try to accept the same version twice (two tabs) | The loser gets a conflict, not a silent success |

### 2.5 heal-05 — the justification gate

Three refusals, and they are not the same refusal.

**Case A — no Brief.** Clear the Brief on a test, break it, drain it, `report_repair`.
Expect: repair **not applied**, test reverted to the previous definition, job **Failed**, message
names the remedy ("give the test a Brief").

**Case B — a plausible but wrong repair.** `cp deleted.html index.html` (the Save control is gone;
a *different* control, "Refresh", sits where it was). Drain it: `try_locator {testId: "refresh-btn"}`
**resolves** — that is the point — so `apply_fix` writes. Then `report_repair` with a justification
that claims Refresh satisfies the save clause.
Expect: the judge **rejects** it, the version is reverted, the job ends, and the message says the
repair was not applied. This is the case "it resolves" can never gate.

**Case C — no judge (changed by heal-14).** Blank the API key in **Configurations → AI judge**,
then report a repair.
Expect: it **succeeds**. No judge is asked, the version stands `unreviewed`, the job closes
`done`, and the review queue shows the reasoning line in warning tone: *"Not independently
validated — no AI judge was configured…"*. The human gate is untouched; only the machine one is
absent. Restore the key afterwards to test A, B and D.

**Case D — the happy path.** With `broken.html` and a good justification, the verdict is stored on
the version and shown in review as *"Judge: …"* beside the Brief.

### 2.6 heal-06 — `healed`, the re-run, and the digest

| # | Do | Expect |
|---|---|---|
| A | After a successful `report_repair` (with `broken.html` still served) | A **re-run** was queued automatically against the repaired definition — the response carries `rerunId` |
| B | Watch the re-run finish | Outcome reads **HEALED** (amber) on Run detail, Runs list, Test detail and the dashboard — not PASSED. It verified, but on a repair nobody has accepted |
| C | Review queue | The item shows the re-run link and *"everything verified"*; the header counts *"N versions · M healed"* |
| D | Accept the version, re-run again | Now an ordinary **PASSED** — `healed` is exactly "verified on an unaccepted repair" |
| E | Reject instead, then re-run | Red again (the test is broken until you fix it) — a reject is not a fix |
| F | Configurations → **Slack**: bot token + channel, notify on manual runs; re-run a healed repair | Message faced 🩹 **HEALED**, in the same weight class as needs-review — never ✅, never a page |
| G | Suite runs (put the test in a suite, run it) | Healed children counted as a **subset** of passed, not a sibling; the suite is not failed by them |

### 2.7 heal-07 — Failure Clusters and the circuit breaker

**Clustering** — needs "save flow" *and* "save flow B", both Auto, both clicking `save-btn`:

| # | Do | Expect |
|---|---|---|
| A | `cp broken.html index.html`, run **both** tests | **One** job, whose cluster names both tests. The queue row says *"+ 1 more test broken by the same change"* |
| B | Claim it | `clusterTests` lists both; the instruction is to repair the **anchor** only |
| C | `apply_fix` on the anchor, then `report_repair` | The fix is fanned out across the cluster as **one** reviewable change, each member with its own re-run |
| D | Review queue | **One** item, "2 tests, one change — save flow, save flow B", named *before* the buttons |
| E | **Accept** | Both tests accepted together — a cluster cannot be left half-agreeing with the new name |
| F | Redo and **Reject** | Both revert; the confirm dialog names every test first |

**The breaker** — the cheapest way to see it is to lower the threshold:

| # | Do | Expect |
|---|---|---|
| G | Configurations → **Repair circuit breaker** → threshold **1** → Save | Toast confirms the new threshold. Window is 60 minutes |
| H | Break the locator and run **both** tests | **No jobs created at all.** Repair queue shows a **Circuit breaker tripped** card first: how many tests broke, the threshold, and a reading — *one* cluster reads "looks like a single rename", *many* reads "the app broke or was redesigned" |
| I | Note the suppressed list | Every held-back failure named, with its cluster count |
| J | Press **Override** | Confirm dialog warns that an agent will otherwise rewrite tests to agree with whatever broke them; on confirm the suppressed failures are released into the queue as clustered jobs — nothing has to be re-run |
| K | Raise the threshold back to 10 | Card disappears once it has nothing to say (no permanent "all clear" banner) |
| L | While tripped, cause a **crash/timeout** failure (§2.8) | A **triage** job is still created — triage writes nothing, and during a mass failure an explanation is the most useful safe output |

### 2.8 heal-08 — Triage jobs (read-only diagnosis)

Five failure classes are diagnosed, never repaired: `pixel`, `judge`, `assertion`, `timeout`,
`crash`. How to provoke each on an **Auto** test:

- **pixel** — with an approved baseline, change something visible (`sed -i '' 's/#3366cc/#cc3333/' index.html`) and run.
- **judge** — a `context`-compare checkpoint with the judge API key blanked.
- **assertion** — `cp totals-wrong.html index.html` on a test with a pinned check (§2.9).
- **timeout** — point a step at a control that never appears (`cp deleted.html index.html` on a test whose step waits).
- **crash** — stop the target app (`Ctrl-C` the python server) and run.

| # | Do | Expect |
|---|---|---|
| A | After any of the above on an Auto test | A job of kind **triage** in the queue, one per (test, failure class) — a nightly suite failing the same pixel leaves one job, not thirty |
| B | Claim it | `kind: "triage"`, described as read-only |
| C | Under a triage claim, call `apply_fix` or `edit_test` | **Refused** — structurally, however sure the agent is |
| D | `report_repair` on a triage job | Refused, and it names `report_triage` instead |
| E | `report_triage {jobId, finding: ""}` | Refused — a triage job closed with nothing written is indistinguishable from one that explained nothing |
| F | `report_triage` with a real finding | Job **done**; the finding appears on **Run detail** as *"What a repair agent found"*, attributed and timestamped |
| G | Check the run's status/outcome before and after | **Unchanged.** A diagnosis must never be mistakable for a resolution |
| H | Set the test to **Manual** and re-provoke | No triage job — `manual` means no jobs about this test at all |

### 2.9 heal-09 — Assertions: a check on a relationship

Author a second test against `http://127.0.0.1:4200/` with `totals.html` in place. Ask Claude on
the **`varys`** server:

> Using varys, author a test "invoice totals" against http://127.0.0.1:4200/ — take a full-page
> checkpoint, and assert that the invoice total equals the sum of the line-item amounts.

| # | Do | Expect |
|---|---|---|
| A | Promote the draft, open **Test detail** | An **Assertions** card: the plain-language check, the pinned form (which elements, which coercion, which relation), and an **EXACT** badge |
| B | Run it | Green. Watch the API/worker log — **no model call** for the assertion; it is evaluated in the worker |
| C | Run detail | The assertion is listed with its verdict and the two values it read |
| D | `cp totals-wrong.html index.html`, run | Run **failed** (not needs-review): arithmetic that does not hold is not a matter of opinion, however the screenshots compare |
| E | Edit the check's wording on Test detail, save | New version; the assertion **id** is not editable — it is the identity the history hangs off |
| F | Delete an assertion, save | Struck through until saved, then gone from the next run |

### 2.10 heal-10 — extraction-failed is repairable; a false relation never is

The distinction the slice exists for, and the two files that isolate it (**same** total, so only
the *readability* differs):

| # | Do | Expect |
|---|---|---|
| A | `cp totals-missing.html index.html` (total renamed to `#invoice-total`), run the assertion test | Red, and the queue gains a **repair** job — the target no longer resolves, which is a broken locator like any other |
| B | Claim it | `failingAssertion` is set, `failingStep` is **null** (every step passed), `repairable: true`, and `side` names which target to fix |
| C | Re-pin with `edit_test {assertions:[{id, left|right:{…}}]}`, then `report_repair` | Unreviewed version, gated and reviewed exactly like a step repair |
| D | `cp totals-wrong.html index.html`, run | Red, and the queue gains a **triage** job — never a repair, under any policy |
| E | Claim that one | `repairable: false`, with the reason: both values were read and they **disagree** |
| F | Try to "fix" it by re-pinning anyway (`apply_fix`/`edit_test` under that claim) | Refused — re-pinning until the numbers agree is a machine for hiding the exact bug assertions exist to catch |

### 2.11 heal-11 — the judge fallback for an unpinnable check

| # | Do | Expect |
|---|---|---|
| A | Ask Claude: *"assert that the invoice looks reasonable and isn't showing an error state"* | Claude **declares it unpinnable** rather than forcing it into `contains` — and records a reason naming which part the vocabulary cannot express |
| B | Test detail | The check carries an **APPROXIMATE** badge and the reason, beside the exact ones. An author must never mistake a reading for arithmetic |
| C | Run it | A vision judge reads the page and answers in prose; the verdict shows on Run detail, marked approximate |
| D | Make the page genuinely wrong and run | The approximate check can still **fail** the run — it is not decorative |
| E | Blank the judge API key and run | The check is **unavailable**, and the run does **not** pass on it — a judge that cannot answer is never a pass (the run lands needs-review, not green) |

### 2.12 heal-12 — Claude pins an assertion, and says so when it cannot

| # | Do | Expect |
|---|---|---|
| A | Ask Claude to assert the total against the sum | It calls `find_elements` first (a total in a `<span>` is not in `observe`'s list at all), and the result reports each element's **text** — the way you catch a right-looking wrong node |
| B | Watch `pin_assertion` | The pin is **evaluated against the live page before it is stored** — "this pin works" is demonstrated, not assumed |
| C | Ask for a check on an element that does not exist | Pin **refused**, nothing stored, reason given — storing it would author a check that has never once evaluated |
| D | With `totals-wrong.html` served, ask Claude to pin total = sum | Pin is **stored as written** and reported **loudly**: both sides read, and they disagree. Claude should tell you it found a bug, not soften the check until the app agrees |
| E | Ask for something qualitative | `declare_unpinnable_assertion`, with an actionable reason (§2.11 A) |
| F | As the **drainer**, look for `pin_assertion` / `declare_unpinnable_assertion` | Absent. An agent that could declare a check could answer a red run by writing an assertion that passes |

### 2.12b heal-14 — the attended loop: ask your own Claude, and let it prove the fix

This is the path most people will actually use, and it has **no judge, no queue, no job**. Drive it
from the **`varys`** server (you, signed in), not `varys-repair`.

| # | Do | Expect |
|---|---|---|
| A | `cp broken.html index.html`, run the test so it goes red | Failed on the locator |
| B | Ask Claude: *"the test 'save flow' is failing — diagnose it, fix it, run it, and tell me what you changed"* | It opens a repair session, parks at the failing step, tries candidates, applies the one that resolves, then calls `run_test` itself and reports the outcome |
| C | Check the test's history | The new version is **`reviewed`** and live — a human asked for it, a human is present, so it is not queued for review |
| D | Ask it to run a test that has never run | Outcome `pending-baseline`, and Claude must say a human has to approve the capture — **not** that the test passes |
| E | Ask it to run a test whose page changed visually | `regression`, and Claude must not try to "fix" it by re-pinning |
| F | Pass `waitSeconds: 5` (or run a slow test) | `finished: false` plus a runId; Claude continues with `run_status` rather than reporting an outcome |
| G | As the **drainer** (`varys-repair`), look for `run_test` / `run_status` | Absent from `tools/list`, and "Unknown tool" if called — an agent that could trigger runs could retry until something went green |
| H | Watch the Runs list while B happens | The run appears there like any other, attributed to you — nothing about it is hidden |

### 2.13 heal-13 — the review surface (this session's slice)

State: at least one repaired version awaiting review (§2.4 G), ideally also a clustered one (§2.7 C).

| # | Do | Expect |
|---|---|---|
| A | **Repair queue → Repaired versions awaiting review** | Each item opens with **"What the repair changed"** — a signal table, expanded by default |
| B | Read the table | Three columns: signal, **Before · v1**, **After · v2**. Signals that moved are listed **first**, on a warm band, badged *changed*, before struck through in red and after in green. Signals that did not move follow, muted |
| C | Look for `Role`, `Element`, `Ancestors` on the `broken.html` repair | Unchanged — and that is the evidence it is the same control. This is why unchanged signals are shown at all |
| D | Repair a locator by dropping its `data-testid` (re-pin on role + name only) | The `data-testid` row reads **none** on the right, not a blank cell |
| E | Use `edit_test` to change a step's typed value or a checkpoint name during a repair | A red callout: *"This step also changed outside its locator signals"* |
| F | Same, adding or removing a step | A red callout naming both step counts |
| G | Below the diff | **Justified as …** (the agent's claim), **Judge: …** (the verdict), then **Brief: …** — a verdict is meaningless without what it was checked against |
| H | Below that | A thumbnail: *"The page this repair was made against"* — click it, it opens full size. This is the only evidence that is neither the agent's word nor the stored definition |
| I | Compare it with the diff | The screenshot should show the screen the re-pinned control actually lives on. On an `edit_test` repair it is the page the session was **parked** on — which is itself worth noticing |
| J | A **clustered** item | *"2 tests, one change — save flow, save flow B"*, above the buttons, not after them |
| K | **Accept** / **Reject** | One click each, from this view. Reject confirms first and names what reverts |
| L | Sidebar | **Repair queue** carries a count badge; collapse the sidebar and it becomes a dot |
| M | **Review queue** (the drafts page) | A banner: *"N repaired versions also awaiting review…"* → clicking it lands here. Check it appears **with zero drafts** too — that project is exactly the one whose repairs would sit unseen |
| N | Toggle **dark theme** | The changed/unchanged distinction, the struck-through before value and the red callouts all still read |
| O | Time yourself on one item, cold | Should be **seconds**. If it takes minutes, the gate will be bulk-accepted, which is the same as having no gate — that is the finding worth reporting |
| P | An item whose test got a later edit on top | Reads *"a later edit has landed on top"* — an accept is then not automatically "this is live" |

### 2.14 heal-00 — the wrong-fix spike

Not code: a HITL measurement of how often Claude's repair is *wrong but plausible*. Case B of
§2.5 is one instance of it. To do it properly, drain a batch of real failed runs and count how
many proposals a human would reject — that number is what decides whether amber `healed` is a
useful signal or noise nobody reviews.

---

## Part 3 — Cookbook

### 3.1 Driving the drainer with `curl`

Every call is the same shape (this is exactly what the E2E suites do):

```bash
AGENT="varys_agent_PASTE_YOURS"
call () { curl -s http://localhost:4000/mcp \
  -H "Authorization: Bearer $AGENT" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
  | python3 -m json.tool; }

# what this principal may see at all
curl -s http://localhost:4000/mcp -H "Authorization: Bearer $AGENT" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | python3 -c \
  'import json,sys; print([t["name"] for t in json.load(sys.stdin)["result"]["tools"]])'

call claim_repair_job '{}'
call open_repair_session '{"runId":"<RUN_ID>"}'
call observe            '{"sessionId":"<SID>"}'
call try_locator        '{"sessionId":"<SID>","testId":"commit-btn"}'
call apply_fix          '{"sessionId":"<SID>","testId":"commit-btn"}'
call read_test          '{"sessionId":"<SID>"}'
call report_repair      '{"jobId":"<JOB>","summary":"Re-pinned the click to the Commit button (data-testid=commit-btn).","justification":"The Brief requires that the primary save control on the form panel commits the changes — same control, relabelled from save-btn/\"Save changes\" to commit-btn."}'
call report_triage      '{"jobId":"<JOB>","finding":"The hero colour changed from blue to red; this is an app change, not test drift."}'
call release_repair_job '{"jobId":"<JOB>"}'
call close_repair_session '{"sessionId":"<SID>"}'
```

`try_locator` / `apply_fix` also take `selectorOverride`, `role`, `accessibleName`, `text` — set
one to a value, or to `""` to clear it. `edit_test` takes `steps` / `inserts` / `order` /
`defaults` / `assertions` / `name` / `notes`; call `read_test` first to see the indices.

Web-side reads, if you prefer them over the UI (needs your browser cookie — easiest from the
browser devtools console on http://localhost:5174):

```js
await (await fetch('/repair-jobs')).json()              // the queue
await (await fetch('/repair-jobs?all=1')).json()        // including finished
await (await fetch('/repair-jobs/reviews')).json()      // review items: diff, screenshot, cluster
await (await fetch('/repair-jobs/breaker')).json()      // breaker state
```

### 3.2 Postgres cookbook

```bash
psql postgres://varys:varys@localhost:5433/varys
```

```sql
-- Expire a claim NOW, so the lease sweep can be tested without waiting 15 minutes
UPDATE repair_jobs SET claim_expires_at = now() - interval '1 minute' WHERE status = 'claimed';

-- The queue, plainly
SELECT id, kind, status, cluster_key, attempts, claimed_by, claim_expires_at FROM repair_jobs ORDER BY created_at DESC;

-- Cluster membership (what one job covers)
SELECT j.id, t.name FROM repair_job_tests m JOIN repair_jobs j ON j.id = m.job_id JOIN tests t ON t.id = m.test_id;

-- Versions and their review state, with heal-13's screenshot key
SELECT version, review_state, created_by, repair_job_id, repair_screenshot_key IS NOT NULL AS has_shot,
       justification IS NOT NULL AS has_justification
  FROM test_versions WHERE test_id = '<TEST_ID>' ORDER BY version;

-- What the breaker held back
SELECT test_id, cluster_key, threshold, failing_tests, released_at FROM suppressed_failures ORDER BY created_at DESC;

-- Triage findings written onto runs
SELECT id, status, failure_kind, triage_by, triage_at, left(triage_finding, 80) FROM runs WHERE triage_finding IS NOT NULL;
```

Repair page captures live under `$VARYS_STORAGE_DIR/repairs/<versionId>.png` (default
`.varys-artifacts/`), served as `/artifacts/<base64url-of-key>`.

### 3.3 Where each thing lives in the UI

| What | Where |
|---|---|
| Repair policy (per test) | Test detail → **Repair policy** |
| Repair policy (bulk) | **Tests** → select → **Repair policy** |
| Brief | Test detail → **Brief** |
| Assertions (read/edit wording, EXACT vs APPROXIMATE) | Test detail → **Assertions** |
| Queue, breaker card, review items | **Repair queue** |
| Manual enqueue, triage finding, assertion verdicts | **Run detail** |
| `healed` outcome | Run detail, Runs list, Test detail, Dashboard, Suite runs |
| Judge, Slack, breaker threshold, agent credentials | **Configurations** |
| Repaired-versions pointer | **Review queue** (drafts) banner + sidebar badge |

---

## Part 4 — Things worth reporting back

- Anything in §2.13 O (how long a review actually takes) — the whole gate rests on it.
- Any place a refusal reads as a malfunction rather than a decision (§2.5 A–C are the risky ones).
- Any wording that made you trust a repair you should have questioned, or question one you
  shouldn't have.
