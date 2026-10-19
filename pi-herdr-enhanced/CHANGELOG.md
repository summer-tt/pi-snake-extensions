# Changelog

## Unreleased

### A compaction no longer strands the windows of the incarnation it replaced

- A claim left by an earlier incarnation of the **same live process** is now read
  as a gone owner, not as a live rival. A second `session_start` in one process —
  a context compaction, or a resume in place — mints a fresh nonce, so the
  previous incarnation's claim matched this process's pid and start time but not
  its nonce and looked like another running session. The session was then handed a
  new incarnation number and locked out of every window its predecessor had opened,
  permanently, because the process that owned them could never be observed dead.
- `takeover: true` now reaches the scope the *window* is under, rather than the
  scope the session happens to lead with. The evidence an operator supplies names
  an owner and a generation, and `close`/`retain`/`steer`/`reclaim` applied it to
  the chain tip — so a window opened by a sibling incarnation was reported as
  untouchable and the refusal named a remedy that could not work.
- `job status` no longer counts this process's own earlier incarnation as a live
  sibling, so its scope note describes what the next dispatch will actually do.
- Ownership records are per **window**, named by its pane rather than its
  workspace. `tab` Jobs share the Orchestrator's workspace, so a workspace-named
  record could only ever describe one of them: opening a second Job overwrote the
  first's record and closing either removed it, which left the surviving — often
  retained — Job reading as a window with no owner at all. `job status wider: true`
  now lists every recorded window, plus anything this session's watch still holds
  even when its record is gone.

### A session owns a scope family, and a concurrent resume is no longer refused

- The run scope is now a **family** of incarnations, `<root>#0`, `<root>#1`, …,
  rooted at the session id (or `PI_HERDR_ENHANCED_SCOPE`). A second process
  resuming the same session while the first is running derives the next number
  instead of being refused, so two agents can dispatch at the same time.
- Every incarnation whose process is gone is absorbed by the next claim, so a
  session that restarts holds the whole dead history: a window still in its watch
  that was opened under an absorbed scope is disposable. A *live* sibling's scope
  is still never taken without an explicit `takeover`.
- Disposing of a window now checks the scope it was opened under, not only the
  session's own claim. A window opened by a live sibling is visible to `job
  status wider` and refused for `close`/`retain`/`steer`/`reclaim`, which is what
  keeps two concurrent incarnations from ending each other's work.
- The claim spool is keyed by the family **root**, so all incarnations of one
  session write Completion claims into one directory; a session that absorbs a
  dead sibling reads that sibling's claims rather than only its own.
- `PI_SESSION_ID` is not read any more: Pi injects it into shell tools only, so
  the extension always fell back to a PID. The root is now read from the session
  manager (`ctx.sessionManager.getSessionId()`), and `orchestrator` is the family
  root rather than a per-process id.
- `PI_HERDR_ENHANCED_SCOPE` now overrides the family root, for sessions that
  deliberately share one run scope, rather than naming a single scope.

## 0.1.0

Initial release. Two tools on top of the `herdr` CLI, distilled from
`dev-pipeline`'s `pi-foreman` extension:

### `job`

- `open` — one call establishes the window, starts the Pi Worker and submits the
  task prompt, with the Job registered with the watch *before* the session step
  so a failed launch still leaves an addressable Job.
- Two placements: a tab in the current Herdr workspace (the default), or a branch
  worktree opened as a workspace row with Git provenance.
- `worktree: false` is the parameter default and is not configurable; a
  configuration can only *lock* the other direction (`worktree.enabled: false`
  refuses `worktree: true` outright, and never downgrades it to a tab).
- `worktree.root: "auto"` passes no `--path` at all, so Herdr places the checkout
  under its own `worktrees.directory`.
- `complete` — Worker-only Completion claim, travelling as one file in an
  owner-only spool and waking nobody.
- `close` / `retain` / `reclaim` / `status` / `read` / `steer`.
- Resume, never duplicate: a live pane is reused or continued, a pane whose
  session died is restarted in place, and only a pane confirmed gone earns a
  replacement.
- Ownership fenced by a `(scope, generation, orchestrator, pid, host, startTime)`
  record plus an append-only claim ledger; explicit takeover requires the exact
  recorded owner and generation, and everything else fails closed.
- Retention with `retention.max_finished_windows`.
- A target that matches no open Job says so *and* names the two ways it happens —
  already closed, already dismissed — instead of returning a bare "no open Job
  matches", which is the moment an operator is most likely to be holding a stale
  name from its own earlier call.

### `job_watch`

- `status`, `wake`, `dismiss`, `hold`, `release`.
- A blocking Herdr wait per working Job plus a one-minute poll as the safety net.
- One Wake per stall, re-armed only once the Job is observed working again.
- The Wake is composed from its causes rather than asserted about them: the
  headline counts the kinds that fired (`1 Job declared complete, 1 job stopped
  working`), each cause states the evidence about one Job in that Job's terms, and
  a re-delivery says `Re-sent (delivery 2)` instead of repeating the first message
  verbatim.
- Coalescing of Jobs that stop together; a Completion claim bypasses the debounce.
- The retry ladder fires only for news nothing has picked up: a `consumed`
  delivery belongs to the run that consumed it, a delivery queued for a turn
  boundary is queued rather than lost, and a rung that expires while a run is live
  waits for it to end.
- `job retain` answers the Wake news that named the Job, and `dismiss` refuses a
  window that is still there rather than closing what was being reconciled.
- Closing or retaining a Job now also clears a Wake still waiting in the
  turn-boundary queue. A queued Wake can be minutes old when it is injected, so a
  Job closed inside that window used to produce news about a window that no longer
  existed — and, because its delivery had gone with the Job, nothing the operator
  called could answer it. It looked like a notification that would not go away.
- Opaque per-cause identities, consumed only from a delivered message and
  acknowledged only by a run that ended normally; retried with the same identity
  after 1, 5 and 10 minutes and then at most every 30 minutes.
- Wake injection held to a turn drain boundary, so delivered news is current and a
  retry cannot double-queue.
- `unref`'d timers, cancelled when nothing is left to watch, so an idle session
  can exit.

### Fixed while writing the end-to-end suite

Real defects, found by running the shipped entry point against a real `herdr` and
a real Worker instead of by reading the code:

- Anything keyed on a Job's `workspace` silently acted on its siblings. In tab
  mode every Job shares the Orchestrator's own workspace, so closing one Job
  unregistered all the others from the watch, retaining one retained a Job that
  was still working, and the retention cap could evict an unrelated window.
  Removal and retention are now keyed by pane.
- A Job replaced after its window disappeared left the dead record behind: it was
  reported forever, counted against the retention cap, and a later `job open`
  could resume a corpse. Replacing now forgets the pane it replaced.
- A dispatched Worker claimed the run scope it found in its own environment —
  which is how it would have taken over the Orchestrator's own scope and locked
  the Orchestrator out of the ledger that authorizes its windows. A Worker now
  claims no scope of its own and cannot dispatch.
- `job_watch status wider: true` was ignored: a second status handler never saw
  the flag, so "no Job windows on this host" could be reported while other
  windows existed. One handler now decides both views.
- A Wake's retry ladder was armed only on the next round, so a Wake lost between
  delivery and the next poll could wait two minutes instead of one.
- `job read` on a *working* Worker returned an error rather than its terminal: a
  working pane refuses scrollback. The read falls back to the visible rows and
  says so.
- Every session after the first warned that it did not own run scope `default`,
  and could not dispatch. The orchestrator id is per-process, so the ledger kept
  describing the previous session as a live rival long after its process was gone.
  An owner whose process is provably gone is now *inherited* — the generation still
  advances, so the fence is unchanged, but no human evidence is required because
  there is no live process left to fence against. A running owner, or one whose
  liveness cannot be established, is still a refusal.
- The scope claim is now taken at the first mutation rather than at session start:
  a session that only reads has nothing to fence, so it neither writes to the
  ledger nor locks out another session that does want to dispatch. `job status`
  reports the scope's standing read-only, and reports a gone owner rather than
  refusing to say anything.
- An absent claim spool was reported as an *unusable* one. Absence is the normal
  state of a run scope before its first Job, so it is now silent; a spool that
  exists and is wrong is still reported.
- A pane whose session had exited was treated as a *failing* Herdr call rather
  than as a pane with no agent, so resuming a Job there threw instead of
  restarting the session in place — and reading one after its Worker died returned
  an error instead of the screen it left behind. Herdr's `agent_not_found` is now
  read as the answer it is: the session question falls back to restarting, and the
  read falls back to `pane read`, which reaches a pane Herdr has no agent for.
- A Job that had never been observed working was announced the moment its pane
  read `idle`, so every dispatch looked like a stall for the seconds before Pi
  took its prompt. A Job is news only once it has run, or Herdr reports `done` or
  `blocked`, or the boot grace has expired.
- An idle Job was given a blocking wait, which Herdr answers immediately: a loop
  of Herdr processes instead of a wait. Waits are armed only for working Jobs;
  everything else is probed on a timer.

### Notes

- `--trust-repository` is never passed automatically: it bypasses Git's
  `safe.directory` protection, which is a human's decision. The refusal names the
  flag instead.
- Does not wrap `@ogulcancelik/pi-herdr`; drives the `herdr` CLI directly.
- Conflicts with `dev-pipeline`'s `pi-foreman` on the `job` tool name by design —
  this is its replacement.
