#!/usr/bin/env node
/**
 * Endpoint-to-permission verification matrix, generated from the live Express
 * app (not from documentation), so it cannot drift from the code.
 *
 *   node scripts/audit/endpoint-matrix.js > ../docs/audits/endpoint-permission-matrix.generated.md
 *   node scripts/audit/endpoint-matrix.js --json
 *
 * For every route: the mount's moduleGuard requirement for that HTTP method
 * (including its path rules), any route-level requirePermission, whether the
 * mount is behind `protect`, and whether the handler source references a
 * tenant scope helper (dataScope / orgScope / staffScopeQuery / ...). The last
 * column is a static heuristic that flags mutating handlers for MANUAL review;
 * tests/tenant-isolation.test.js proves isolation behaviourally.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'matrix';
const origWarn = console.warn; console.warn = () => {}; console.log = () => {};
const out = (s) => process.stdout.write(`${s}\n`);
const app = require('../../src/app');
const { describeRequirement, AUTHENTICATED } = require('../../src/middleware/moduleGuard');

const SCOPE_HINT = /dataScope|orgScope|staffScopeQuery|scopeFilter|orgUserFilter|ownOrOrgUserFilter|purchaseOrderScope|withScope|scopeQuery|itemScope|accountScope|isSameOrgUser|userId:\s*req\.user|poScope|visibleTo|scope\(/;

const mountOf = (layer) => {
  const src = layer.regexp.source;
  if (layer.regexp.fast_slash) return '';
  return src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/').replace(/\(\?:\(\[\^\/\]\+\?\)\)/g, ':param');
};

const requirementFor = (cfg, method, path) => {
  const rule = (cfg.rules || []).find((r) => (!r.method || [].concat(r.method).includes(method)) && r.path.test(path));
  let req;
  if (rule) req = rule.allow;
  else if (method === 'GET' || method === 'HEAD') req = cfg.read;
  else if (method === 'DELETE') req = cfg.remove ?? cfg.write;
  else req = cfg.write;
  if (req === AUTHENTICATED) return 'any signed-in user';
  if (typeof req === 'function') return 'custom rule';
  return describeRequirement(req);
};

const rows = [];
const layers = app._router.stack;
for (let i = 0; i < layers.length; i += 1) {
  const layer = layers[i];
  if (layer.name !== 'router' || !layer.handle.stack) continue;
  const mount = mountOf(layer);
  // Middleware registered for the same mount just before the router.
  const before = [];
  for (let j = i - 1; j >= 0 && layers[j].regexp.source === layer.regexp.source && layers[j].name !== 'router'; j -= 1) before.push(layers[j]);
  const guardLayer = before.find((l) => l.handle.guardConfig);
  const protectedMount = before.some((l) => l.name === 'protect');
  const cfg = guardLayer?.handle.guardConfig;
  const routerWide = layer.handle.stack.filter((l) => !l.route).map((l) => l.name);
  for (const l of layer.handle.stack) {
    if (!l.route) continue;
    const handlers = l.route.stack;
    const routePerms = handlers.map((h) => h.handle.permission).filter(Boolean);
    const routeProtect = handlers.some((h) => h.name === 'protect') || routerWide.includes('protect');
    const last = handlers[handlers.length - 1].handle;
    const scoped = SCOPE_HINT.test(last.toString());
    for (const method of Object.keys(l.route.methods)) {
      const M = method.toUpperCase();
      rows.push({
        method: M, path: `${mount}${l.route.path === '/' ? '' : l.route.path}`,
        guard: cfg ? requirementFor(cfg, M, l.route.path) : '—',
        routePermission: routePerms.join(', ') || '—',
        auth: protectedMount || routeProtect ? 'yes' : 'NO',
        scopeHint: scoped ? 'yes' : 'REVIEW'
      });
    }
  }
}
rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
if (process.argv.includes('--json')) { out(JSON.stringify(rows, null, 2)); process.exit(0); }
out('| Method | Path | Module guard requires | Route-level permission | Auth | Tenant-scope reference in handler |');
out('|---|---|---|---|---|---|');
for (const r of rows) out(`| ${r.method} | \`${r.path}\` | ${r.guard} | ${r.routePermission} | ${r.auth} | ${r.scopeHint} |`);
out(`\nTotal routes: ${rows.length}. Not behind auth: ${rows.filter((r) => r.auth === 'NO').length}. Mutating routes flagged REVIEW: ${rows.filter((r) => r.scopeHint === 'REVIEW' && r.method !== 'GET').length}.`);
process.exit(0);
