/**
 * Runs the SerpY Express backend inside the desktop app.
 *
 * The server is spawned as a child process using Electron's own bundled Node
 * (ELECTRON_RUN_AS_NODE=1), so the target machine needs nothing installed — no
 * Node, no npm. Only MongoDB stays remote, in Atlas.
 *
 * Configuration (MONGODB_URI, JWT_SECRET, mail credentials) is the company's
 * own — never something an end user supplies. It is baked into the installer at
 * build time (see desktop/build/embed-config.cjs) and shipped as a bundled
 * resource, `resources/app.env`, read by main.cjs alongside this module.
 *
 * When running from a checkout, backend/.env is used instead.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

/** Ask the OS for a port that is genuinely free right now. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Minimal .env parser — avoids depending on the backend's own dotenv. */
function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;

  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Locate a Chromium for PDF generation. Puppeteer's own download is not present
 * in a packaged app, so prefer a browser the user already has. Returns null when
 * nothing is found — PDFs then fail with a clear message rather than a crash.
 */
function findChromium() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
       '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
         'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
         'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * Start the backend.
 *
 * @param {object} opts
 * @param {string} opts.backendDir  folder holding src/server.js and node_modules
 * @param {string} opts.configFile  path to the env file with MONGODB_URI etc.
 * @param {string} opts.execPath    Electron's binary, used as the Node runtime
 * @param {function} opts.onLog     receives each line the server prints
 * @returns {Promise<{port:number, apiBase:string, stop:function}>}
 */
async function startBackend({ backendDir, configFile, execPath, onLog = () => {} }) {
  const serverEntry = path.join(backendDir, 'src', 'server.js');
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`Backend not found at ${serverEntry}`);
  }

  const fileEnv = parseEnvFile(configFile);
  if (!fileEnv.MONGODB_URI && !process.env.MONGODB_URI) {
    const err = new Error('MONGODB_URI is not configured');
    err.code = 'NO_DB_CONFIG';
    err.configFile = configFile;
    throw err;
  }

  const port = await findFreePort();
  const chromium = findChromium();

  const child = spawn(execPath, [serverEntry], {
    cwd: backendDir,
    env: {
      ...process.env,
      ...fileEnv,
      // Run Electron's binary as plain Node rather than opening a window.
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(port),
      // The desktop client is served from this origin; without it every API
      // call would be refused by the backend's CORS allow-list.
      FRONTEND_URL: fileEnv.FRONTEND_URL || 'app://serpy',
      ...(chromium ? { PUPPETEER_EXECUTABLE_PATH: chromium } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const relay = (stream, prefix) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach((line) => line.trim() && onLog(`${prefix} ${line}`));
    });
  };
  relay(child.stdout, '[server]');
  relay(child.stderr, '[server:err]');

  const apiBase = `http://127.0.0.1:${port}/api`;

  // Wait for the health endpoint rather than a fixed sleep, so a slow Atlas
  // connection does not race the first request from the UI.
  const deadline = Date.now() + 45000;
  let lastError = 'timed out';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Backend exited during startup (code ${child.exitCode})`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        return {
          port,
          apiBase,
          chromium,
          stop: () => { try { child.kill(); } catch { /* already gone */ } }
        };
      }
      lastError = `health returned ${res.status}`;
    } catch (e) {
      lastError = e.message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  try { child.kill(); } catch { /* ignore */ }
  throw new Error(`Backend did not become ready: ${lastError}`);
}

module.exports = { startBackend, findFreePort, parseEnvFile, findChromium };
