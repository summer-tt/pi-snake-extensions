# Changelog

All notable changes to pi-magpie.

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
