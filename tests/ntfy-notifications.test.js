import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createNotificationHandler, NtfyNotifications, resolveTerminalNotifier, resolveClaimDir } from "../plugins/ntfy-notifications.js"
import plugin from "../plugins/ntfy-notifications.js"

function event(type, properties = {}, id) {
  return { type, properties, ...(id ? { id } : {}) }
}

// OpenCode v2 events carry their payload under `data` (v1 used `properties`).
function v2event(type, data = {}, id) {
  return { type, data, ...(id ? { id } : {}) }
}

function harness(options = {}) {
  const calls = []
  const handler = createNotificationHandler({
    topic: options.topic ?? "test-topic",
    projectName: "test-project",
    fetchImpl: options.fetchImpl ?? (async (url, init) => calls.push({ url, init })),
    timeoutMs: 20,
    execFileImpl: options.execFileImpl ?? (() => {}),
    // Default to a throwaway dir: several events now claim through the
    // lockfile, and without this the suite would write into the real
    // ~/.config/opencode/ntfy-seen and interfere with a live installation.
    claimDir: options.claimDir ?? tmpClaimDir(),
    now: options.now,
  })
  return { calls, handler }
}

function tmpClaimDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ntfy-claim-"))
}

test("plugin initializes without a topic", async () => {
  const previous = process.env.OPENCODE_NTFY_TOPIC
  delete process.env.OPENCODE_NTFY_TOPIC
  try {
    const hooks = await NtfyNotifications({ project: {}, directory: "/tmp/demo", worktree: "/tmp/demo" })
    await hooks.event({ event: event("session.idle", { sessionID: "s1" }) })
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_NTFY_TOPIC
    else process.env.OPENCODE_NTFY_TOPIC = previous
  }
})

test("permission asked is deduplicated and reply clears pending state", async () => {
  const { calls, handler } = harness()
  const asked = event("permission.asked", { id: "p1", sessionID: "s1" }, "e1")
  await handler({ event: asked })
  await handler({ event: asked })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers.Priority, "high")

  await handler({ event: event("session.idle", { sessionID: "s1" }) })
  assert.equal(calls.length, 1)
  await handler({ event: event("permission.replied", { requestID: "p1", sessionID: "s1" }) })
  await handler({ event: event("session.status", { sessionID: "s1", status: { type: "busy" } }) })
  await handler({ event: event("session.idle", { sessionID: "s1" }) })
  assert.equal(calls.length, 2)
})

test("question asked emits one interaction notification", async () => {
  const { calls, handler } = harness()
  const asked = event("question.asked", { id: "q1", sessionID: "s1" }, "e1")
  await handler({ event: asked })
  await handler({ event: asked })
  assert.equal(calls.length, 1)
  assert.match(calls[0].init.body, /respuesta o selección/)
})

test("normal idle is deduplicated and a new busy cycle resets it", async () => {
  const { calls, handler } = harness()
  await handler({ event: event("session.status", { sessionID: "s1", status: { type: "busy" } }) })
  await handler({ event: event("session.idle", { sessionID: "s1" }) })
  await handler({ event: event("session.idle", { sessionID: "s1" }) })
  assert.equal(calls.length, 1)
  await handler({ event: event("session.status", { sessionID: "s1", status: { type: "busy" } }) })
  await handler({ event: event("session.idle", { sessionID: "s1" }) })
  assert.equal(calls.length, 2)
  assert.match(calls[0].init.headers.Title, /^=\?UTF-8\?B\?/)
})

test("session error is deduplicated and suppresses completion for that run", async () => {
  const { calls, handler } = harness()
  const failed = event("session.error", { sessionID: "s1" }, "e1")
  await handler({ event: failed })
  await handler({ event: failed })
  await handler({ event: event("session.idle", { sessionID: "s1" }) })
  assert.equal(calls.length, 1)
  assert.match(calls[0].init.body, /error de sesión/)
})

test("network errors are swallowed", async () => {
  const { handler } = harness({ fetchImpl: async () => { throw new Error("offline") } })
  await assert.doesNotReject(handler({ event: event("session.idle", { sessionID: "s1" }) }))
})

test("topic appears only in the request URL and never in payload or headers", async () => {
  const { calls, handler } = harness({ topic: "private-topic-marker" })
  await handler({ event: event("session.status", { sessionID: "s1", status: { type: "busy" } }) })
  await handler({ event: event("session.idle", { sessionID: "s1" }) })
  assert.equal(JSON.stringify(calls[0].init).includes("private-topic-marker"), false)
})

// --- OpenCode v2 contract ---

test("v2 default export defines id + setup and subscribes with cleanup", async () => {
  assert.equal(plugin.id, "ntfy-notifications")
  assert.equal(typeof plugin.setup, "function")

  let subscribedWith
  let aborted = false
  const stream = {
    subscribe(options) {
      subscribedWith = options
      options.signal.addEventListener("abort", () => { aborted = true })
      // Yields one harmless busy event, then stays open until aborted.
      let sent = false
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (!sent) { sent = true; return { value: { type: "session.status", data: { sessionID: "s1", status: { type: "busy" } } }, done: false } }
              return new Promise(() => {})
            },
            async return() { return { done: true } },
          }
        },
      }
    },
  }

  const ctx = { location: { directory: "/tmp/demo", project: {} }, event: stream }
  const cleanup = plugin.setup(ctx)
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(subscribedWith && subscribedWith.signal instanceof AbortSignal)
  assert.equal(typeof cleanup, "function")
  cleanup()
  assert.equal(aborted, true)
})

// --- macOS channel ---

test("macOS channel invokes terminal-notifier with title/message/sound", async () => {
  const execs = []
  const handler = createNotificationHandler({
    topic: null,
    projectName: "test-project",
    fetchImpl: async () => {},
    execFileImpl: (binary, args) => execs.push({ binary, args }),
    notifierPath: "/opt/homebrew/bin/terminal-notifier",
    // Pin the platform: without it the handler inherits process.platform and
    // the macOS channel stays disabled on a Linux CI runner.
    platform: "darwin",
  })
  await handler({ event: event("session.status", { sessionID: "s1", status: { type: "busy" } }) })
  await handler({ event: event("session.idle", { sessionID: "s1" }) })
  assert.equal(execs.length, 1)
  assert.equal(execs[0].binary, "/opt/homebrew/bin/terminal-notifier")
  assert.ok(execs[0].args.includes("-title") && execs[0].args.includes("-message"))
  assert.deepEqual(execs[0].args.slice(-2), ["-sound", "default"])
})

test("resolveTerminalNotifier finds binary on PATH or falls back to name", () => {
  assert.equal(
    resolveTerminalNotifier({ pathEnv: "/opt/homebrew/bin", exists: (p) => p === "/opt/homebrew/bin/terminal-notifier" }),
    "/opt/homebrew/bin/terminal-notifier",
  )
  assert.equal(resolveTerminalNotifier({ pathEnv: "/nonexistent", exists: () => false }), "terminal-notifier")
})

// --- OpenCode v2 form events (replaced question.*) ---

test("v2 form.created notifies and form.replied clears the pending state", async () => {
  const { calls, handler } = harness()
  await handler({ event: { type: "form.created", data: { sessionID: "s1", id: "f1" } } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers.Priority, "high")
  assert.match(calls[0].init.body, /respuesta o selección/)

  // Pending form suppresses premature completion…
  await handler({ event: { type: "session.status", data: { sessionID: "s1", status: { type: "busy" } } } })
  await handler({ event: { type: "session.idle", data: { sessionID: "s1" } } })
  assert.equal(calls.length, 1)
  // …and replying re-enables the completion notification.
  await handler({ event: { type: "form.replied", data: { sessionID: "s1", id: "f1" } } })
  await handler({ event: { type: "session.status", data: { sessionID: "s1", status: { type: "busy" } } } })
  await handler({ event: { type: "session.idle", data: { sessionID: "s1" } } })
  assert.equal(calls.length, 2)
})

// --- OpenCode v2 form contract, as actually shipped ---
//
// OpenCode 2.0.20 emits `form.created` NESTED: `data.form.id` and
// `data.form.sessionID`. The reply/cancel events carry them FLAT:
// `data.id` and `data.sessionID`. Verified against the shipped binary,
// which resolves the session with its own special case:
//   if (e.type === "form.created") return e.data.form.sessionID
// Reading `data.sessionID` directly put every form in the "unknown" bucket,
// which both failed to suppress the owning session's completion and leaked
// pending state into unrelated sessions.

test("v2 form.created (nested shape) suppresses its OWN session's completion", async () => {
  const { calls, handler } = harness()
  await handler({ event: { type: "session.status", data: { sessionID: "ses_D", status: { type: "busy" } } } })
  await handler({
    event: { type: "form.created", id: "e3", data: { form: { id: "f3", sessionID: "ses_D" } } },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers.Priority, "high")
  assert.match(calls[0].init.body, /respuesta o selección/)

  await handler({ event: { type: "session.status", data: { sessionID: "ses_D", status: { type: "idle" } } } })
  assert.equal(calls.length, 1, "no premature completion while the form is pending")
})

test("v2 form.replied (flat shape) clears the nested form.created pending state", async () => {
  const { calls, handler } = harness()
  await handler({ event: { type: "session.status", data: { sessionID: "ses_E", status: { type: "busy" } } } })
  await handler({
    event: { type: "form.created", id: "e4", data: { form: { id: "f4", sessionID: "ses_E" } } },
  })
  await handler({ event: { type: "form.replied", data: { sessionID: "ses_E", id: "f4" } } })
  await handler({ event: { type: "session.status", data: { sessionID: "ses_E", status: { type: "busy" } } } })
  await handler({ event: { type: "session.idle", data: { sessionID: "ses_E" } } })
  assert.equal(calls.length, 2, "ask, then completion once answered")
})

test("v2 form.cancelled (flat shape) clears the nested form.created pending state", async () => {
  const { calls, handler } = harness()
  await handler({ event: { type: "session.status", data: { sessionID: "ses_F", status: { type: "busy" } } } })
  await handler({
    event: { type: "form.created", id: "e5", data: { form: { id: "f5", sessionID: "ses_F" } } },
  })
  await handler({ event: { type: "form.cancelled", data: { sessionID: "ses_F", id: "f5" } } })
  await handler({ event: { type: "session.status", data: { sessionID: "ses_F", status: { type: "busy" } } } })
  await handler({ event: { type: "session.idle", data: { sessionID: "ses_F" } } })
  assert.equal(calls.length, 2)
})

test("regression: a pending form must not block an UNRELATED session's completion", async () => {
  const { calls, handler } = harness()
  await handler({ event: { type: "session.status", data: { sessionID: "ses_A", status: { type: "busy" } } } })
  await handler({
    event: { type: "form.created", id: "e1", data: { form: { id: "f1", sessionID: "ses_A" } } },
  })
  // ses_B is unrelated and healthy; it must still get its completion.
  await handler({ event: { type: "session.status", data: { sessionID: "ses_B", status: { type: "busy" } } } })
  await handler({ event: { type: "session.idle", data: { sessionID: "ses_B" } } })
  assert.equal(calls.length, 2)
})

test("regression: a form without sessionID must not poison a real session", async () => {
  const { calls, handler } = harness()
  await handler({
    event: { type: "form.created", id: "e2", data: { form: { id: "f2", sessionID: undefined } } },
  })
  await handler({ event: { type: "session.status", data: { sessionID: "ses_C", status: { type: "busy" } } } })
  await handler({ event: { type: "session.idle", data: { sessionID: "ses_C" } } })
  assert.equal(calls.length, 2)
})

test("v2 permission.asked/replied still match under the verified shapes", async () => {
  const { calls, handler } = harness()
  await handler({ event: { type: "permission.asked", id: "pe1", data: { id: "p1", sessionID: "s1" } } })
  await handler({ event: { type: "permission.replied", id: "pe2", data: { sessionID: "s1", requestID: "p1" } } })
  await handler({ event: { type: "session.status", data: { sessionID: "s1", status: { type: "busy" } } } })
  await handler({ event: { type: "session.idle", data: { sessionID: "s1" } } })
  assert.equal(calls.length, 2, "permission ask, then completion")
})

// --- OpenCode v2 execution completion (atomic lockfile claim) ---

test("v2 execution.succeeded notifies exactly once, generic title", async () => {
  const { calls, handler } = harness({ claimDir: tmpClaimDir() })
  await handler({ event: v2event("session.execution.succeeded", { sessionID: "s1" }, "exec-1") })
  assert.equal(calls.length, 1)
  assert.match(calls[0].init.headers.Title, /Trabajo terminado|utf-8/i)
  assert.equal(calls[0].init.body.includes("test-project"), false)
})

test("v2 same event.id repeated notifies once", async () => {
  const dir = tmpClaimDir()
  const { calls, handler } = harness({ claimDir: dir })
  const done = v2event("session.execution.succeeded", { sessionID: "s1" }, "same-id")
  await handler({ event: done })
  await handler({ event: done })
  await handler({ event: done })
  assert.equal(calls.length, 1)
})

test("v2 20 simultaneous instances collapse to one notification", async () => {
  const dir = tmpClaimDir()
  const hs = Array.from({ length: 20 }, () => harness({ claimDir: dir }))
  const done = v2event("session.execution.succeeded", { sessionID: "s1" }, "fanout-id")
  await Promise.all(hs.map((h) => h.handler({ event: done })))
  const total = hs.reduce((n, h) => n + h.calls.length, 0)
  assert.equal(total, 1)
})

test("v2 successive executions notify once each", async () => {
  const { calls, handler } = harness({ claimDir: tmpClaimDir() })
  await handler({ event: v2event("session.execution.succeeded", { sessionID: "s1" }, "run-1") })
  await handler({ event: v2event("session.execution.succeeded", { sessionID: "s1" }, "run-2") })
  assert.equal(calls.length, 2)
})

test("v2 execution.succeeded without started still notifies", async () => {
  const { calls, handler } = harness({ claimDir: tmpClaimDir() })
  await handler({ event: v2event("session.execution.succeeded", { sessionID: "s1" }, "no-started") })
  assert.equal(calls.length, 1)
})

test("v2 execution.succeeded without id still notifies (bucket fallback)", async () => {
  const { calls, handler } = harness({ claimDir: tmpClaimDir(), now: () => 1_000_000 })
  await assert.doesNotReject(handler({ event: { type: "session.execution.succeeded", data: { sessionID: "s1" } } }))
  assert.equal(calls.length, 1)
})

test("v2 execution.succeeded with non-string id still notifies", async () => {
  const { calls, handler } = harness({ claimDir: tmpClaimDir(), now: () => 1_000_000 })
  await assert.doesNotReject(handler({ event: { type: "session.execution.succeeded", data: { sessionID: "s1" }, id: 123 } }))
  assert.equal(calls.length, 1)
})

test("v2 unidentified events in the same bucket collapse to one notification", async () => {
  const dir = tmpClaimDir()
  const hs = Array.from({ length: 10 }, () => harness({ claimDir: dir, now: () => 1_000_000 }))
  const done = { type: "session.execution.succeeded", data: { sessionID: "s1" } }
  await Promise.all(hs.map((h) => h.handler({ event: done })))
  const total = hs.reduce((n, h) => n + h.calls.length, 0)
  assert.equal(total, 1)
})

test("v2 unidentified events in different buckets each notify", async () => {
  const dir = tmpClaimDir()
  let clock = 1_000_000
  const { calls, handler } = harness({ claimDir: dir, now: () => clock })
  const done = { type: "session.execution.succeeded", data: { sessionID: "s1" } }
  await handler({ event: done })
  clock += 3_000
  await handler({ event: done })
  assert.equal(calls.length, 2)
})

// --- regression: losing instances must not emit a second completion ---

test("regression: claim losers do not re-notify via the legacy idle path", async () => {
  const dir = tmpClaimDir()
  const winner = harness({ claimDir: dir })
  const loser = harness({ claimDir: dir })
  const busy = v2event("session.status", { sessionID: "s1", status: { type: "busy" } })
  const done = v2event("session.execution.succeeded", { sessionID: "s1" }, "shared-id")

  // Both instances observed the same turn, so both have `hadBusy` set.
  await winner.handler({ event: busy })
  await loser.handler({ event: busy })

  await winner.handler({ event: done })
  await loser.handler({ event: done })
  assert.equal(winner.calls.length, 1, "claim winner notifies once")
  assert.equal(loser.calls.length, 0, "claim loser must not notify")

  // A late `session.status idle` reaches every instance; the loser must stay
  // silent because the run already reported completion.
  await winner.handler({ event: v2event("session.status", { sessionID: "s1", status: { type: "idle" } }) })
  await loser.handler({ event: v2event("session.status", { sessionID: "s1", status: { type: "idle" } }) })

  assert.equal(winner.calls.length, 1)
  assert.equal(loser.calls.length, 0, "losing instance must not emit a second completion")
})

test("regression: losing instances stay silent for session.idle too", async () => {
  const dir = tmpClaimDir()
  const winner = harness({ claimDir: dir })
  const loser = harness({ claimDir: dir })
  const busy = v2event("session.status", { sessionID: "s1", status: { type: "busy" } })
  const done = v2event("session.execution.succeeded", { sessionID: "s1" }, "shared-id-2")

  await winner.handler({ event: busy })
  await loser.handler({ event: busy })
  await winner.handler({ event: done })
  await loser.handler({ event: done })
  await winner.handler({ event: v2event("session.idle", { sessionID: "s1" }) })
  await loser.handler({ event: v2event("session.idle", { sessionID: "s1" }) })

  assert.equal(winner.calls.length, 1)
  assert.equal(loser.calls.length, 0)
})

test("regression: exactly one notification total per finished execution across instances", async () => {
  const dir = tmpClaimDir()
  const winner = harness({ claimDir: dir })
  const loser = harness({ claimDir: dir })
  const busy = v2event("session.status", { sessionID: "s1", status: { type: "busy" } })
  const done = v2event("session.execution.succeeded", { sessionID: "s1" }, "shared-id-3")

  await winner.handler({ event: busy })
  await loser.handler({ event: busy })
  await winner.handler({ event: done })
  await loser.handler({ event: done })

  // The old ordering claimed first and returned early, leaving the loser free
  // to notify again from the legacy path. Exactly one notification per run.
  assert.equal(winner.calls.length + loser.calls.length, 1)
})

test("regression: a later run still notifies the legacy path after an execution claim", async () => {
  const { calls, handler } = harness({ claimDir: tmpClaimDir() })
  await handler({ event: v2event("session.execution.succeeded", { sessionID: "s1" }, "run-1") })
  // New turn: busy resets the run, then idle must notify again.
  await handler({ event: v2event("session.status", { sessionID: "s1", status: { type: "busy" } }) })
  await handler({ event: v2event("session.idle", { sessionID: "s1" }) })
  assert.equal(calls.length, 2)
})

// --- regression: later errors must not be silenced forever ---

test("regression: an unidentified error burst collapses to one notification", async () => {
  const { calls, handler } = harness({ now: () => 1_000_000 })
  await handler({ event: { type: "session.error", data: { sessionID: "s1" } } })
  // Same bucket: a burst of identical unidentified errors collapses.
  await handler({ event: { type: "session.error", data: { sessionID: "s1" } } })
  await handler({ event: { type: "session.error", data: { sessionID: "s1" } } })
  assert.equal(calls.length, 1)
})

test("regression: later errors notify again once the error bucket rolls over", async () => {
  let clock = 1_000_000
  const { calls, handler } = harness({ now: () => clock })
  await handler({ event: { type: "session.error", data: { sessionID: "s1" } } })
  assert.equal(calls.length, 1)
  clock += 31_000
  await handler({ event: { type: "session.error", data: { sessionID: "s1" } } })
  assert.equal(calls.length, 2, "a later distinct failure must not stay silenced")
})

test("regression: errors carrying an id keep exact per-id dedup", async () => {
  const { calls, handler } = harness({ now: () => 1_000_000 })
  const first = { type: "session.error", data: { sessionID: "s1" }, id: "err-1" }
  await handler({ event: first })
  await handler({ event: first })
  assert.equal(calls.length, 1)
  // Different id, same run: distinct failure, must notify.
  await handler({ event: { type: "session.error", data: { sessionID: "s1" }, id: "err-2" } })
  assert.equal(calls.length, 2)
})

test("regression: errors from different sessions are independent", async () => {
  const { calls, handler } = harness({ now: () => 1_000_000 })
  await handler({ event: { type: "session.error", data: { sessionID: "s1" } } })
  await handler({ event: { type: "session.error", data: { sessionID: "s2" } } })
  assert.equal(calls.length, 2)
})

// --- regression: session.error must deduplicate across instances ---
//
// Errors previously relied on `remember()`, which is per-instance in-memory
// state. Every plugin instance therefore emitted its own notification for the
// same failure, whether or not the event carried an id.

test("regression: session.error with an id notifies once across instances", async () => {
  const dir = tmpClaimDir()
  const a = harness({ claimDir: dir })
  const b = harness({ claimDir: dir })
  const err = { type: "session.error", id: "err-1", data: { sessionID: "s1" } }
  await a.handler({ event: err })
  await b.handler({ event: err })
  assert.equal(a.calls.length + b.calls.length, 1)
})

test("regression: session.error WITHOUT an id notifies once across instances", async () => {
  const dir = tmpClaimDir()
  const a = harness({ claimDir: dir, now: () => 1_000_000 })
  const b = harness({ claimDir: dir, now: () => 1_000_000 })
  const err = { type: "session.error", data: { sessionID: "s1" } }
  await a.handler({ event: err })
  await b.handler({ event: err })
  assert.equal(a.calls.length + b.calls.length, 1)
})

test("regression: 20 simultaneous instances agree on one session.error", async () => {
  const dir = tmpClaimDir()
  const hs = Array.from({ length: 20 }, () => harness({ claimDir: dir, now: () => 1_000_000 }))
  const err = { type: "session.error", data: { sessionID: "s1" } }
  await Promise.all(hs.map((h) => h.handler({ event: err })))
  const total = hs.reduce((n, h) => n + h.calls.length, 0)
  assert.equal(total, 1)
})

test("regression: a later distinct error still notifies after the claim", async () => {
  let clock = 1_000_000
  const { calls, handler } = harness({ claimDir: tmpClaimDir(), now: () => clock })
  await handler({ event: { type: "session.error", data: { sessionID: "s1" } } })
  clock += 31_000
  await handler({ event: { type: "session.error", data: { sessionID: "s1" } } })
  assert.equal(calls.length, 2, "the claim must not permanently silence later errors")
})

test("regression: errors from different sessions claim independently", async () => {
  const dir = tmpClaimDir()
  const { calls, handler } = harness({ claimDir: dir, now: () => 1_000_000 })
  await handler({ event: { type: "session.error", data: { sessionID: "s1" } } })
  await handler({ event: { type: "session.error", data: { sessionID: "s2" } } })
  assert.equal(calls.length, 2)
})

test("regression: the suite never writes into the real claim directory", async () => {
  // Several events claim through the lockfile now. If a harness ever omits
  // `claimDir`, the suite would silently write into the live
  // ~/.config/opencode/ntfy-seen and could swallow a real user's notification.
  const realDir = resolveClaimDir()
  const realBefore = fs.existsSync(realDir) ? fs.readdirSync(realDir).sort() : null

  // Both instances must share one claim directory, exactly as multiple
  // plugin instances do on a real host.
  const shared = tmpClaimDir()
  const a = harness({ claimDir: shared })
  const b = harness({ claimDir: shared })
  const done = v2event("session.execution.succeeded", { sessionID: "s1" }, "guard-id")
  await a.handler({ event: done })
  await b.handler({ event: done })
  assert.equal(a.calls.length + b.calls.length, 1)

  // The harness must have claimed somewhere other than the live directory.
  const claimed = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("ntfy-claim-"))
  assert.ok(claimed.length > 0, "harness should claim into a temp dir")

  if (realBefore !== null) {
    const realAfter = fs.readdirSync(realDir).sort()
    assert.deepEqual(realAfter, realBefore, "real claim directory must be untouched")
  }
})

test("resolveClaimDir honours OPENCODE_NTFY_STATE_DIR", () => {
  assert.equal(
    resolveClaimDir({ OPENCODE_NTFY_STATE_DIR: "/custom/state" }, "/synthetic-home/x"),
    "/custom/state/ntfy-seen",
  )
  assert.equal(
    resolveClaimDir({ OPENCODE_NTFY_STATE_DIR: "  " }, "/synthetic-home/x"),
    path.join("/synthetic-home/x", ".config", "opencode", "ntfy-seen"),
  )
  assert.equal(
    resolveClaimDir({}, "/synthetic-home/x"),
    path.join("/synthetic-home/x", ".config", "opencode", "ntfy-seen"),
  )
})

test("resolveClaimDir output is derived only from the supplied home", () => {
  const home = path.join(path.sep, "home", "someone")
  const dir = resolveClaimDir({}, home)
  assert.ok(dir.startsWith(home + path.sep))
  assert.equal(path.isAbsolute(dir), true)
  assert.equal(dir.endsWith(path.join("ntfy-seen")), true)
})

test("claim records are swept by age without touching recent ones", async () => {
  const dir = tmpClaimDir()
  const oldFile = path.join(dir, "old")
  const recentFile = path.join(dir, "recent")
  fs.writeFileSync(oldFile, "")
  fs.writeFileSync(recentFile, "")
  const past = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
  fs.utimesSync(oldFile, past, past)

  const { handler } = harness({ claimDir: dir })
  await handler({ event: v2event("session.execution.succeeded", { sessionID: "s1" }, "sweep-id") })

  assert.equal(fs.existsSync(oldFile), false, "old record should be swept")
  assert.equal(fs.existsSync(recentFile), true, "recent record must be kept")
})
