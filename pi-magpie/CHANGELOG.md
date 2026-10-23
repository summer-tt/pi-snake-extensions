# Changelog

All notable changes to pi-magpie.

## 0.1.6

- The footer follows the gateway by itself: it is re-read after every run
  (`agent_end`), on a model switch and at session start, so a long session no
  longer shows the quota and the routed provider it saw at the beginning.
- Those reads ask magpie for what it already read
  (`GET /v1/magpie/quotas?kept=1`), as magpie's own status line does, so the
  footer never makes magpie read a vendor's usage endpoint — a plain read does,
  whenever magpie's minute of cache is up. Only a reading magpie has let go
  stale (15 minutes, `STALE_READING_MS`) is read again with the vendors asked,
  at most once in that window; `/magpie quota` and `/magpie refresh` still ask
  straight away.
- A routing group is now magpie's answer rather than an id prefix's:
  `magpie groups` lists every group (a made one's `group/<id>`, a found one's
  `auto/<model>`, which this held for neither before), read in the background
  at session start so the first paint is not held up by its few seconds, and
  the gateway's routing trace identifies a group that list cannot name. So
  `/magpie`, `/magpie group`, `/magpie groups` and the Tab completions now know
  found groups too, and a model magpie routes is never mistaken for a provider
  named `auto`.
- A routing group's footer line comes from the gateway's live routing trace
  (`GET /v1/magpie/trace`) instead of `magpie group <id>` plus the routing
  history: no subprocess, no file to tail, and the line moves with the
  request that just finished. The history on disk is still the fallback, and
  `$MAGPIE_BIN` is no longer run for the footer at all.
- A refresh that fails once keeps the reading the footer already shows; two
  failures in a row say `magpie unreachable`. An unchanged reading is not
  written again, so a refresh no longer repaints the footer for nothing.
- Quotas and routing are this machine's: a gateway on another machine now shows
  the model alone in the footer instead of the local machine's routing history.

## 0.1.5

- Works out of the box: with nothing configured, the provider answers from
  magpie's own loopback default (`$MAGPIE_GW_URL`, `$MAGPIE_ADDR`, else
  `http://127.0.0.1:3425`, key `magpie`), so installing the extension is
  enough to reach a magpie on this machine — no `/login` step. A magpie that
  isn't running just leaves the catalog empty; `/login magpie` still points
  the provider at another gateway and key.
- README rewritten to lead with the zero-setup story.

## 0.1.4

- The footer's routing-group line leads with the provider that answered: a
  group whose members all ask for one model shows the provider alone,
  spelled out (`smart → opencode-go`), one whose members differ keeps both,
  cutting a provider id longer than 8 characters in the middle with `..`
  only there (`order → ant..ity/gemini-3.8-flash`; `antigravity` →
  `ant..ity`, short of a separator: `opencode-go` → `ope..go`); the provider
  comes from the gateway's decision, or from the members when it names none.

## 0.1.3

- `reasoning` follows magpie's own flag as well as the level list: an entry
  with `reasoning: true` and empty `supported_reasoning_levels` (a thinking
  switch with no effort tiers, e.g. `mimo-v2.6-flash` through the relay;
  yetone/magpie#402) is now a reasoning model with no tiers, not a
  non-thinking one.

## 0.1.2

- The footer's quota line reads the tightest window at the width there is:
  `magpie 14% left · reset 3d` when the terminal has room, cut to
  `mag 14% · 3d` when it does not. The full form is tried against the
  terminal width minus 40 columns — always left for the other extensions'
  statuses, which share the line — and a terminal resize repaints the cached
  reading instead of refetching it.

## 0.1.1

- `/magpie` on its own is the overview: endpoint and whether it is local, the
  catalog's model and routing-group counts, and the current model's own
  reading, with the command list under it. It no longer prints only the current
  model.
- Tab completes the whole surface: the subcommands (with what each reports)
  while the first word is typed, then the ids the subcommand takes — every
  model for `quota`, every routing group for `group` — ranked by a fuzzy match
  that puts a prefix or a contiguous hit first.
- New `/magpie help`, and an unknown subcommand now answers with the command
  list instead of a bare usage line.
- The subcommand table is one source for the completions, the overview and
  `help`, so the three cannot drift apart (`usage.ts`, 15 unit tests).

## 0.1.0

- Initial release: magpie's gateway as the pi provider `magpie`.
- `/login magpie` asks for the endpoint and API key (defaults
  `http://127.0.0.1:3425` and `magpie`), validates them against
  `GET /v1/models`, and stores them in pi's `auth.json` as
  `{type:"api_key", key, env:{MAGPIE_GW_URL}}`. The provider is unconfigured
  until that happens.
- Live catalog from `GET /v1/models`, kept across runs and restored offline;
  each model is asked on the API its `native_endpoints` name (Responses,
  Anthropic Messages, else Chat Completions), with the endpoint stamped per
  request so a `providers.magpie` block in `models.json` cannot break it.
- `supported_reasoning_levels` becomes pi's `thinkingLevelMap`; Claude 4.6 and
  on is marked `forceAdaptiveThinking`.
- Footer status per current model: the tightest quota window for a model
  (`Codex · 14% · 3d`), routing and last answered member for a group
  (`smart → xiaomi/mimo-v2.6-flash`), cleared for other providers.
- Commands: `/magpie`, `/magpie quota [model]`, `/magpie group [id]`,
  `/magpie groups`, `/magpie refresh`, `/magpie endpoint`.
- Routing groups from the magpie CLI (`$MAGPIE_BIN`, else `PATH`) and magpie's
  routing history (`~/.config/magpie/routing/<day>.jsonl`), read from the tail.
- Startup warning when `models.json` also names `providers.magpie` while a
  magpie credential is stored.
