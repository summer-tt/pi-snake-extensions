# pi-magpie

> [magpie](https://github.com/yetone/magpie)'s gateway as a pi provider — magpie's own model list, quotas and routing groups instead of a frozen `models.json`.

| | |
| --- | --- |
| Provider | `magpie` |
| Login | `/login magpie` — endpoint (default `http://127.0.0.1:3425`) and API key (default `magpie`, which a loopback gateway accepts) |
| Commands | `/magpie`, `/magpie quota [model]`, `/magpie group [id]`, `/magpie groups`, `/magpie refresh`, `/magpie endpoint`, `/magpie help` — all of them complete on Tab |
| Status bar | `magpie Codex · 14% · 3d`, `magpie smart → opencode-go`, `magpie order → ant..ity/gemini-3.8-flash` |
| Credential | pi's `auth.json`: `{"type":"api_key","key":"…","env":{"MAGPIE_GW_URL":"http://127.0.0.1:3425"}}` |

## What it does

One local gateway in front of every provider, with one model list, one quota
view and one routing decision. This extension makes pi a first-class client of
it:

- **The model list is magpie's.** Every catalog fetch reads `GET /v1/models`
  and installs what magpie serves right now — routing groups, subscriptions,
  accounts and providers appear and disappear with magpie, instead of being
  frozen into `models.json` by whichever model magpie last wrote there.
- **Each model is asked on the protocol its provider speaks natively.** magpie
  reports `native_endpoints`; a Responses model goes to `{root}/v1`, an
  Anthropic Messages model to `{root}` (the SDK appends `/v1`), everything else
  to `{root}/v1` over Chat Completions. magpie then relays instead of
  translating.
- **Reasoning levels come from the model.** `supported_reasoning_levels`
  becomes pi's `thinkingLevelMap`: levels the model has are offered, the rest
  are hidden. A Claude from 4.6 on is marked adaptive, so pi asks for adaptive
  thinking instead of a budget it would refuse. An entry magpie marks
  `reasoning: true` with no levels is a thinking switch with no tiers: pi
  offers thinking, and no level list.
- **The footer follows the current model, and the terminal's width.** For a
  model, the tightest quota window magpie reports for that provider:
  `magpie 14% left · reset 3d`, cut to `mag 14% · 3d` when there is no room
  (40 columns are always left for the other extensions' statuses, and a
  resize repaints the line at the new width). For a routing
  group, its routing strategy and the provider that answered last — just the
  provider, spelled out, while every member is one model, the model carrying
  no news (`smart → opencode-go`), provider and model when the members
  differ (`order → ant..ity/gemini-3.8-flash`), a provider id over 8
  characters cut in the middle only there (`antigravity` → `ant..ity`).
  Leaving `magpie` for another provider clears it.
- **No protocol code.** Requests are handed to pi-ai's built-in
  `openai-completions`, `openai-responses` and `anthropic-messages`
  implementations, so message conversion, tool calls, usage accounting,
  cancellation and the request-instrumentation hooks behave exactly as they do
  for a built-in provider.

## Install

```bash
pi install ./pi-magpie
```

Then `/login magpie`. The endpoint prompt is pre-filled with
`http://127.0.0.1:3425` (or `$MAGPIE_GW_URL`, or `$MAGPIE_ADDR`), the key
prompt with `magpie`. Login fetches the catalog once and shows it immediately;
`/logout magpie` forgets both.

**Until you log in, the provider is unconfigured and pi shows no magpie
models.** There is no silent loopback default: pointing pi at a gateway is a
decision, and `/login magpie` is where it is made. A LAN gateway is set up the
same way — give its address and the `lanKey` from magpie's settings instead.

## Commands

```text
/magpie                  where the gateway is, what it serves, and the current
                         model's quota or routing group
/magpie quota [model]    what the model's provider has left, every account
/magpie group [id]       a routing group's members, rules and last decision
/magpie groups           every routing group magpie offers
/magpie refresh          fetch magpie's catalog again now
/magpie endpoint         the gateway in use, and whether models.json also names it
/magpie help             the same list, on its own
```

Typing `/magpie ` and pressing Tab lists those subcommands with what each one
reports, and the subcommand's own Tab lists the ids it takes — every model for
`quota`, every routing group for `group`, filtered as you type:

```text
/magpie quota mimo   → group/auto-mimo-v2-6-flash | opencode-go/mimo-v2.6-flash | …
/magpie group        → group/auto-deepseek-v4-1-flash | group/auto-mimo-v2-6-flash
```

`/magpie` on its own is the overview: the endpoint and whether it is on this
machine, how many models and groups the catalog holds, and the current model's
own reading. For a model that is its tightest quota window; for a routing
group, its rule and the member that answered last. Not on a magpie model? It
says so, and leaves the status bar alone.

`/magpie group <id>` works for any group, not just the current one — it is how
you look at what `group/auto-mimo-v2-6-flash` routes to, or why a request went
to the account it did.

## Where the readings come from

| Reading | Source |
| --- | --- |
| Models | `GET {root}/v1/models` |
| Quotas | `GET {root}/v1/magpie/quotas` — magpie answers this to loopback only |
| A group's definition | `magpie group <id>` (`$MAGPIE_BIN`, else `magpie` on `PATH`) |
| A group's last request | magpie's routing history, `~/.config/magpie/routing/<day>.jsonl` |

The two readings magpie tells only this machine — quotas and the routing
history — are simply skipped for a remote endpoint; the model list and the
requests themselves work either way. The history is read from its tail, and the
last decision is looked up per group in one pass, so a footer refresh does not
re-read a day's file.

## The `models.json` warning

magpie writes a `providers.magpie` block into `~/.pi/agent/models.json`
whenever one of its models is picked for pi in magpie's own UI. Once this
extension is logged in, that block is reported at startup, because it changes
what the live catalog gets:

- it sets **one** `baseUrl` for every model of the provider, which would point
  an Anthropic model at `/v1/v1/messages`;
- it makes the provider look configured before `/login`;
- pi prefers its frozen `models` list over this extension's catalog.

Requests still work — the endpoint is stamped per request from the credential's
`MAGPIE_GW_URL` rather than trusted from the model — but the model list and the
"must log in" rule do not. Set pi's model to `default` in magpie (which removes
the block), or delete it by hand.

## Notes and limits

- Every model reports cost `0`: magpie's catalog carries no prices. The
  footer cost of a magpie session is therefore not meaningful; usage tokens are.
- A routing group is a normal model id (`group/<id>`) — magpie does the
  routing, and pi sees one model.
- `MAGPIE_BIN` points the group readings at another magpie binary; without the
  CLI, a group still shows its id, its members from the catalog, and its last
  request from the routing history.
- `MAGPIE_ADDR` (magpie's own variable, `host:port`) is honoured as the
  default endpoint when no credential is stored.
