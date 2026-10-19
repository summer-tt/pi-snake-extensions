# pi-herdr-enhanced

Two tools for the [pi](https://github.com/earendil-works/pi) coding agent, on top of the [`herdr`](https://herdr.dev) CLI:

| Tool | The question it answers |
|---|---|
| `job` | "run this bounded task somewhere and let me clean it up later" |
| `job_watch` | "is anything I opened still working, and wake me when one stops" |

Dispatch a Job, go idle, and get woken the moment it stops working — instead of
holding a blocking wait that spends tokens and fills context for the whole
duration.

```
job open   →  a window, a Pi Worker, and the task prompt in one call
              (resume by name, never a duplicate)
you sleep  →  0 tokens
job_watch  →  "Job fix-142 settled at w1:p3 and declared complete; reconcile it."
job read   →  the pane decides the result, not the status line
job close  →  or job retain, to keep the window readable while it leaves the watch
```

## Install

```bash
pi install ./pi-herdr-enhanced
```

Or from npm (once published):

```bash
pi install npm:pi-herdr-enhanced
```

The extension activates only when Pi runs inside a Herdr-managed pane with
`HERDR_ENV=1` and `HERDR_PANE_ID` set. It drives the `herdr` CLI directly and
does **not** wrap `@ogulcancelik/pi-herdr` — Pi exposes no cross-extension tool
executor, and that package has no worktree operations at all. Keep both
installed: `herdr_*` stays the right tool for one-off pane work.

> **Do not enable this beside `dev-pipeline`'s `pi-foreman`.** Both register a
tool named `job`, so Pi refuses to load the second one (`Tool "job" conflicts`).
> This extension is the standalone replacement for that half of Foreman: disable
> the `dev-pipeline` package in `pi config` before enabling this one, or load it
> explicitly for one session with `pi -ne -e ./pi-herdr-enhanced/index.ts`.

## Where a Job lives

`job open` takes `worktree`, and it defaults to **`false`**. There are two
placements, and the choice is a parameter rather than a policy.

### `worktree: false` (default) — a tab

The Job gets a new tab in the Herdr workspace you are already in
(`herdr tab create --workspace <yours> --cwd <dir> --label <ticket> <name>`).
Its root pane is the Worker.

Good for: review passes, investigations, anything that should read the tree you
already have. No branch, no second checkout, and nothing to clean up beyond the
tab.

### `worktree: true` — a branch worktree

The Job gets a branch worktree opened as a workspace row with Git provenance, so
the sidebar groups it under its repository instead of listing it flat:

```
job open(name: "fix-142", ticket: "#142", worktree: true,
         repo: "/repo", branch: "fix-142", base: "main",
         prompt: "Fix the null deref in the parser, commit it, report the SHA.")
```

Requires `repo` (the **primary** checkout — Herdr refuses a linked worktree as a
source), `branch`, and `base`. `job reclaim` removes the checkout through
`git worktree remove` once the branch is integrated, and closes the rows it
leaves behind.

### Locking worktree mode off

Configuration can lock the direction it cannot relax: `worktree.enabled: false`
at either scope **refuses** any `worktree: true` call, with nothing created. It
never silently downgrades to a tab — that would leave you believing you hold an
isolated branch while the Worker writes into a shared checkout.

```jsonc
{ "worktree": { "enabled": false } }
```

The parameter's own default stays `false` and is not configurable: a
configuration cannot make Jobs start creating branches on their own.

## Where a worktree goes

`worktree.root` decides, and the default is `auto`: **no `--path` at all**, so
Herdr uses its own `worktrees.directory` — `<root>/<repo>/<branch-slug>`, by
default `~/.herdr/worktrees/<repo>/<branch-slug>`. Change it in Herdr's config,
or override it here:

```jsonc
{
  // "auto"                  → ~/.herdr/worktrees/<repo>/<branch-slug>
  //                           outside the checkout; no .gitignore; one place to clean
  //                           (this is what Herdr's own worktrees.directory says)
  //
  // ".worktrees"            → <repo>/.worktrees/<job>
  //                           travels with the repo, and is deleted with it.
  //                           ⚠️  add `.worktrees/` to the repo's .gitignore,
  //                               or it shows up as untracked in the main checkout.
  //
  // "../<repo>.worktrees"   → a sibling of the repository
  //                           outside the checkout, nearby, no .gitignore needed.
  //
  // "~/workspace/worktrees" → <root>/<repo>/<job>
  //                           one root for every repository you work in.
  "worktree": { "root": "auto" }
}
```

A relative root resolves against the **primary checkout**, so the same setting
means the same place no matter which worktree you invoked it from.

## Configuration

```jsonc
// ~/.pi/agent/pi-herdr-enhanced.json              (global)
// <project>/.agents/pi-herdr-enhanced/config.json (project; wins per key)
{
  // Only "tab" is implemented.
  "placement": "tab",

  "worktree": {
    "enabled": true,   // false ⇒ lock: refuse any worktree: true
    "root": "auto"
  },

  // How many finished windows may stay open for inspection.
  "retention": { "max_finished_windows": 2 },

  "watch": {
    "tick_ms": 60000,            // the safety-net poll
    "debounce_ms": 1500,         // coalesce Jobs that stop together
    "stall_threshold_ms": 1200000
  }
}
```

A malformed or unreadable file degrades to defaults with a warning rather than
throwing: a trailing comma should not look like Herdr being down.

`worktree.enabled` is a union, not a lookup: `false` at either scope locks, and
nothing at a lower scope can unlock something above it.

Environment overrides: `PI_HERDR_ENHANCED_STATE`, `PI_HERDR_ENHANCED_SPOOL_PATH`,
`PI_HERDR_ENHANCED_SCOPE`.

`PI_HERDR_ENHANCED_SCOPE` overrides the **family root**, which defaults to the
session id. Set it when two separate sessions should deliberately share one run
scope family; left unset, every session — and every fork or clone of it — is its
own family, and two processes resuming the same session share one.

## The two things that make this safe

**A Worker cannot fabricate a Job, and cannot tear one down.** Every dispatched
Worker is launched with an opaque capability flag that this extension registers
and reads back from `argv` — never from prompt text, so the model is never taught
the transport. A session without a capability *is* an Orchestrator, by
definition:

- `job complete` writes one claim file and wakes nobody
- `job close` and `job retain` are refused inside a Worker: ending the window it
  runs in destroys its own pane and strands the watch

**A session owns a *family* of scopes, and concurrency is a new number.** The
family root is the session id (or `PI_HERDR_ENHANCED_SCOPE`), and each
incarnation is `<root>#0`, `<root>#1`, … Every window carries
`(scope, generation, orchestrator, pid, host, startTime, nonce)`, and each scope
has its own append-only ledger:

```jsonl
{"scope":"s1#0","generation":1,"orchestrator":"s1","pid":41,"at":"..."}
```

`generation` means "which incarnation owns this scope" — a fencing token, not a
counter of attempts. `orchestrator` is the family root, so every incarnation of
one session is recognizably the same family, while its pid, start time and nonce
tell concurrent incarnations apart.

When a second process resumes the same session while the first is still running,
it does not fight for `#0`: it takes `#1`. **A dispatch is never refused merely
because somebody else is already running** — a family always has room for one
more incarnation. Every incarnation whose process is gone is then absorbed, so the
highest surviving one holds the whole dead history:

```
job_watch status  →  Run scope family 's1' has 1 live incarnation (s1#0);
                     dispatching takes a new scope 's1#1'.
```

Because the spool is keyed by the family root rather than by a scope, all
incarnations write Completion claims into one directory, and a session that
absorbs a dead sibling reads that sibling's claims rather than only its own.

Explicit takeover is still how a **live** sibling's scope is taken, and it is
still exact:

```
job status(wider: true)          →  another-live-owner | unowned | ownership-unknown
job close(name, takeover: true,
          expectedOwner: "s1",
          expectedGeneration: 1) →  appends generation 2, supersedes 1
```

Anything else fails closed on the ledger: a missing record, a recycled PID, a
stale field, or an incomplete chain authorizes nothing. And **a live sibling's
window is never disposed of**: every window records the scope it was opened
under, and only a scope this session holds — its own or an absorbed one — is
disposable. A `wider` report names such a window; it does not licence ending it.

**A watch entry belongs to the branch that wrote it.** Restoring the watch still
takes the newest entry in the session, so two concurrent incarnations of one file
do not merge their open sets — the last writer's is restored. Their scopes are
absorbed, and `job status wider` reports every window on the host, so nothing
becomes unreachable; but a Job from a sibling branch that the restored watch no
longer holds is named there rather than silently resurrected.

**The claim is taken at the first mutation, not at session start.** A session that
only reads or reports has nothing to fence, so it neither writes to the family's
ledgers nor makes a concurrent incarnation derive an unnecessary scope. Opening,
closing, retaining, steering and reclaiming all claim first; `job status` is a
read and takes no generation.

## Notes on the hard parts

**`--trust-repository` is never automatic.** It bypasses *Git's* `safe.directory`
protection for a repository owned by another user — a decision about trust that
belongs to a human. When Git refuses, the error tells you the flag exists; the
extension never passes it on its own and never changes your Git configuration.
`job open` and `job reclaim` accept `trustRepository: true` for one call when you
have verified the repository, and `force: true` likewise for a dirty checkout.

**`job status` classifies; it never concludes.** Herdr's `idle` and `done` are UI
visibility states — a Job that finished in under a second is indistinguishable
from one that never launched. So a status line or a Wake names a state, and
`job read` decides the result. A Completion claim requests reconciliation; it
never proves success.

**A Wake raises a question, and the two verbs that answer it are named in the
Wake itself.** Each cause states the evidence about one Job in the terms of that
Job — `Job review-a-sol (#42) at w1:p7 is idle and declared complete.` — and the
message closes with the ask: retain what has been captured, or close what should
end. `job_watch dismiss` is reserved for a window Herdr no longer has; on a live
window it is refused and names both verbs, because its name reads like "dismiss
the news" and an operator who means that would otherwise silently close the
window it was still reconciling.

**A Wake is delivered once per stall, and says what it is.** The watch holds a
blocking wait on every working Job, wakes on the first one that stops, coalesces
Jobs that stop together into one message, and retries an unhandled Wake with the
same identity after 1, 5 and 10 minutes and then at most every 30 minutes. The
message names the kinds of news it carries — *1 Job declared complete, 1 job
stopped working* — rather than describing them all with the least informative
one, and a re-delivery says `Re-sent (delivery 2): nothing has answered this news
yet.` instead of repeating the first message verbatim.

**Nothing is retried while someone is acting on it.** A delivery that Pi handed
to a run is `consumed`, and that run owns the reconciliation: a run that ends
normally acknowledges it, an `aborted` run retires it, and one that ends in an
error leaves it `failed` with its ladder rung — which is what the ladder is for.
A delivery still queued for a turn boundary is queued, not lost, and a rung that
expires while a run is live waits for that run to end. Without those rules the
ladder re-sends the same Wake about the same Job while the Orchestrator is still
reading its panes, which makes a Job being handled look like one being ignored.

**Retaining or closing a Job answers the news that named it.** `job retain` is
exactly the reconciliation a Wake asks for, so the delivery is acknowledged
rather than left to nag the next `job status` and to come back on the ladder; a
closed window takes its news with it, because the window is the unit of the whole
watch. That includes a Wake still waiting in the turn-boundary queue: it can be
minutes old by the time it is injected, and a queue that kept it would deliver
news about a Job the operator had already ended — with its delivery gone, so
nothing could answer it and it read as a stale notification that would not go
away.

**The unit of a Job is its window, never its workspace.** In tab mode every Job
shares the Orchestrator's own Herdr workspace, so anything keyed on the workspace
would act on siblings: closing one Job would drop the others from the watch, and
retaining one would retain a Job that is still working. Every removal and every
retention is keyed by pane. It also means a branch worktree's checkout outlives
its window — `job close` ends the *workspace* of a worktree Job, and only `job
reclaim` removes the checkout, through Git. Herdr refuses a plain close of a
workspace that has linked worktree workspaces unless the whole group is named
(`workspace close <id> --group`); this extension only ever closes a Job's own
window, so it never takes a group with it.

**A failed open keeps its window.** Provisioning is not atomic: a Pi start that
times out leaves a window that `job status` lists and a repeated `job open`
resumes in place. Rolling it back would leave an orphan nothing can address.
That is also why `onEstablished` registers the Job before the session starts.

## State

```
~/.pi/agent/state/pi-herdr-enhanced/
  owners/<pane>.json               one ownership record per Job window
  scopes/<root>#<k>.jsonl          one append-only claim ledger per incarnation
  spool/<root>/claim-*.json        Completion claims, shared by the family
  spool/<root>/progress-*.json     content-free activity observations
```

The `<root>` is the session id (or `PI_HERDR_ENHANCED_SCOPE`), so a forked or
cloned session is a different family by construction, while two processes
resuming the same file share one.

The spool is created owner-only (0700), verified before every read and write,
written through a temp name and renamed into place, and swept on a TTL. A claim
is a routing signal that requests reconciliation, so it may expire — the watch's
own status fallback still wakes you for a Job that never claimed.

## Tools

### `job`

| Action | Notes |
|---|---|
| `open` | `name`, `ticket`, and exactly one of `prompt` / `file`. Optional `model`, `thinking`, `cwd`, `worktree`, `repo`, `branch`, `base`, `path`, `stallThresholdMs`, `trustRepository`. Resume: re-opening a name returns to its existing window. |
| `complete` | Worker only. Records a Completion claim and wakes nobody. |
| `close` | `workspace` or `name`. Refuses an unfinished Job without a `reason`. |
| `retain` | `panes`, optional `keep`. Keeps windows readable and out of the watch, and answers the Wake news that named them. |
| `reclaim` | `repo` + `path` (or an open worktree Job's `name`). Removes the checkout through Git. |
| `status` | `scope`, `wider`. The open set; `wider` classifies every Job window on the host. |
| `read` | `target`, `lines`. |
| `steer` | `target`, `message`. |

### `job_watch`

`status`, `wake`, `dismiss`, `hold` (`panes`, `note`, `timeoutMs`), `release`.

`hold` is for a Worker that has genuinely reached a human question: it suppresses
ordinary Wake decisions for that Job while keeping dead-pane and deadline checks.
Release it when the wait is over.

`dismiss` is only for a window Herdr no longer has — after a crash, or a tab
closed by hand. It refuses a window that is still there and names `job retain`
and `job close` instead.

## Development

```bash
npm test         # 143 tests: no Herdr, no Pi, no model
npm run test:e2e # 49 tests: a real herdr, real Git, and a real Pi Worker
npm run typecheck
```

**Unit tests** need nothing. The whole decision surface is testable because Herdr
is one injected seam (`RunCommand`), and nothing below `index.ts` imports Pi. The
suite drives a fake `herdr` CLI whose answers and side effects are observable, so
the rules that matter — refusing before a side effect, resuming instead of
duplicating, keeping a window whose session failed, waking once per stall — are
asserted directly.

**e2e tests** drive the shipped entry point against the real thing, and they are
skipped outside a Herdr pane, which they need in order to create workspaces. They
create real workspaces and tabs, spawn a real Pi Worker through `herdr agent
start`, and read the results back out of Herdr. `tests/e2e/` supplies Pi's side of
the API — `exec`, `appendEntry`, `sendMessage`, `process.argv` — so the extension
calls the actual `herdr` and `git` binaries. State lives under a temporary agent
directory, every scenario closes the workspace it created (and fails if it
leaked one), and a run leaves nothing in `~/.herdr` or `~/.pi`.

| Suite | What it pins down |
|---|---|
| `refusals.e2e.ts` | 21 cases that must create *nothing*: the worktree lock, task-source validation, unknown actions and targets, the Worker-only refusals, and the scope claim a Worker must never make. |
| `scope.e2e.ts` | The run scope family: a session after its predecessor died silently inherits it, dead siblings are absorbed, a live incarnation does not lock the next one out, and a session that only reads never claims. |
| `lifecycle.e2e.ts` | One real Worker: dispatched, declaring completion through the capability it was spawned with, waking this session, read, steered, re-opened as a resume, and replaced after its window is closed underneath it. |
| `watch.e2e.ts` | Retention, the cap's eviction, hold and release, dismissal of a vanished window, the refusal of a live one, retaining answering the Wake it reconciled, a sibling in the same workspace surviving its neighbour's close, and wider inspection of a window this session does not own. |
| `worktree.e2e.ts` | A Job in a branch worktree: a real Git worktree, a workspace of its own, a close that ends the workspace rather than a tab, and a reclaim that removes the checkout while leaving the branch's commits alone. |

## Requirements

- Pi 0.80 or newer
- Herdr 0.9 or newer (its `worktree`, `tab create` and `agent wait` surfaces)
- Pi running inside a Herdr pane

## License

MIT
