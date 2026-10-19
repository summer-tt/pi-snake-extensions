# pi-herdr-enhanced — plan

A standalone pi extension that adds **two** tools on top of the `herdr` CLI:

| Tool | Question it answers |
|---|---|
| `job` | "run this bounded task somewhere and let me clean it up later" |
| `job_watch` | "is any Job I opened still working, and wake me when one stops" |

It is a distillation of `dev-pipeline`'s `pi-foreman` extension
(`~/workspace/pi-stuff/dev-pipeline/src/foreman`, ~12k lines) keeping only the Job
lifecycle and the Job watch. Everything else Foreman carries — Forge records,
GitHub/GitLab access, policy, quota, quality gates, model measurement, task
profiles, store schema, recovery — is out of scope.

It does **not** wrap `@ogulcancelik/pi-herdr`. Pi exposes no cross-extension tool
executor (`getAllTools()` returns metadata only), and `pi-herdr` has no worktree
operations at all. `pi-herdr` stays installed and untouched for general pane work;
this extension drives the `herdr` CLI itself, exactly as Foreman does.

---

## 1. Why a Job layer at all (what Foreman has that `pi-herdr` does not)

| | `pi-herdr` | this extension |
|---|---|---|
| Primitive | layout / pane / agent — terminal locations | Job / watch — one bounded attempt, the open set |
| Granularity | one agent, one blocking `wait` | N Jobs, one coalesced wake stream |
| State | none; the LLM's context is the state | durable run scope: open set, ownership, deliveries |
| Worktrees | none | branch worktree provisioning (opt-in) |
| Failure | raw agent state | typed lifecycle with refusal, resume, retention |
| Delegation | opt-in by policy (user must mention Herdr) | the point of the tool |

The four mechanisms worth porting, in order of value:

1. **The watch** — the Orchestrator goes idle (0 tokens) and is woken the moment
   any open Job stops working. Blocking waits per working Job + a 60 s poll
   safety net, a debounce window so Jobs that stop together are announced once,
   an opaque per-cause Wake identity acknowledged only by the run that consumes
   it, and a retry ladder for unhandled Wakes.
2. **Job lifecycle as one call** — window + label + Pi process + task prompt in
   one call, with resume instead of duplication and a window that survives a
   failed launch as an addressable Job.
3. **Completion claim** — a Worker declares its bounded work concluded through a
   capability delivered at spawn time (never prompt text), travelling as one
   file in a spool. It requests reconciliation and wakes nobody; the Wake follows
   settlement.
4. **Ownership + retention** — who owns this window, at which generation, and
   how many finished windows may stay open.

## 2. Non-goals

- No Forge/GitHub/GitLab anything. There is no "durable record" to reconcile
  against; `job status` reports Herdr's observation and the recorded Job facts.
- No measurement, quota, quality gate, model scoring, or recovery framework.
- No standalone daemon. The watch lives in the Orchestrator process. A killed
  Orchestrator is discovered by the next `job status`, not by a supervisor.
- No `attach` action, no `pane` placement, no integration-worktree `prepare`.
- No automatic `--trust-repository`.

## 3. Decisions taken (with the evidence behind them)

### 3.1 Worktree is a parameter, off by default

`job open` takes `worktree?: boolean`, default **`false`**. That default is not
configurable.

### 3.2 The configuration can only *lock* worktree mode

```jsonc
{ "worktree": { "enabled": false } }
```

`enabled: false` at either level (global or project) **refuses** any
`worktree: true` call — it is a lock, not a default. Omitted or `true` means the
caller may still opt in. Resolution is `project ?? global`; a `false` at either
level locks. A locked call is refused with a clear error and **zero side
effects**; it is never silently downgraded to a tab, because the caller would
then believe it holds an isolated branch while writing into a shared directory.

### 3.3 Non-worktree placement is a new tab

`herdr tab create --workspace <W> --cwd <P> --label <L> --no-focus`, where `W` is
`HERDR_WORKSPACE_ID`. It returns `.result.tab` and `.result.root_pane`; the Job's
pane is that root pane. No pane splitting, no new workspace.

### 3.4 Worktree mode is Foreman's behaviour, unchanged

`herdr worktree create --cwd <repo> --branch <B> --base <R> [--path <P>] --label <L> --no-focus`
→ a workspace row with Git provenance, grouped with its repository.
Cleanup goes through `git worktree remove` (Herdr's `worktree remove` accepts only
`--workspace`; verified: `--cwd` is `unknown option`), then the checkout's rows
are closed.

### 3.5 Worktree root — `auto` means "let Herdr decide"

`herdr worktree create` without `--path` creates the checkout under
`<worktrees.directory>/<repo>/<branch-slug>`, where `worktrees.directory` is
Herdr's own config key defaulting to `~/.herdr/worktrees`. Verified:

```
$ herdr worktree create --cwd /tmp/wt-probe4/repo --branch my-feature --label NOPATH
cwd: /Users/snake/.herdr/worktrees/repo/my-feature
```

So `root: "auto"` (the default) omits `--path` entirely and invents no convention.
An explicit root is expanded to an absolute `<root>/<job>` and passed as `--path`.
`--path` does accept a relative value, resolved against `--cwd` (verified), but
absolute is what we send.

Classic roots, documented in the config template:

| Value | Result | Notes |
|---|---|---|
| `auto` | `~/.herdr/worktrees/<repo>/<branch-slug>` | outside the checkout, no `.gitignore`, one place to clean |
| `.worktrees` | `<repo>/.worktrees/<job>` | travels with the repo; **must** add `.worktrees/` to `.gitignore` |
| `../<repo>.worktrees` | sibling of the repo | outside, nearby, no `.gitignore` |
| `~/workspace/worktrees` | `<root>/<repo>/<job>` | one root for every repo |

### 3.6 Three worktree facts the implementation must honour

1. `--cwd` must be the **primary** checkout. From inside a linked worktree Herdr
   refuses: `{"error":{"code":"linked_worktree_source","message":"New and open
   worktree actions start from the repo parent workspace."}}`. Resolve the repo
   root with `herdr worktree list --cwd <path>` → `result.source.repo_root`.
2. `worktree create` also opens a row for the **parent repository** (verified:
   the job row closes, the parent row labeled with the repo directory name
   remains). Cleanup matches rows by Git provenance (`checkout_path`), never by
   "a pane happens to stand there".
3. `workspace close` returns `{"type":"ok"}` but the workspace is still listed a
   moment later (verified). Verification after close must tolerate that.

### 3.7 `--trust-repository` is a human decision, never ambient

Per Herdr's CLI reference: `worktree remove` "runs `git worktree remove` … Git
rejects repositories owned by another user by default. If you have independently
verified the repository, pass `--trust-repository` to trust its resolved path for
that command only. Herdr does not change your Git configuration."

It bypasses **Git's** `safe.directory` protection, not a Herdr check. Therefore:

- it is **never** read from configuration;
- `job open` accepts `trustRepository?: boolean`, default `false`, passing it for
  that one call only;
- the default path detects that specific Git refusal and puts the decision in the
  error message instead of taking it.

`force?: boolean` for a dirty-checkout refusal follows the same rule.

### 3.8 Resume, never duplicate

Re-opening an existing Job name returns to its existing window: a live pane is
reused (with a bounded continue if it already holds the prompt), a pane that is
alive without a session is restarted in place, a pane confirmed gone earns
exactly one replacement. In tab mode there is no Herdr-level occupancy guard, so
this invariant is held by the recorded Job facts plus the tab label
(`<ticket> <name>`).

### 3.9 Ownership + generation

A session does not own one run scope but a **family** of them. The family root is
the session id (or `PI_HERDR_ENHANCED_SCOPE`), and each incarnation is
`<root>#0`, `<root>#1`, … A forked or cloned session is a different family by
construction; two processes resuming the same file share one.

Each Job window carries an ownership record
`(project, scope, generation, orchestrator, pid, host, startTime, nonce)`, and
each incarnation has its own append-only JSONL ledger:

```jsonl
{"scope":"s1#0","generation":1,"orchestrator":"s1","pid":41,"startTime":"...","at":"..."}
{"scope":"s1#0","generation":2,"orchestrator":"s1","pid":97,"supersedes":1,"at":"..."}
```

`generation` is "which incarnation owns this scope" — a fencing token, not a
counter of attempts. `orchestrator` is the family root, so every incarnation of
one session is recognizably the same family, and pid/startTime/nonce tell
concurrent incarnations apart — which a recycled PID cannot.

`claimFamily` decides a session's place, in order: the scope the session held
last (read back from its own branch via `getBranch()`), else the lowest
incarnation whose owner is provably gone, else the next number. **A dispatch is
never refused because another incarnation is running** — a family always has room
for one more number. Every incarnation whose process is gone is then absorbed, so
the highest surviving incarnation holds the whole dead history. The spool is keyed
by the family root (`spool/<root>/`), so all incarnations' Completion claims
arrive in one directory.

Explicit `takeover: true` bypasses derivation and requires `expectedOwner` +
`expectedGeneration` matching one scope's latest claim, appending
`generation + 1` with `supersedes` pointing at it. Anything else refuses: missing
record, recycled PID, stale or malformed fields, ambiguous history.

Disposing of a window checks the scope it was opened under against the scopes the
session holds. A window opened by a **live** sibling is visible to
`job status wider` and refused for `close`/`retain`/`steer`/`reclaim`; one opened
by a dead sibling becomes disposable as soon as its scope is absorbed.

### 3.10 Completion claim and the observe-only watch

A Worker calls `job complete`. That writes one owner-only, atomically renamed file
`spool/<scope>/claim-<token>.json` and wakes nobody — the Worker is still
mid-turn writing its summary, and waking there is exactly the false Wake this
design removes. The Wake follows once the Job is observed settled, and reports
`declared complete` rather than `no completion claim` so a silent settle is never
mistaken for a declared one.

The watch **classifies, it never concludes**: `idle`/`done`/`blocked`/`unknown`/
`dead` are UI visibility states. A Job that finished in under a second is
indistinguishable from one that never launched, so `job read` decides the result.

### 3.11 Wake delivery, identity, acknowledgement, retry

- A Wake is a custom message (`customType: "pi-herdr-enhanced-job-watch"`,
  `details` carrying one identity per coalesced cause) sent with
  `{ triggerTurn: true, deliverAs: "followUp" }`.
- While a run is live the Wake is *held*, not injected: Pi drains its follow-up
  queue at turn/drain boundaries, so injecting earlier loses nothing and delivers
  older news. It flushes at `endTurn({modelFinished})` / `endRun`.
- The watch records a Wake as consumed only from `message_start` matching the
  identity, and acknowledges only at `agent_settled` when the run's final outcome
  was normal.
- Unhandled Wakes are retried with the same identity — never a replayed prompt —
  after 1, 5, 10 minutes and then at most once every 30 minutes. An ambiguous
  `aborted` is never retried. Timers are `unref`'d and cancelled when no open Job
  or pending Wake remains.
- Non-urgent Wakes are held for a 1.5 s debounce window and coalesced; a
  completion claim bypasses the debounce and does not wait for siblings.
- `hold` suppresses ordinary Wake decisions for a Job while keeping dead-pane and
  deadline checks; `release` ends the hold.
- A 60 s poll remains as the safety net for what a blocking wait cannot see: a
  vanished pane, a held Job's deadline, a pane Herdr cannot classify.

### 3.12 Retention

A finished Job is normally **retained**, not closed: the window stays open to
read while it leaves the Wake decision entirely, bounded by
`retention.max_finished_windows` (default 2). Retaining beyond the cap closes the
oldest Retained window first, and `job open` enforces the same cap over finished
siblings. The watch retains a finished Job itself once its Wake news has been
delivered; `job status` marks it `retained for inspection (automatic)` and a hand
`job retain` supersedes that marker. A retained window whose pane starts working
again returns to the watch.

### 3.13 A Worker never tears down a Job

Inside a dispatched Worker session (one carrying a Job capability), `close` and
`retain` are refused. Closing the workspace a Worker runs in destroys its own
pane and strands the watch. A Worker concludes with `job complete`.

## 4. Architecture

```
pi-herdr-enhanced/
  index.ts            extension entry: tools, events, capability injection
  PLAN.md
  README.md
  package.json
  tsconfig.json
  src/
    config.ts         global + project config; worktree lock; retention cap
    herdr.ts          the herdr CLI as one testable seam; typed errors
    capability.ts     spawn flag <-> JSON capability; worker vs orchestrator
    spool.ts          owner-only claim + progress files
    ownership.ts      owner records, generation ledger, takeover authorization
    registry.ts       durable run-scope state (Jobs, deliveries, retention)
    job.ts            open/resume/close/retain/reclaim/status/read/steer
    watch.ts          Watch: waits, poll, classification, debounce, retry
    wake.ts           Wake identity, message text, correlation
    ids.ts            tiny helpers (slugs, tokens, clocks)
  tests/              node --test
```

Dependency direction is one-way and testable: `herdr.ts` takes an injected
`RunCommand` and holds no Pi import; `job.ts` / `watch.ts` hold no Pi import and
take injected clock/fs seams; only `index.ts` touches Pi.

## 5. Tool contracts

### `job`

Actions: `open`, `complete`, `close`, `retain`, `reclaim`, `status`, `read`, `steer`.

| action | required | optional |
|---|---|---|
| `open` | `name`, `ticket`, and exactly one of `prompt`/`file` | `model`, `thinking`, `cwd`, `worktree`, `repo`, `branch`, `base`, `path`, `stallThresholdMs`, `scope`, `generation`, `takeover`, `expectedOwner`, `expectedGeneration`, `trustRepository`, `force` |
| `complete` | — (Worker only) | — |
| `close` | `workspace` or `name` | `reason`, takeover fields |
| `retain` | `panes` | `keep` |
| `reclaim` | `repo` + `path` | `force`, `trustRepository` |
| `status` | — | `scope`, `wider` |
| `read` | `target` | `lines` |
| `steer` | `target`, `message` | takeover fields |

Validation happens before any side effect: a locked `worktree: true`, both or
neither task sources, a bad `stallThresholdMs`, an unknown placement — all fail
with nothing created.

### `job_watch`

Actions: `status`, `wake`, `dismiss`, `hold`, `release`. `status` takes
`scope`/`wider`; the rest take `panes`.

## 6. Configuration

Global `~/.pi/agent/pi-herdr-enhanced.json`; project
`<project>/.agents/pi-herdr-enhanced/config.json` (project wins per key).

```jsonc
{
  // Where a non-worktree Job lives. Only "tab" is implemented.
  "placement": "tab",

  "worktree": {
    // Lock. false ⇒ refuse any worktree: true. Omitted/true ⇒ opt-in allowed.
    "enabled": true,
    // "auto" (Herdr's worktrees.directory) | ".worktrees" | "../<repo>.worktrees" | "~/workspace/worktrees"
    "root": "auto"
  },

  // How many finished windows may stay open for inspection.
  "retention": { "max_finished_windows": 2 },

  // Watch tuning; defaults shown.
  "watch": {
    "tick_ms": 60000,
    "debounce_ms": 1500,
    "stall_threshold_ms": 1200000
  }
}
```

State, all under `~/.pi/agent/state/pi-herdr-enhanced/` by default
(`PI_HERDR_ENHANCED_STATE` overrides):

```
owners/<pane>.json           one ownership record per Job window
scopes/<scope>.jsonl         append-only generation claim ledger
spool/<scope>/claim-*.json   Completion claims
spool/<scope>/progress-*.json content-free activity observations
```

The spool directory is created owner-only (0700), verified before every read and
write, written through a temp name and renamed into place, and swept on a TTL.

## 7. Build order

1. `PLAN.md`, `package.json`, `tsconfig.json`, `README.md`.
2. `ids.ts`, `herdr.ts`, `config.ts` — the transport and its seams.
3. `spool.ts`, `capability.ts`, `ownership.ts` — the cross-process channels.
4. `registry.ts` — durable run-scope state.
5. `job.ts` — the lifecycle.
6. `wake.ts`, `watch.ts` — the watch.
7. `index.ts` — Pi wiring: two tools, the spawn flag, wake injection, events.
8. `tests/` — one test per non-obvious rule, especially the refusals.

## 8. Test plan

Unit, against injected seams (no Herdr, no Pi needed):

- config: lock precedence, root expansion, `auto` omits `--path`.
- herdr: error envelope read from **stderr** with exit 1; `pane_not_found` →
  dead; `workspace_not_found` → idempotent close; `linked_worktree_source`
  surfaces the repo-root requirement.
- capability: spawn-flag round trip; a session without a capability is an
  Orchestrator.
- spool: 0700 enforcement; temp-name rename; TTL sweep; a foreign token updates
  nothing.
- ownership: generation monotonic; takeover requires the exact expected owner and
  generation; recycled PID stays `ownership-unknown`; incomplete ledger fails
  closed.
- registry: retention cap closes the oldest Retained window; a revived pane
  leaves retention.
- job: both task sources refused before any side effect; locked worktree refused
  with nothing created; resume reuses a live pane; a dead pane earns exactly one
  replacement; Worker close/retain refused.
- watch: debounce coalesces two settlements into one Wake; a claim bypasses the
  debounce; identity acknowledgement requires the final normal outcome; retry
  ladder with `unref`'d timers; hold suppresses ordinary decisions but not
  dead-pane.

### e2e, against the real thing

`tests/e2e/` runs the shipped entry point against a real `herdr`, a real `git` and
a real Pi Worker, supplying only Pi's side of the API (`exec`, `appendEntry`,
`sendMessage`, `process.argv`). It is the suite that found the tab-mode workspace
bugs, the Worker scope claim, the ignored `wider` flag and the read on a working
pane; each of those is now covered by a unit test as well, so the e2e is evidence
about the *integration* rather than the only guard.

- refusals: 21 cases that must create nothing, including a Worker that claims no
  scope and cannot dispatch.
- lifecycle: one real Worker dispatched, declaring, waking, read, steered,
  re-opened, and replaced after its window is gone.
- watch: retention, cap eviction, hold/release, dismissal, a sibling surviving its
  neighbour's close, wider inspection.
- worktree: a real Git worktree, its own workspace, a close that ends the
  workspace, a reclaim that spares the branch.

## 9. Open items deferred past v1

- `placement: "pane"` (pane splitting) — explicitly dropped.
- `attach` as a distinct action — subsumed by `worktree: false` plus `cwd`.
- Progress observations are recorded and surfaced as `progress-unobservable`
  only; suspected-stall Wakes are not implemented in v1.
- A durable cross-process Job registry beyond the session's own entries: two
  Orchestrator processes sharing one scope reconcile through `job status wider`
  and taken-over ownership records, not through a shared database.
