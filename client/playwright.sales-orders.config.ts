import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests for sales orders and product rates: `npx playwright test -c playwright.sales-orders.config.ts`.
 * Its own ports (4201 / 8181) and database (terralabs_e2e_so), so it can run
 * while the main smoke suite or a dev server is up. Local MongoDB only.
 */
const API_PORT = 4201;
const WEB_PORT = 8181;
const DB = "mongodb://127.0.0.1:27017/terralabs_e2e_so";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /sales-orders\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `node ../backend/scripts/e2e-seed.js && node ../backend/scripts/e2e-seed-sales-orders.js && node ../backend/src/server.js`,
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { NODE_ENV: "test", PORT: String(API_PORT), MONGODB_URI: DB, E2E_MONGODB_URI: DB, JWT_SECRET: "e2e-secret", CORS_ORIGINS: `http://localhost:${WEB_PORT}`, PERF_LOG: "off", EMAIL_USER: "", EMAIL_PASS: "" },
    },
    {
      command: `npx vite --port ${WEB_PORT} --host localhost`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 90_000,
      env: { VITE_API_URL: `http://127.0.0.1:${API_PORT}/api`, VITE_FORCE_LOCAL: "false" },
    },
  ],
});
