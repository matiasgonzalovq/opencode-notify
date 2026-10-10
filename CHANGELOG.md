# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-10

First public release. Extracted from a working private installation into a standalone repository.

### Added

- Notifications via **ntfy.sh** (`OPENCODE_NTFY_TOPIC`) and **macOS** (`terminal-notifier`), operating as independent channels.
- Completion notifications for `session.execution.succeeded`, with `session.idle` / `session.status: idle` kept as a legacy fallback for OpenCode v1.
- Notification on `permission.asked`, `question.asked` and `form.created`, each at ntfy `Priority: high`.
- Notification on `session.error` at `Priority: high`.
- Pending-state tracking: a completion is never reported while a permission, question or error is outstanding for that run.
- Cross-instance deduplication via atomic lockfile claim (`O_EXCL`) keyed by `SHA-256(event id)`, requiring no shared in-memory state.
- Tappable notification links driven by `OPENCODE_REMOTE_URL`, rewritten to the `googlechromes://` scheme.
- RFC 2047 encoding of non-ASCII notification titles.
- `terminal-notifier` resolution across `PATH` plus common Homebrew/MacPorts locations.
- Tolerant payload parsing for both OpenCode v1 (`properties`) and v2 (`data`).
- OpenCode v2 plugin contract (`export default { id, setup }`) with an abortable subscription and cleanup function; the v1 named export is retained.
- Bilingual documentation (English and Spanish), MIT license, security policy and CI workflow.
- Portable state directory: `OPENCODE_NTFY_STATE_DIR` overrides the deduplication location, which defaults to `~/.config/opencode` for continuity with pre-release installs.
- Injectable `now` clock for deterministic time-bucket behaviour in tests.

### Fixed

- **Duplicate completion notifications.** Instances that lost the lockfile claim returned early *before* recording that the run had already reported completion, so a subsequent `session.status: idle` or `session.idle` made them emit a second "Trabajo terminado". The completion state is now recorded before the claim is attempted, so every instance suppresses its legacy path for that run.
- **Errors permanently silenced.** The deduplication key for `session.error` fell back to the constant string `"current-run"` when the event carried no id, and that key was never released — so only the first error of a session ever notified and every later one was suppressed indefinitely. Unidentified errors now bucket by a 30 second window, so a new failure notifies again. Events that do carry an id keep exact per-id deduplication.
- **Silent drop of unidentified completions.** `session.execution.succeeded` with a missing or non-string `event.id` produced no notification at all. Such events now fall back to a 2 second time bucket: bursts inside one run collapse to a single notification, and a later run notifies again.

### Changed

- The deduplication directory is no longer a hardcoded absolute path; it is resolved from `OPENCODE_NTFY_STATE_DIR` or the user's home directory at call time.

### Known Limitations

- Cross-instance deduplication requires a shared state directory; separate machines or users on one host do not deduplicate against each other.
- The completion notification sent through the v2 `session.execution.succeeded` path uses a generic message, because that event does not identify the project. The legacy idle path still includes the project name.
- The macOS notification channel is limited to macOS; on other platforms it is skipped and the ntfy channel still works.
- If several sessions emit events without an `sessionID`, they share the `"unknown"` state bucket.
