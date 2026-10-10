# Security Policy

## Reporting a Vulnerability

Please report security issues privately via GitHub Security Advisories on this repository, or by contacting the maintainer. Do **not** open a public issue for security vulnerabilities.

## What this plugin touches

`opencode-notify` reads three environment variables and sends notifications. It has **no runtime dependencies** and does not read your OpenCode configuration files.

| Input | Used for | Notes |
| --- | --- | --- |
| `OPENCODE_NTFY_TOPIC` | Building the ntfy.sh URL | Sent only in the request URL path. Never in headers or body. |
| `OPENCODE_REMOTE_URL` | A tappable "open" link | Sanitized before use. |
| `OPENCODE_NTFY_STATE_DIR` | Deduplication state | Defaults to `~/.config/opencode`. |

It does **not** read `OPENCODE_SERVER_PASSWORD`, and that value is never placed in any notification header or body.

## Sanitization guarantees

- **Topic isolation.** The topic is interpolated only into `https://ntfy.sh/<topic>`. It is asserted absent from headers and body by tests in both suites.
- **URL sanitization.** `OPENCODE_REMOTE_URL` is parsed with `new URL()`; credentials, query string and hash are stripped, and only `http:`/`https:` protocols are accepted. Anything else is dropped.
- **Header encoding.** Titles pass through `encodeHeader()`, which applies RFC 2047 (`=?UTF-8?B?...?=`) whenever the value is not printable ASCII. This prevents non-ASCII text from breaking header parsing or injecting new headers.
- **Argument safety.** The macOS channel uses `execFile` with an argument array, never a shell string, so notification text cannot be interpreted as shell metacharacters.

## Deduplication state

Claim records are stored under `$OPENCODE_NTFY_STATE_DIR/ntfy-seen/`:

- Directory mode `0700`, file mode `0600`.
- Filenames are `SHA-256(dedup key)`. The key is derived from the event id, the session id and the event type — never from the topic, a message body or a URL.
- Files are empty; they record only that an event was delivered.
- Records are swept after 7 days.

Both `session.execution.succeeded` and `session.error` claim through this mechanism, so a run is reported exactly once regardless of how many plugin instances receive the event.

Because the state directory may be shared with the pre-0.1.0 plugin, the default location is unchanged so an upgrade does not re-notify already-seen runs.

## Failure mode

Every network call and process spawn is wrapped so that a notification failure can never affect OpenCode. If ntfy is unreachable, `terminal-notifier` is missing, or an event is malformed, the plugin returns silently.

The plugin prefers a **duplicate** notification over a **missed** one. The fallback path for events without an id uses a time bucket, whose worst case at a bucket boundary is a duplicate — never a lost completion signal.

## Supported Versions

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |
| < 0.1.0 | ❌ |
