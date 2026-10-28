# pi-magpie

> **One gateway, every provider — and it just works.**

[magpie](https://github.com/yetone/magpie)'s gateway as a pi provider. Install
the extension, and pi talks to the magpie running on your machine — no login,
no endpoint to type, no key to paste. magpie listens on a loopback address
with a default port, so the extension finds it on its own.

magpie is one local endpoint in front of every model provider you have. It
keeps one live model list, one quota view, and one routing engine that picks
which account answers each request. This extension makes pi a first-class
client of it.

## Zero setup

magpie's own defaults are the extension's defaults. With nothing configured,
it reaches `http://127.0.0.1:3425` with the key `magpie` — the endpoint
magpie listens on out of the box. Install, and your magpie models are there.

```
pi install npm:pi-magpie     # then open pi and pick a magpie model
```

If magpie isn't running, the catalog is simply empty — no errors, no setup
wizard. Start magpie and `/magpie refresh`.

A gateway somewhere else (a LAN box, a shared key) is the only thing that
needs a step: `/login magpie` asks for its endpoint and API key, and
`$MAGPIE_GW_URL` / `$MAGPIE_ADDR` set the default when you'd rather not store
one.

## What it does

- **The model list is magpie's, live.** Every refresh reads `GET /v1/models`
  and installs exactly what magpie serves right now — routing groups,
  subscriptions, accounts and providers appear and disappear with magpie,
  instead of being frozen into a `models.json` that goes stale.
- **Each model is asked on the protocol its provider speaks natively.** A
  Responses model goes to the Responses API, a Claude to Anthropic Messages,
  everything else over Chat Completions — magpie relays instead of translating.
- **Reasoning levels come from the model.** `supported_reasoning_levels`
  becomes pi's level list: levels the model has are offered, the rest hidden.
  A Claude from 4.6 on is marked adaptive, so pi asks for adaptive thinking
  instead of a budget it would refuse.
- **The footer tells you what's actually serving you.** On a model, its
  tightest quota window (`magpie 14% left · reset 3d`); on a routing group,
  the strategy and the provider that answered last (`smart → opencode-go`).
  It follows the terminal's width and repaints on resize, and it follows the
  gateway by itself — after every run, not on a clock.
- **No protocol code.** Requests are handed to pi-ai's built-in
  `openai-completions`, `openai-responses` and `anthropic-messages`
  implementations, so message conversion, tool calls, usage accounting,
  cancellation and instrumentation behave exactly as they do for a built-in
  provider.

## The footer

For a **model**, the tightest quota window magpie reports for that provider,
cut to fit when the terminal is narrow (40 columns are always left for other
extensions' statuses):

```
magpie 14% left · reset 3d        mag 14% · 3d
```

For a **routing group**, the routing strategy and who answered last — the
provider alone while every member is one model (the model carries no news),
provider and model when the members differ. A provider id over 8 characters
is cut in the middle:

```
magpie smart → opencode-go
magpie order → ant..ity/gemini-3.8-flash
```

Leaving `magpie` for another provider clears the line.

Which models are routing groups is magpie's answer, not a prefix's: `magpie
groups` lists them all — a group you made as `group/<id>`, a group magpie found
as `auto/<model>` — and the gateway's routing trace says what a group the list
does not name (a magpie without its CLI on `PATH`) last did. Both are read here,
so `/magpie groups` and the Tab completions list found groups too.

Watching the footer costs magpie's vendors nothing. The line is re-read after
every run, on a model switch and at session start, and each of those reads asks
magpie for what it **already read** (`GET /v1/magpie/quotas?kept=1`) — the same
reading magpie's own status line uses, so no vendor's usage endpoint is hit.
Only a reading magpie has let go stale (15 minutes) is read again with the
vendors asked, at most once in that window; `/magpie quota` and `/magpie
refresh` ask straight away. A group's last request comes from the gateway's
live routing trace (`GET /v1/magpie/trace`, this machine only), so it shows the
request that just finished rather than a file's tail.

## Commands

| | |
| --- | --- |
| `/magpie` | where the gateway is, what it serves, and the current model's quota or routing group |
| `/magpie quota [model]` | what the model's provider has left, every account |
| `/magpie group [id]` | a routing group's members, rules and last decision |
| `/magpie groups` | every routing group magpie offers |
| `/magpie refresh` | fetch magpie's catalog again now |
| `/magpie endpoint` | the gateway in use, and whether models.json also names it |
| `/magpie help` | the same list, on its own |

Every one completes on Tab: the subcommands while the first word is typed,
then the ids the subcommand takes — every model for `quota`, every routing
group for `group`, ranked by a fuzzy match that puts a prefix or a contiguous
hit first.

`/magpie` on its own is the overview: the endpoint and whether it's the
default or a stored one, how many models and groups the catalog holds, and
the current model's own reading — its tightest quota window, or its group's
rule and last answered member.

## Where the readings come from

| Reading | Source |
| --- | --- |
| Models | `GET {root}/v1/models` |
| Quotas | `GET {root}/v1/magpie/quotas?kept=1` — what magpie already read; a plain read asks the vendors, and magpie answers it to loopback only |
| Which models are groups | `magpie groups` (`$MAGPIE_BIN`, else `magpie` on `PATH`), else the routing trace |
| A group's definition | `magpie group <id>` (`$MAGPIE_BIN`, else `magpie` on `PATH`) |
| A group's last request | the gateway's live routing trace, `GET {root}/v1/magpie/trace`; else magpie's routing history, `~/.config/magpie/routing/<day>.jsonl` |

The readings magpie tells only this machine — quotas, the routing trace and
the routing history — are skipped for a remote endpoint; the model list and the
requests themselves work either way. The trace is the gateway's own memory of
its last 60 requests, so a footer refresh reads no file at all.

## The `models.json` warning

magpie writes a `providers.magpie` block into `~/.pi/agent/models.json`
whenever one of its models is picked for pi in magpie's own UI. That block
sets **one** `baseUrl` for every model of the provider — which would point an
Anthropic model at `/v1/v1/messages` — and pi prefers its frozen `models`
list over this extension's live catalog. Requests still work (the endpoint is
stamped per request), but the model list and native paths don't. Set pi's
model to `default` in magpie (which removes the block), or delete it by hand.
The extension reports the conflict once at startup.

A block that holds only `modelOverrides` (per-model windows, prices, cache
TTLs — even next to a display `name`) changes models without touching how any
of them is reached, and is not a conflict: the startup warning and the
`/magpie endpoint` note stay silent for it.

## Notes & limits

- Every model reports cost `0`: magpie's catalog carries no prices. The
  footer cost of a magpie session isn't meaningful; usage tokens are.
- A routing group is a normal model id (`group/<id>`) — magpie does the
  routing, and pi sees one model.
- `MAGPIE_BIN` points `/magpie group` and `/magpie groups` at another magpie
  binary. The footer needs no CLI to show a group's last request (the gateway's
  trace has it), but without the CLI it can only tell a group that has taken a
  request: an unused one shows as a model.
- Quotas, the routing trace and the routing history are this machine's alone,
  so a remote gateway shows the model list and routes requests but reports
  neither.

## Install

```bash
pi install npm:pi-magpie
```

Or straight from this repository, at a pinned commit — the repo root is a pi
package whose manifest exposes only this extension:

```bash
pi install git:github.com/summer-tt/pi-snake-extensions@<commit-sha>
```

From a local checkout (development): `pi install ./pi-magpie`.

Requires Node ≥ 22.6 and pi ≥ 0.80. See
[CHANGELOG.md](https://github.com/tinysnake/pi-snake-extensions/blob/master/pi-magpie/CHANGELOG.md)
for the version history.
