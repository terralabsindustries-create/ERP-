import { defineConfig, devices } from "@playwright/test";

/**
 * Browser smoke tests: `npm run test:e2e` (from client/).
 *
 * Starts an ISOLATED stack — a local MongoDB database (terralabs_e2e, dropped
 * and reseeded each run), the real Express API on :4101 and the Vite dev server
 * on :8081 — and never reads the developer's .env database. Needs a MongoDB on
 * 127.0.0.1:27017 and Chromium (`npx playwright install chromium`).
 */
const API_PORT = 4101;
const WEB_PORT = 8081;
const E2E_DB = process.env.E2E_MONGODB_URI || "mongodb://127.0.0.1:27017/terralabs_e2e";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `node ../backend/scripts/e2e-seed.js && node ../backend/src/server.js`,
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: "test",
        PORT: String(API_PORT),
        MONGODB_URI: E2E_DB,
        E2E_MONGODB_URI: E2E_DB,
        JWT_SECRET: "e2e-secret",
        PERF_LOG: "off",
        EMAIL_USER: "",
        EMAIL_PASS: "",
      },
    },
    {
      command: `npx vite --port ${WEB_PORT} --host localhost`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 90_000,
      // Process env beats .env.local. The developer's .env.local sets VITE_FORCE_LOCAL=true, which makes
      // the dev client call the HOSTED api.carbonprintflow.com; it must be switched off here.
      env: { VITE_API_URL: `http://127.0.0.1:${API_PORT}/api`, VITE_FORCE_LOCAL: "false" },
    },
  ],
});
