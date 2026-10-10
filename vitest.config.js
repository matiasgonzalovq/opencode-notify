import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.js"],
    environment: "node",
    // Tests mock fetch and execFile entirely; nothing here may reach a network
    // or spawn a real notifier. Keep the suite fast and offline.
    testTimeout: 5000,
  },
})
