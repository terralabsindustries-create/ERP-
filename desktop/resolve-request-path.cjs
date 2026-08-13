/**
 * Maps an `app://serpy/<path>` request onto a file inside the built bundle.
 *
 * Kept free of any Electron dependency so it can be unit-tested in plain Node.
 *
 * Rules:
 *   - an existing file is served as-is
 *   - anything else falls back to index.html, so client-side routes such as
 *     /invoices or /accept-invitation/<token> render instead of 404ing
 *   - a path that would escape the bundle (../../etc/passwd) never does; it
 *     falls back to index.html like any other unknown route
 */

const path = require('path');
const fs = require('fs');

function resolveRequestPath(urlPath, distDir) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    decoded = urlPath;
  }

  const indexHtml = path.join(distDir, 'index.html');
  const candidate = path.normalize(path.join(distDir, decoded));

  // Containment check: the resolved file must sit under distDir.
  const rel = path.relative(distDir, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return indexHtml;

  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;

  return indexHtml;
}

module.exports = { resolveRequestPath };
