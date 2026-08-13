/**
 * Bakes the system database credentials into the packaged app.
 *
 * SerpY desktop is a single-database product: every installation talks to the
 * one company-controlled Atlas cluster. Multi-tenancy is handled in the app
 * layer, by the existing dataScope/userId fields already on every model (see
 * backend/src/models/Settings.js and friends) — not by giving each shop its
 * own database. Customers only ever run the backend and frontend locally; the
 * database is never theirs to point somewhere else, so the app never asks.
 *
 * This script runs right before electron-builder packages the app (see the
 * `dist*` scripts in package.json). It reads the real credentials from the
 * environment — GitHub Actions secrets in CI, or a maintainer's own shell for
 * a local release build — and writes build/app.env, which `extraResources`
 * then bundles into resources/app.env inside the installer.
 *
 * build/app.env is gitignored. It must never be committed — the values only
 * ever live as CI secrets or in a maintainer's shell.
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, 'app.env');

// Without these the app has no database to talk to at all.
const REQUIRED_KEYS = ['MONGODB_URI', 'JWT_SECRET'];

// System mailbox for OTPs and invitation emails (see backend/src/utils/mailer.js).
// Optional: the app runs fine without it, those features just report as unconfigured.
const OPTIONAL_KEYS = ['EMAIL_USER', 'EMAIL_PASS'];

function main() {
  const missing = REQUIRED_KEYS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(
      `\nembed-config: missing ${missing.join(', ')} in the environment.\n\n` +
      'These are the company\'s own system credentials, set once as GitHub Actions\n' +
      'secrets (or exported locally for a manual release build) — never entered by\n' +
      'an end user. See desktop/README.md → "Database configuration".\n'
    );
    process.exit(1);
  }

  const keys = [...REQUIRED_KEYS, ...OPTIONAL_KEYS].filter((key) => process.env[key]);
  const body = keys.map((key) => `${key}=${process.env[key]}`).join('\n');

  fs.writeFileSync(OUTPUT_FILE, `${body}\n`, { mode: 0o600 });
  console.log(`embed-config: wrote ${OUTPUT_FILE} (${keys.length} keys: ${keys.join(', ')})`);
}

main();
