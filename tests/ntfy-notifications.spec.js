import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createNotificationHandler, resolveTerminalNotifier, resolveClaimDir } from "../plugins/ntfy-notifications.js"

vi.mock("node:child_process", () => ({
  execFile: vi.fn((binary, args, options, callback) => {
    if (typeof callback === "function") callback(null)
    return { unref: () => {} }
  }),
}))

const MOCK_TOPIC = "test_topic_12345"

function createMockFetch() {
  const calls = []
  const fetchImpl = vi.fn(async (url, options) => {
    calls.push({ url, options })
    return new Response("ok", { status: 200 })
  })
  return { fetchImpl, calls }
}

function createEvent(type, properties = {}) {
  return {
    type,
    id: "evt-" + Math.random().toString(36).slice(2, 10),
    properties,
  }
}

function decodeHeader(value) {
  if (!value) return value
  const match = value.match(/^=\?UTF-8\?B\?(.+)\?=$/)
  if (match) {
    return Buffer.from(match[1], "base64").toString("utf8")
  }
  return value
}

describe("ntfy-notifications", () => {
  let originalEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    process.env.OPENCODE_NTFY_TOPIC = MOCK_TOPIC
    delete process.env.OPENCODE_REMOTE_URL
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe("OPENCODE_REMOTE_URL", () => {
    it("includes 'Abrir OpenCode en Chrome' action with googlechromes:// when remoteUrl is provided", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
      const headers = calls[0].options.headers
      expect(headers.Actions).toBeDefined()
      expect(headers.Actions).toContain("Abrir OpenCode en Chrome")
      expect(headers.Actions).toContain("view")
      expect(headers.Actions).toContain("googlechromes://opencode.example.com")
    })

    it("does not include Actions header when remoteUrl is not provided", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
      const headers = calls[0].options.headers
      expect(headers.Actions).toBeUndefined()
    })

    it("strips credentials from remoteUrl", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://user:pass@opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
      const headers = calls[0].options.headers
      expect(headers.Actions).toBeDefined()
      expect(headers.Actions).not.toContain("user")
      expect(headers.Actions).not.toContain("pass")
      expect(headers.Actions).not.toContain("@")
    })

    it("strips query params and hash from remoteUrl", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com?token=secret#fragment",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
      const headers = calls[0].options.headers
      expect(headers.Actions).toBeDefined()
      expect(headers.Actions).not.toContain("token")
      expect(headers.Actions).not.toContain("secret")
      expect(headers.Actions).not.toContain("#")
      expect(headers.Actions).not.toContain("?")
    })
  })

  describe("Click header", () => {
    it("includes Click header with googlechromes:// when remoteUrl is provided", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
      const headers = calls[0].options.headers
      expect(headers.Click).toBeDefined()
      expect(headers.Click).toContain("googlechromes://opencode.example.com")
    })

    it("does not include Click header when remoteUrl is not provided", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
      const headers = calls[0].options.headers
      expect(headers.Click).toBeUndefined()
    })

    it("Click header strips credentials from remoteUrl", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://user:pass@opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
      const headers = calls[0].options.headers
      expect(headers.Click).toBeDefined()
      expect(headers.Click).not.toContain("user")
      expect(headers.Click).not.toContain("pass")
      expect(headers.Click).not.toContain("@")
    })

    it("Click header strips query params and hash from remoteUrl", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com?token=secret#fragment",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
      const headers = calls[0].options.headers
      expect(headers.Click).toBeDefined()
      expect(headers.Click).not.toContain("token")
      expect(headers.Click).not.toContain("secret")
      expect(headers.Click).not.toContain("#")
      expect(headers.Click).not.toContain("?")
    })

    it("Click header never contains OPENCODE_SERVER_PASSWORD", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "super-secret-password"
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
      const click = calls[0].options.headers.Click
      expect(click).toBeDefined()
      expect(click).not.toContain("super-secret-password")
      expect(click).not.toContain(process.env.OPENCODE_SERVER_PASSWORD)
    })

    it("Click header never contains OPENCODE_NTFY_TOPIC", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
      const click = calls[0].options.headers.Click
      expect(click).toBeDefined()
      expect(click).not.toContain(MOCK_TOPIC)
    })

    it("Click header uses same URL as Actions header", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
      const headers = calls[0].options.headers
      expect(headers.Click).toBeDefined()
      expect(headers.Actions).toBeDefined()
      const clickUrl = headers.Click
      const actionsUrl = headers.Actions.split(", ").pop()
      expect(clickUrl).toBe(actionsUrl)
    })
  })

  describe("security", () => {
    it("never includes OPENCODE_SERVER_PASSWORD in any header", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "super-secret-password"
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
      const allHeaders = JSON.stringify(calls[0].options.headers)
      expect(allHeaders).not.toContain("super-secret-password")
      expect(allHeaders).not.toContain(process.env.OPENCODE_SERVER_PASSWORD)
    })

    it("never includes OPENCODE_NTFY_TOPIC in payload or headers", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
      const body = calls[0].options.body
      const headers = JSON.stringify(calls[0].options.headers)
      expect(body).not.toContain(MOCK_TOPIC)
      expect(headers).not.toContain(MOCK_TOPIC)
      expect(calls[0].url).toContain(encodeURIComponent(MOCK_TOPIC))
    })

    it("URL in Actions header never contains credentials", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "OpenCode",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })
      await handler({ event: createEvent("session.idle", { sessionID: "s1" }) })

      expect(calls).toHaveLength(1)
      const actions = calls[0].options.headers.Actions
      expect(actions).toBeDefined()
      expect(actions).not.toContain("@")
      expect(actions).not.toContain("user")
      expect(actions).not.toContain("pass")
      expect(actions).not.toContain("token")
    })
  })

  describe("deduplication", () => {
    it("deduplicates permission.asked events", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })
      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })
      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
    })

    it("deduplicates question.asked events", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("question.asked", { sessionID: "s1", id: "q1" }) })
      await handler({ event: createEvent("question.asked", { sessionID: "s1", id: "q1" }) })

      expect(calls).toHaveLength(1)
    })

    it("deduplicates session.error events", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      const event1 = createEvent("session.error", { sessionID: "s1" })
      const event2 = createEvent("session.error", { sessionID: "s1" })
      event2.id = event1.id

      await handler({ event: event1 })
      await handler({ event: event2 })

      expect(calls).toHaveLength(1)
    })

    it("deduplicates session.idle events", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "OpenCode",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })
      await handler({ event: createEvent("session.idle", { sessionID: "s1" }) })
      await handler({ event: createEvent("session.idle", { sessionID: "s1" }) })

      expect(calls).toHaveLength(1)
    })
  })

  describe("error handling", () => {
    it("does not throw when fetch fails", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("Network error")
      })
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await expect(
        handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })
      ).resolves.not.toThrow()
    })

    it("does not throw when fetch returns error status", async () => {
      const fetchImpl = vi.fn(async () => new Response("error", { status: 500 }))
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await expect(
        handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })
      ).resolves.not.toThrow()
    })

    it("does not throw on malformed events", async () => {
      const { fetchImpl } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await expect(handler({ event: null })).resolves.not.toThrow()
      await expect(handler({ event: {} })).resolves.not.toThrow()
      await expect(handler({ event: { type: "unknown" } })).resolves.not.toThrow()
    })
  })

  describe("event types", () => {
    it("includes action for permission.asked", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls[0].options.headers.Actions).toContain("Abrir OpenCode en Chrome")
      expect(calls[0].options.headers.Actions).toContain("googlechromes://")
    })

    it("includes action for question.asked", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("question.asked", { sessionID: "s1", id: "q1" }) })

      expect(calls[0].options.headers.Actions).toContain("Abrir OpenCode en Chrome")
      expect(calls[0].options.headers.Actions).toContain("googlechromes://")
    })

    it("includes action for session.error", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("session.error", { sessionID: "s1" }) })

      expect(calls[0].options.headers.Actions).toContain("Abrir OpenCode en Chrome")
      expect(calls[0].options.headers.Actions).toContain("googlechromes://")
    })

    it("includes action for session.idle", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "OpenCode",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })
      await handler({ event: createEvent("session.idle", { sessionID: "s1" }) })

      expect(calls[0].options.headers.Actions).toContain("Abrir OpenCode en Chrome")
      expect(calls[0].options.headers.Actions).toContain("googlechromes://")
    })

    it("does not include action for permission.replied", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.replied", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(0)
    })

    it("does not include action for question.replied", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("question.replied", { sessionID: "s1", id: "q1" }) })

      expect(calls).toHaveLength(0)
    })

    it("does not include action for question.rejected", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("question.rejected", { sessionID: "s1", id: "q1" }) })

      expect(calls).toHaveLength(0)
    })

    it("does not include action for session.status", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })

      expect(calls).toHaveLength(0)
    })
  })

  describe("session.status idle (opencode run)", () => {
    it("busy → session.status idle → 1 DONE", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "OpenCode",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })
      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "idle" } }) })

      expect(calls).toHaveLength(1)
      const title = decodeHeader(calls[0].options.headers.Title)
      expect(title).toContain("terminado")
    })

    it("busy → session.idle → 1 DONE", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "OpenCode",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })
      await handler({ event: createEvent("session.idle", { sessionID: "s1" }) })

      expect(calls).toHaveLength(1)
      const title = decodeHeader(calls[0].options.headers.Title)
      expect(title).toContain("terminado")
    })

    it("busy → status idle → session.idle → only 1 DONE", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "OpenCode",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })
      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "idle" } }) })
      await handler({ event: createEvent("session.idle", { sessionID: "s1" }) })

      expect(calls).toHaveLength(1)
    })

    it("idle inicial sin busy → 0 DONE", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "OpenCode",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "idle" } }) })

      expect(calls).toHaveLength(0)
    })

    it("busy → idle → busy → idle → 2 DONE", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "OpenCode",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })
      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "idle" } }) })
      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })
      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "idle" } }) })

      expect(calls).toHaveLength(2)
    })

    it("pregunta pendiente → no DONE prematuro", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "OpenCode",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })
      await handler({ event: createEvent("question.asked", { sessionID: "s1", id: "q1" }) })
      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "idle" } }) })

      const doneCalls = calls.filter((c) => {
        const title = decodeHeader(c.options.headers.Title)
        return title.includes("terminado")
      })
      expect(doneCalls).toHaveLength(0)
    })
  })

  describe("macOS channel", () => {
    it("sends macOS notification for permission.asked", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
    })

    it("sends macOS notification for question.asked", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("question.asked", { sessionID: "s1", id: "q1" }) })

      expect(calls).toHaveLength(1)
    })

    it("sends macOS notification for session.error", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("session.error", { sessionID: "s1" }) })

      expect(calls).toHaveLength(1)
    })

    it("sends macOS notification for session.idle", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "OpenCode",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })
      await handler({ event: createEvent("session.idle", { sessionID: "s1" }) })

      expect(calls).toHaveLength(1)
    })

    it("does not send macOS notification for routine events", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })
      await handler({ event: createEvent("permission.replied", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(0)
    })

    it("macOS notification does not include secrets", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "super-secret-password"
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
      const body = calls[0].options.body
      const headers = JSON.stringify(calls[0].options.headers)
      expect(body).not.toContain("super-secret-password")
      expect(headers).not.toContain("super-secret-password")
    })

    it("macOS notification does not include OPENCODE_NTFY_TOPIC", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(calls).toHaveLength(1)
      const body = calls[0].options.body
      const headers = JSON.stringify(calls[0].options.headers)
      expect(body).not.toContain(MOCK_TOPIC)
      expect(headers).not.toContain(MOCK_TOPIC)
    })
  })

  describe("macOS channel dispatch", () => {
    it("dispatches macOS BEFORE awaiting ntfy fetch", async () => {
      const order = []
      let resolveFetch
      const fetchImpl = vi.fn(() => new Promise((resolve) => {
        resolveFetch = () => {
          order.push("ntfy")
          resolve(new Response("ok", { status: 200 }))
        }
      }))
      const execFileImpl = vi.fn(() => {
        order.push("macos")
      })
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "OpenCode",
        fetchImpl,
        execFileImpl,
        notifierPath: "/fake/terminal-notifier",
      })

      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })
      const pending = handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "idle" } }) })

      expect(execFileImpl).toHaveBeenCalledTimes(1)
      expect(order).toEqual(["macos"])
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      resolveFetch()
      await pending
      expect(order).toEqual(["macos", "ntfy"])
    })

    it("dispatches macOS even when ntfy fetch rejects", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("network down")
      })
      const execFileImpl = vi.fn()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "OpenCode",
        fetchImpl,
        execFileImpl,
        notifierPath: "/fake/terminal-notifier",
      })

      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })
      await expect(
        handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "idle" } }) })
      ).resolves.toBeUndefined()
      expect(execFileImpl).toHaveBeenCalledTimes(1)
    })

    it("dispatches macOS when topic is missing (channels are independent)", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const execFileImpl = vi.fn()
      const handler = createNotificationHandler({
        topic: undefined,
        projectName: "OpenCode",
        fetchImpl,
        execFileImpl,
        notifierPath: "/fake/terminal-notifier",
      })

      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })
      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "idle" } }) })

      expect(execFileImpl).toHaveBeenCalledTimes(1)
      expect(calls).toHaveLength(0)
    })

    it("does not dispatch macOS on non-darwin platforms", async () => {
      const { fetchImpl } = createMockFetch()
      const execFileImpl = vi.fn()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "OpenCode",
        fetchImpl,
        execFileImpl,
        notifierPath: "/fake/terminal-notifier",
        platform: "linux",
      })

      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })
      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "idle" } }) })

      expect(execFileImpl).not.toHaveBeenCalled()
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it("passes resolved binary path, args and timeout to execFile", async () => {
      const { fetchImpl } = createMockFetch()
      const execFileImpl = vi.fn()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "OpenCode",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
        execFileImpl,
        notifierPath: "/opt/homebrew/bin/terminal-notifier",
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })

      expect(execFileImpl).toHaveBeenCalledTimes(1)
      const [binary, args, options] = execFileImpl.mock.calls[0]
      expect(binary).toBe("/opt/homebrew/bin/terminal-notifier")
      expect(args).toContain("-title")
      expect(args).toContain("-message")
      expect(args).toContain("-sound")
      expect(args).toContain("-open")
      expect(args[args.indexOf("-open") + 1]).toContain("googlechromes://")
      expect(options.timeout).toBe(5000)
    })

    it("swallows execFile errors without failing the notification flow", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const execFileImpl = vi.fn(() => {
        const err = new Error("spawn ENOENT")
        err.code = "ENOENT"
        err.errno = -2
        err.syscall = "spawn"
        throw err
      })
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "OpenCode",
        fetchImpl,
        execFileImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })
      expect(calls).toHaveLength(1)
    })
  })

  describe("resolveTerminalNotifier", () => {
    it("finds the binary in a PATH directory", () => {
      const sep = path.delimiter
      const result = resolveTerminalNotifier({
        pathEnv: [`/custom/bin`, `/other/bin`].join(sep),
        exists: (candidate) => candidate === `/custom/bin${path.sep}terminal-notifier`,
      })
      expect(result).toBe(`/custom/bin${path.sep}terminal-notifier`)
    })

    it("falls back to known Homebrew location when PATH misses it", () => {
      const result = resolveTerminalNotifier({
        pathEnv: "/nonexistent/bin",
        exists: (candidate) => candidate === "/opt/homebrew/bin/terminal-notifier",
      })
      expect(result).toBe("/opt/homebrew/bin/terminal-notifier")
    })

    it("falls back to bare command name when nothing resolves", () => {
      const result = resolveTerminalNotifier({
        pathEnv: "/nonexistent/bin",
        exists: () => false,
      })
      expect(result).toBe("terminal-notifier")
    })
  })

  describe("false 'Trabajo terminado' protection", () => {
    it("does not send session.idle when permissions are pending", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })
      await handler({ event: createEvent("session.idle", { sessionID: "s1" }) })

      expect(calls).toHaveLength(1)
      const title = decodeHeader(calls[0].options.headers.Title)
      expect(title).toContain("autorización")
    })

    it("does not send session.idle when questions are pending", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("question.asked", { sessionID: "s1", id: "q1" }) })
      await handler({ event: createEvent("session.idle", { sessionID: "s1" }) })

      expect(calls).toHaveLength(1)
      const title = decodeHeader(calls[0].options.headers.Title)
      expect(title).toContain("respuesta")
    })

    it("does not send session.idle when error occurred", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("session.error", { sessionID: "s1" }) })
      await handler({ event: createEvent("session.idle", { sessionID: "s1" }) })

      expect(calls).toHaveLength(1)
      const title = decodeHeader(calls[0].options.headers.Title)
      expect(title).toContain("Error")
    })

    it("sends session.idle after permissions are resolved", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        remoteUrl: "https://opencode.example.com",
        fetchImpl,
      })

      await handler({ event: createEvent("permission.asked", { sessionID: "s1", id: "r1" }) })
      await handler({ event: createEvent("permission.replied", { sessionID: "s1", id: "r1" }) })
      await handler({ event: createEvent("session.status", { sessionID: "s1", status: { type: "busy" } }) })
      await handler({ event: createEvent("session.idle", { sessionID: "s1" }) })

      expect(calls).toHaveLength(2)
      const title = decodeHeader(calls[1].options.headers.Title)
      expect(title).toContain("OpenCode")
    })
  })

  describe("v0.1.0 regressions", () => {
    it("claim losers never emit a second completion for the same run", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ntfy-claim-"))
      const mk = () => {
        const { fetchImpl, calls } = createMockFetch()
        return {
          calls,
          handler: createNotificationHandler({
            topic: MOCK_TOPIC,
            projectName: "test",
            fetchImpl,
            claimDir: dir,
          }),
        }
      }
      const winner = mk()
      const loser = mk()
      const busy = { type: "session.status", data: { sessionID: "s1", status: { type: "busy" } } }
      const done = { type: "session.execution.succeeded", data: { sessionID: "s1" }, id: "run-1" }

      await winner.handler({ event: busy })
      await loser.handler({ event: busy })
      await winner.handler({ event: done })
      await loser.handler({ event: done })

      expect(winner.calls).toHaveLength(1)
      expect(loser.calls).toHaveLength(0)

      // The late idle must not resurrect a second notification in the loser.
      const idle = { type: "session.status", data: { sessionID: "s1", status: { type: "idle" } } }
      await winner.handler({ event: idle })
      await loser.handler({ event: idle })

      expect(winner.calls).toHaveLength(1)
      expect(loser.calls).toHaveLength(0)
      expect(winner.calls.length + loser.calls.length).toBe(1)
    })

    it("an error without an id notifies again in a later run", async () => {
      let clock = 1_000_000
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        fetchImpl,
        now: () => clock,
      })

      await handler({ event: { type: "session.error", data: { sessionID: "s1" } } })
      await handler({ event: { type: "session.error", data: { sessionID: "s1" } } })
      expect(calls).toHaveLength(1)

      clock += 31_000
      await handler({ event: { type: "session.error", data: { sessionID: "s1" } } })
      expect(calls).toHaveLength(2)
    })

    it("an error with an id keeps exact per-id deduplication", async () => {
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({ topic: MOCK_TOPIC, projectName: "test", fetchImpl })

      const first = { type: "session.error", data: { sessionID: "s1" }, id: "err-1" }
      await handler({ event: first })
      await handler({ event: first })
      expect(calls).toHaveLength(1)

      await handler({ event: { type: "session.error", data: { sessionID: "s1" }, id: "err-2" } })
      expect(calls).toHaveLength(2)
    })

    it("execution.succeeded without an id still notifies once per bucket", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ntfy-claim-"))
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        fetchImpl,
        claimDir: dir,
        now: () => 1_000_000,
      })

      await handler({ event: { type: "session.execution.succeeded", data: { sessionID: "s1" } } })
      await handler({ event: { type: "session.execution.succeeded", data: { sessionID: "s1" } } })

      expect(calls).toHaveLength(1)
    })

    it("execution.succeeded with a non-string id still notifies", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ntfy-claim-"))
      const { fetchImpl, calls } = createMockFetch()
      const handler = createNotificationHandler({
        topic: MOCK_TOPIC,
        projectName: "test",
        fetchImpl,
        claimDir: dir,
        now: () => 1_000_000,
      })

      await handler({ event: { type: "session.execution.succeeded", data: { sessionID: "s1" }, id: 123 } })
      expect(calls).toHaveLength(1)
    })

    it("resolveClaimDir honours OPENCODE_NTFY_STATE_DIR and is portable", () => {
      expect(resolveClaimDir({ OPENCODE_NTFY_STATE_DIR: "/custom/state" }, "/synthetic-home/x")).toBe(
        path.join("/custom/state", "ntfy-seen"),
      )
      expect(resolveClaimDir({}, "/synthetic-home/x")).toBe(path.join("/synthetic-home/x", ".config", "opencode", "ntfy-seen"))
    })
  })
})
