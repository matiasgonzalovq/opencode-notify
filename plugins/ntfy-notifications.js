import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execFile as defaultExecFile } from "node:child_process"

const DEFAULT_TIMEOUT_MS = 2500
const MAX_REMEMBERED_EVENTS = 512

// One finished execution is delivered to every per-location plugin instance.
// Claim it exactly once with an atomic lockfile keyed by the event id, so no
// in-memory state (which is per instance) is required.
//
// Claim records are state, not source: they live outside this plugin and never
// inside a checkout. Override with OPENCODE_NTFY_STATE_DIR; the default keeps
// the pre-0.1.0 location so upgrading does not re-notify already seen runs.
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function resolveClaimDir(env = process.env, home = os.homedir()) {
  const override = typeof env.OPENCODE_NTFY_STATE_DIR === "string" ? env.OPENCODE_NTFY_STATE_DIR.trim() : ""
  const base = override || path.join(home, ".config", "opencode")
  return path.join(base, "ntfy-seen")
}

// An event without an id cannot be claimed by hash. Rather than dropping the
// notification (silently losing the one signal the user cares about), fall
// back to a short time bucket: bursts inside one run collapse, later runs notify
// again. The worst case of a bucket-boundary race is a duplicate notification,
// never a missed one.
const NO_ID_CLAIM_BUCKET_MS = 2000
const NO_ID_ERROR_BUCKET_MS = 30 * 1000

function idOf(value) {
  return typeof value === "string" && value.length > 0 ? value : null
}

function bucketedKey(prefix, sessionKey, bucketMs, now) {
  return `${prefix}:${sessionKey}:${Math.floor((typeof now === "function" ? now() : Date.now()) / bucketMs)}`
}

function sweepClaims(dir) {
  try {
    const now = Date.now()
    for (const entry of fs.readdirSync(dir)) {
      try {
        const file = path.join(dir, entry)
        if (now - fs.statSync(file).mtimeMs > CLAIM_TTL_MS) fs.unlinkSync(file)
      } catch {
        // A concurrently removed entry must not break the sweep.
      }
    }
  } catch {
    // Sweeping is best-effort.
  }
}

function claimEventOnce(eventId, claimDir) {
  if (typeof eventId !== "string" || eventId.length === 0) return false
  const dir = claimDir || resolveClaimDir()
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(dir, 0o700) } catch {}
    const name = crypto.createHash("sha256").update(eventId).digest("hex")
    const file = path.join(dir, name)
    try {
      fs.closeSync(fs.openSync(file, "wx", 0o600))
    } catch (error) {
      if (error && error.code === "EEXIST") return false
      return false
    }
    sweepClaims(dir)
    return true
  } catch {
    return false
  }
}

function encodeHeader(value) {
  if (/^[\x20-\x7e]*$/.test(value)) return value
  const encoded = Buffer.from(value, "utf8").toString("base64")
  return `=?UTF-8?B?${encoded}?=`
}

const KNOWN_NOTIFIER_PATHS = [
  "/opt/homebrew/bin/terminal-notifier",
  "/usr/local/bin/terminal-notifier",
  "/opt/local/bin/terminal-notifier",
]

let cachedNotifierPath

export function resolveTerminalNotifier({ pathEnv, exists } = {}) {
  if (cachedNotifierPath && !pathEnv && !exists) return cachedNotifierPath
  const check = exists || ((candidate) => fs.existsSync(candidate))
  const dirs = String(pathEnv ?? process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const candidates = [
    ...dirs.map((dir) => `${dir}/terminal-notifier`),
    ...KNOWN_NOTIFIER_PATHS,
  ]
  for (const candidate of candidates) {
    try {
      if (check(candidate)) {
        if (!pathEnv && !exists) cachedNotifierPath = candidate
        return candidate
      }
    } catch {}
  }
  return "terminal-notifier"
}

function sendMacOSNotification({ title, message, remoteUrl, execFileImpl, notifierPath, platform }) {
  if ((platform ?? process.platform) !== "darwin") return
  try {
    const execFile = execFileImpl || defaultExecFile
    const args = [
      "-title", title,
      "-message", message,
      "-sound", "default",
    ]
    if (remoteUrl) {
      const chromeUrl = toChromeIosUrl(remoteUrl)
      if (chromeUrl) {
        args.push("-open", chromeUrl)
      }
    }
    const binary = notifierPath || resolveTerminalNotifier()
    execFile(binary, args, { timeout: 5000 }, () => {
      // Best-effort: notification failures must never affect OpenCode.
    })
  } catch {
    // Best-effort: notification failures must never affect OpenCode.
  }
}

function safeProjectName(input) {
  const candidate = input.project?.name || input.worktree || input.directory || "OpenCode"
  const name = candidate.split(/[\\/]/).filter(Boolean).at(-1) || "OpenCode"
  return name.replace(/[\r\n\t]/g, " ").slice(0, 80)
}

// V1 events carry `properties`; V2 events carry `data`. Accept both.
function payloadOf(event) {
  return event?.properties ?? event?.data ?? event ?? {}
}

// `form.created` is the one event that nests its payload: OpenCode ships
// `data.form.sessionID` and `data.form.id`, while the reply/cancel events
// carry them flat as `data.sessionID` and `data.id`. Read the official
// extractor shape, otherwise every form lands in the "unknown" bucket and
// leaks its pending state into unrelated sessions.
function sessionID(event) {
  const payload = payloadOf(event)
  return payload?.sessionID || payload?.form?.sessionID || "unknown"
}

function requestID(event) {
  const payload = payloadOf(event)
  return (
    payload?.form?.id ||
    payload?.id ||
    payload?.requestID ||
    payload?.permissionID ||
    event?.id
  )
}

function getRemoteUrl() {
  const raw = process.env.OPENCODE_REMOTE_URL
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

function toChromeIosUrl(httpsUrl) {
  if (!httpsUrl) return null
  try {
    const url = new URL(httpsUrl)
    if (url.protocol === "https:") {
      return `googlechromes://${url.host}${url.pathname}${url.search}${url.hash}`
    }
    return httpsUrl
  } catch {
    return null
  }
}

function buildActionsHeader(remoteUrl) {
  if (!remoteUrl) return undefined
  const chromeUrl = toChromeIosUrl(remoteUrl)
  const targetUrl = chromeUrl || remoteUrl
  return `view, Abrir OpenCode en Chrome, ${targetUrl}`
}

function sanitizeRemoteUrl(input) {
  if (!input) return null
  const trimmed = String(input).trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

export function createNotificationHandler({
  topic,
  projectName,
  remoteUrl: rawRemoteUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  execFileImpl,
  notifierPath,
  platform,
  claimDir,
  now = Date.now,
}) {
  const remoteUrl = sanitizeRemoteUrl(rawRemoteUrl)
  const sessions = new Map()
  const remembered = new Set()

  const stateFor = (id) => {
    if (!sessions.has(id)) {
      sessions.set(id, {
        permissions: new Set(),
        questions: new Set(),
        waitingForResume: false,
        idleNotified: false,
        errorInRun: false,
        hadBusy: false,
      })
    }
    return sessions.get(id)
  }

  const remember = (key) => {
    if (remembered.has(key)) return false
    remembered.add(key)
    if (remembered.size > MAX_REMEMBERED_EVENTS) {
      remembered.delete(remembered.values().next().value)
    }
    return true
  }

  const send = async ({ title, message, priority, remoteUrl }) => {
    sendMacOSNotification({ title, message, remoteUrl, execFileImpl, notifierPath, platform })
    if (!topic || typeof fetchImpl !== "function") return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers = {
        "Content-Type": "text/plain; charset=utf-8",
        Title: encodeHeader(title),
      }
      if (priority) headers.Priority = priority
      const chromeUrl = toChromeIosUrl(remoteUrl)
      if (chromeUrl) headers.Click = chromeUrl
      const actions = buildActionsHeader(remoteUrl)
      if (actions) headers.Actions = actions
      await fetchImpl(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: "POST",
        headers,
        body: message,
        signal: controller.signal,
      })
    } catch {
      // Notifications are best-effort and must never affect OpenCode.
    } finally {
      clearTimeout(timer)
    }
  }

  const title = (fallback) =>
    projectName && projectName !== "OpenCode" ? `OpenCode — ${projectName}` : fallback

  const handleSessionIdle = async (id, source) => {
    const state = stateFor(id)
    if (!state.hadBusy) return
    if (
      state.permissions.size > 0 ||
      state.questions.size > 0 ||
      state.waitingForResume ||
      state.errorInRun ||
      state.idleNotified
    ) return
    state.idleNotified = true
    await send({
      title: title("OpenCode — Trabajo terminado"),
      message: projectName && projectName !== "OpenCode"
        ? `OpenCode (${projectName}) terminó y ya puedes revisar el resultado.`
        : "OpenCode terminó y ya puedes revisar el resultado.",
      remoteUrl,
    })
  }

  return async ({ event }) => {
    try {
      const id = sessionID(event)
      const state = stateFor(id)

      switch (event?.type) {
        // OpenCode v2 completion signal. The same event reaches every
        // per-location instance; claimEventOnce collapses them to one.
        case "session.execution.started": {
          return
        }

        case "session.execution.succeeded": {
          // Suppress the legacy idle path for this run in EVERY instance, not
          // only in the one that wins the claim. Instances that lose the claim
          // used to return early with idleNotified still false, so a later
          // `session.status idle` emitted a second "Trabajo terminado".
          state.idleNotified = true
          const key = idOf(event?.id) || bucketedKey("exec", id, NO_ID_CLAIM_BUCKET_MS, now)
          if (!claimEventOnce(key, claimDir)) return
          await send({
            title: "OpenCode — Trabajo terminado",
            message: "OpenCode terminó y ya puedes revisar el resultado.",
            remoteUrl,
            kind: "execution",
          })
          return
        }

        case "session.status": {
          const statusType = payloadOf(event)?.status?.type
          if (statusType === "busy") {
            state.hadBusy = true
            state.idleNotified = false
            state.errorInRun = false
            if (state.permissions.size === 0 && state.questions.size === 0) {
              state.waitingForResume = false
            }
          } else if (statusType === "idle") {
            await handleSessionIdle(id, "session.status")
          }
          return
        }

        case "permission.asked": {
          const request = requestID(event)
          const key = `permission:${id}:${request || event.id || "unknown"}`
          if (request) state.permissions.add(request)
          state.waitingForResume = true
          if (!remember(key)) return
          await send({
            title: "OpenCode — Necesita autorización",
            message: projectName && projectName !== "OpenCode"
              ? `OpenCode (${projectName}) está esperando que apruebes o rechaces una acción.`
              : "OpenCode está esperando que apruebes o rechaces una acción.",
            priority: "high",
            remoteUrl,
          })
          return
        }

        case "permission.replied": {
          const request = requestID(event)
          if (request) state.permissions.delete(request)
          return
        }

        case "question.asked": {
          const request = requestID(event)
          const key = `question:${id}:${request || event.id || "unknown"}`
          if (request) state.questions.add(request)
          state.waitingForResume = true
          if (!remember(key)) return
          await send({
            title: "OpenCode — Necesita tu respuesta",
            message: projectName && projectName !== "OpenCode"
              ? `OpenCode (${projectName}) está esperando una respuesta o selección para continuar.`
              : "OpenCode está esperando una respuesta o selección para continuar.",
            priority: "high",
            remoteUrl,
          })
          return
        }

        case "question.replied":
        case "question.rejected": {
          const request = requestID(event)
          if (request) state.questions.delete(request)
          return
        }

        // OpenCode v2 replaced `question.*` with form events.
        case "form.created": {
          const request = requestID(event)
          const key = `form:${id}:${request || event.id || "unknown"}`
          if (request) state.questions.add(request)
          state.waitingForResume = true
          if (!remember(key)) return
          await send({
            title: "OpenCode — Necesita tu respuesta",
            message: projectName && projectName !== "OpenCode"
              ? `OpenCode (${projectName}) está esperando una respuesta o selección para continuar.`
              : "OpenCode está esperando una respuesta o selección para continuar.",
            priority: "high",
            remoteUrl,
          })
          return
        }

        case "form.replied":
        case "form.cancelled": {
          const request = requestID(event)
          if (request) state.questions.delete(request)
          return
        }

        case "session.error": {
          state.errorInRun = true
          state.idleNotified = true
          // The pre-0.1.0 key fell back to the constant "current-run", which
          // `remember()` never releases: only the first error of a session ever
          // notified, and every later error was silenced forever. Identified
          // events keep their exact key; unidentified ones bucket by run so a
          // new failure later on notifies again.
          const rawId = idOf(event?.id)
          const key = rawId
            ? `error:${id}:${rawId}`
            : bucketedKey("error", id, NO_ID_ERROR_BUCKET_MS, now)
          if (!remember(key)) return
          // `remember()` is per-instance, so a shared claim is still required:
          // the same failure reaches every plugin instance, and without this
          // each of them would emit its own notification.
          if (!claimEventOnce(key, claimDir)) return
          await send({
            title: "OpenCode — Error",
            message: projectName && projectName !== "OpenCode"
              ? `OpenCode (${projectName}) encontró un error de sesión. Revisa la ejecución.`
              : "OpenCode encontró un error de sesión. Revisa la ejecución.",
            priority: "high",
            remoteUrl,
          })
          return
        }

        case "session.idle": {
          await handleSessionIdle(id, "session.idle")
          return
        }
      }
    } catch {
      // Malformed/unknown events must not affect the host process.
    }
  }
}

export const NtfyNotifications = async (input) => {
  const topic = process.env.OPENCODE_NTFY_TOPIC
  const projectName = safeProjectName(input)
  const remoteUrl = getRemoteUrl()
  return {
    event: createNotificationHandler({ topic, projectName, remoteUrl }),
  }
}

// OpenCode v2 plugin contract: default export { id, setup }.
// `setup` subscribes to the public event stream and returns a cleanup function.
export default {
  id: "ntfy-notifications",
  setup(ctx) {
    const controller = new AbortController()
    const handler = createNotificationHandler({
      topic: process.env.OPENCODE_NTFY_TOPIC,
      projectName: safeProjectName({
        project: ctx?.location?.project,
        directory: ctx?.location?.directory,
        worktree: ctx?.location?.directory,
      }),
      remoteUrl: getRemoteUrl(),
    })
    const stream = ctx?.event?.subscribe?.({ signal: controller.signal })
    if (stream) {
      void (async () => {
        try {
          for await (const event of stream) {
            await handler({ event })
          }
        } catch {
          // Cancellation or stream errors must never affect OpenCode.
        }
      })()
    }
    return () => controller.abort()
  },
}
