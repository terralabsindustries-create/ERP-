/**
 * The production build's API address check in vite.config.ts.
 *
 * Loads the real config through Vite's own loader for each case, as `vite`
 * and `vite build` would. Run from client/: `npm run test:config`.
 *
 * VITE_API_URL is set in process.env for each case; Vite gives it precedence
 * over the .env files, so a developer's .env.local does not affect the result.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfigFromFile } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configFile = path.join(root, "vite.config.ts");

async function load({ command = "build", mode = "production", apiUrl }) {
  const saved = process.env.VITE_API_URL;
  process.env.VITE_API_URL = apiUrl ?? "";
  try {
    return await loadConfigFromFile({ command, mode }, configFile, root, "silent");
  } finally {
    if (saved === undefined) delete process.env.VITE_API_URL;
    else process.env.VITE_API_URL = saved;
  }
}

const refuses = (apiUrl, pattern) => assert.rejects(load({ apiUrl }), pattern, `expected ${JSON.stringify(apiUrl)} to be refused`);

test("a production build without VITE_API_URL is refused", async () => {
  await refuses(undefined, /VITE_API_URL is not set/);
  await refuses("   ", /VITE_API_URL is not set/);
});

test("a production build against a loopback API is refused", async () => {
  for (const apiUrl of [
    "http://localhost:4001/api",
    "https://LOCALHOST/api",
    "http://localhost./api",
    "http://api.localhost:4001/api",
    "http://127.0.0.1:4001/api",
    "http://127.1:4001/api",
    "http://127.255.0.9/api",
    "http://0.0.0.0:4001/api",
    "http://0/api",
    "http://[::1]:4001/api",
    "http://[::]/api",
    "http://[::ffff:127.0.0.1]/api"
  ]) {
    await refuses(apiUrl, /visitor's own machine/);
  }
});

test("a production build with something that is not an http(s) address is refused", async () => {
  for (const apiUrl of ["/api", "api.example.com/api", "ftp://api.example.com", "javascript:alert(1)"]) {
    await refuses(apiUrl, /not a full http\(s\) address/);
  }
});

test("a production build against a hosted API loads", async () => {
  for (const apiUrl of ["https://api.carbonprintflow.com/api", "https://api.example.com", "http://10.0.0.5:4001/api", "https://127-0-0-1.example.com/api"]) {
    const loaded = await load({ apiUrl });
    assert.equal(loaded.config.build.outDir, "dist", apiUrl);
  }
});

test("local development, development builds and the desktop build are not checked", async () => {
  for (const [command, mode] of [["serve", "development"], ["build", "development"], ["build", "desktop"]]) {
    for (const apiUrl of [undefined, "http://localhost:4001/api"]) {
      const loaded = await load({ command, mode, apiUrl });
      assert.ok(loaded.config, `${command} ${mode} ${apiUrl}`);
    }
  }
  assert.equal((await load({ mode: "desktop", apiUrl: undefined })).config.build.outDir, "dist-desktop");
});
