# pi-snake-extensions

A monorepo of [pi](https://github.com/earendil-works/pi) coding agent extensions.

## Extensions

### pi-mcp

MCP extension — load once, whole-server schema, then call; with OAuth 2.1 and no daemon.

### pi-think-twice

Send countdown — `Enter` opens a grace period (default 3 s) instead of sending:
your message stays in the editor, any key interrupts and keeps it editable,
`ESC` cancels, `Ctrl+Enter` sends now.

### pi-context-window-cap

Hard global cap on every model's context window (default 300K) — compaction,
the context meter, and overflow recovery all follow the cap. Global switch via
`/context-window-cap toggle`, cap value via `/context-window-cap set 300k`.

### pi-magpie

[magpie](https://github.com/yetone/magpie)'s gateway as a pi provider — the
live model list, quotas and routing groups instead of a frozen `models.json`.
`/login magpie`, then `/magpie`, `/magpie quota`, `/magpie group`,
`/magpie groups`.

## Install

```bash
pi install ./pi-mcp
```

Or from npm (once published):

```bash
pi install npm:@tinysnake/pi-mcp
pi install npm:pi-think-twice
```

## Requirements

- Node.js ≥ 22.6 (for native TS stripping)
- [pi coding agent ≥ 0.80](https://github.com/earendil-works/pi)
