# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-10-16

### Fixed

- `Esc` while the countdown is running now only cancels the countdown. It no
  longer falls through to pi's `app.interrupt` handler, so pressing `Esc` no
  longer aborts an agent that is mid-run. The key is matched through pi's own
  keybinding (rebinding works) and passed through untouched whenever no
  countdown is active.

## [0.1.2] - 2026-09-23

### Changed

- Package description shortened to "Think twice before you send prompts" —
  it is the subtitle shown on the pi.dev package gallery.
- README intro rewritten around deferred send; key details now live only in
  the behavior table.

## [0.1.1] - 2026-09-23

### Added

- Double enter: a second plain `Enter` during the send countdown now sends
  immediately once `doubleEnterSeconds` (default 1 s) have passed since the
  first one; earlier repeats stay ignored, and `Ctrl+Enter` still sends at
  any time.
- New config `doubleEnterSeconds` — the double-enter interval; `0` lets any
  `Enter` during the countdown send.
- The whole countdown text (spinner, seconds, hints) is painted with the
  theme's warning color (yellow/orange), and the border hint flips to
  "Enter send now" once the double-enter interval has elapsed.

## [0.1.0] - 2026-09-23

### Added

- Send countdown: `Enter` opens a countdown (default 3 s) with the message
  staying in the editor; the send fires only after it expires.
- Interrupt semantics: any key cancels and keeps the text editable; plain
  `Enter` during the countdown is ignored; `ESC` cancels; `Ctrl+Enter` sends
  immediately (skips the countdown, or finishes it early).
- Exemption decision table: built-in and extension commands submit as before;
  skills, prompt templates, unknown `/commands`, and `!bash` count down;
  `alwaysCountdown` (seeded with `/compact`) overrides everything.
- Built-in command list obtained by live reflection from pi's autocomplete
  provider, with a pi 0.86 snapshot fallback and fail-open behavior, so a
  broken reflection never affects pi.
- Grace-period border indicator with pi's working spinner, three width
  variants, and stock-border degradation on any rendering fault.
- Autocomplete split: `Enter` with an open suggestion applies the completion
  first, then runs the countdown decision on the completed text.
- Global config at `~/.pi/agent/pi-think-twice.json` (`delaySeconds`,
  `alwaysCountdown`), read once per process; `delaySeconds: 0` disables the
  extension.
- Cancelled messages never enter the session; cancelled `up`/`down` history.
- Headless test suite (33 tests): config parsing, decision table, reflection
  fallbacks, and editor key-behavior including failure-path fail-open checks.
