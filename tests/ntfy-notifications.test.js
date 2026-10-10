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
    claimDir: options.claimDir,
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

// --- regression: portable state dir ---

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
