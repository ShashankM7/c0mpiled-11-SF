import { defineConfig } from "vitest/config";

// The backend's test runner. Vitest prefers this file over vite.config.ts, which
// belongs to the frontend and loads the Cloudflare/vinext plugins — those break
// when vitest tries to resolve them for a plain Node test run.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
