# SerpY Desktop

An Electron app that runs the **whole** SerpY system on the user's computer:
the React UI *and* the Express backend. Only the database stays remote, in
MongoDB Atlas.

```
   Desktop app                         Cloud
   ┌────────────────────────────┐
   │ window   app://serpy       │
   │   │                        │
   │   ▼ http://127.0.0.1:<port>│
   │ Express backend (child)    │──────►  MongoDB Atlas
   └────────────────────────────┘
```

Nothing here is a fork: `client/` and `backend/` remain the single source of
truth for the website too. This folder only decides how they are delivered and
what a native window is allowed to do.

```
client/  ──┬─→  vite build              →  client/dist          →  the website
           └─→  vite build --mode desktop →  client/dist-desktop →  packaged in the app
```

The two builds are independent. Building the desktop app cannot overwrite the
web build, and the web build is completely unaffected by anything here.

## Running it

```bash
cd desktop
npm install          # first time only (downloads the Electron runtime)

npm start            # build the renderer, then open the app
npm run dev          # attach to the Vite dev server on :8080 with hot reload
```

For `npm run dev`, start the client first: `cd ../client && npm run dev`.

## Packaging installers

```bash
npm run dist         # installer for the current platform
npm run dist:mac     # .dmg + .zip
npm run dist:win     # .exe (NSIS)
npm run pack         # unpacked app, for a quick smoke test
```

Output lands in `desktop/release/`. Windows installers must be built on Windows
(or in a Windows CI runner); macOS builds must be produced on macOS.

## How the app is served

The window does **not** load `file://`. It loads `app://serpy/`, backed by a
protocol handler in `main.cjs`. That choice buys three things:

1. **Routing works unchanged.** The handler falls back to `index.html` for paths
   that aren't real files, so `BrowserRouter` behaves exactly as it does on the
   web. No `HashRouter` switch, no `#/` URLs, no client changes at all.
2. **A real Origin.** Requests carry `Origin: app://serpy`, which is allow-listed
   in `backend/src/server.js`. A `file://` page sends `Origin: null`, which would
   have meant allowing *any* local HTML file to call the API.
3. **A secure context**, so browser APIs that require one keep working.

`resolve-request-path.cjs` holds that path logic on its own, free of Electron,
so it can be unit-tested. It also refuses to serve anything outside the bundle —
`app://serpy/../../etc/passwd` falls back to `index.html`.

## The backend runs locally

`backend-runner.cjs` spawns `backend/src/server.js` as a child process using
Electron's own bundled Node (`ELECTRON_RUN_AS_NODE=1`), so the target machine
needs no Node or npm installed. The port is whatever the OS says is free, so two
copies never collide; the renderer learns the address through the preload bridge
(`window.serpyDesktop.apiBaseUrl`) rather than having it compiled in.

The server is stopped on quit, and the app refuses to open a window until
`/api/health` answers — so the UI can never load against a dead backend.

### Configuration — read this before distributing

SerpY desktop is a **single-database product**. Every installation — every
shop, every machine — talks to the same company-owned Atlas cluster.
Multi-tenancy is handled in the app layer by the `dataScope`/`userId` fields
already on every model (see `backend/src/models/Settings.js` and the rest of
`backend/src/models/`), not by giving each install its own database. Nobody
running the app ever sees or types a connection string.

The credentials are baked in at **build time**, not runtime:

```
desktop/build/embed-config.cjs
   reads MONGODB_URI, JWT_SECRET, EMAIL_USER, EMAIL_PASS from the environment
   → writes desktop/build/app.env (gitignored — never commit this file)
   → package.json → build.extraResources bundles it as resources/app.env
   → main.cjs points CONFIG_FILE at that bundled resource for a packaged app
```

In CI those four values come from repository secrets (set once, see
`.github/workflows/desktop-build.yml`). For a manual local release build,
export them in your shell first:

```bash
export MONGODB_URI='mongodb+srv://user:password@cluster.mongodb.net/serpy'
export JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
npm run dist:mac   # or dist:win
```

`npm run dist*` fails fast with a clear message if `MONGODB_URI` or
`JWT_SECRET` isn't set — it will not silently ship a build with no database.

If the bundled `app.env` is somehow missing from a packaged app (a broken
build, not something a shop can cause), the app shows an error dialog naming
the problem and reinstalling is the fix — there is no setup form, because
there is nothing an end user is meant to configure. A live connection failure
(no internet, Atlas paused) instead offers **Retry**, since that one can clear
on its own.

Running from a checkout uses `backend/.env` instead, exactly as before — a
developer's own `.env` is edited by hand, not baked in.

**Anything shipped in `resources/app.env` is readable by whoever has the
installed app** — it is a plaintext file inside the bundle, trivially
extracted. Because every install shares one database, that means the Atlas
connection string for your *entire* customer base sits inside a binary you
hand out widely. Mitigate what you can:

- Give the Atlas user used here the minimum privileges the backend actually
  needs — not an Atlas admin credential.
- Restrict Atlas Network Access to the ranges you expect connections from, if
  your customers' networks allow it.
- Be ready to rotate `MONGODB_URI` (new database user + password) and ship a
  new release if a credential leak is ever suspected — nothing else revokes it.

This is a real tradeoff of shipping a fat client against a shared cloud
database, not a bug — accepted deliberately in exchange for never asking a
shop to source or manage their own database.

## Installing on macOS

Open the `.dmg` and drag SerpY to Applications. The `-mac.zip` beside it is the
updater's download format, not a second installer.

Builds are unsigned — there is no Apple Developer certificate — so the first
launch must be **right-click → Open → Open**. A plain double-click is refused.

`build/adhoc-sign.cjs` runs after packaging and ad-hoc signs the bundle. Without
it macOS reports *"SerpY is damaged and can't be opened"*, because electron-builder
skips signing entirely when no certificate is found and the app is left with only
Electron's linker signature — not valid for a bundle on Apple Silicon. "Damaged"
is misleading; nothing is corrupt.

If a copy built before that hook existed is already installed:

```sh
xattr -dr com.apple.quarantine /Applications/SerpY.app
codesign --force --deep --sign - /Applications/SerpY.app
```

Ad-hoc signing only makes the app openable. Getting rid of the warning entirely
needs a Developer ID certificate and notarisation.

## Updates

Every push to `main` builds a new version (`1.0.<run number>`) and publishes the
installers to the public `serpy-releases` repository. Installed copies check that
feed on launch and once a day, and offer the update — nothing installs itself
behind the user's back, so the app never restarts mid-invoice. There is also
**Help → Check for Updates…** for an on-demand check.

Setup, once:

1. Create a public repo `Akbarhaleel1/serpy-releases` (empty; binaries only —
   your source stays private).
2. Create a personal access token with `contents: write` on that repo.
3. Add it to this repo as the secret `RELEASES_TOKEN`.

**macOS updates need code signing.** Squirrel.Mac will not apply an update to an
unsigned app, so unsigned Mac builds show "a new version is available" and open
the download page instead. Windows applies updates in place without signing.

Because the backend ships inside the app, a backend fix is also an app release —
every machine needs the new version, unlike the website where a deploy reaches
everyone at once.

## Behaviour that differs from the browser

| Concern | What the shell does |
|---|---|
| External links (invitations, Razorpay, WhatsApp) | Opened in the user's real browser, never inside the app window |
| PDF downloads (invoices, quotations) | Saved to Downloads and revealed in Finder/Explorer |
| Second launch | Focuses the existing window instead of opening another |
| Node access from the page | None — `contextIsolation` on, `nodeIntegration` off, sandbox on |

The preload exposes only `window.serpyDesktop` (`{ isDesktop, platform, version }`),
so the UI can tell it is running in the shell if it ever needs to. The web build
does not have it, and nothing currently depends on it.

## Things worth knowing

- Installer size is roughly 200-400 MB: it carries Electron plus the backend's
  `node_modules`. Puppeteer's bundled Chromium is excluded — PDFs use whatever
  Chrome/Edge is installed, and the app logs a warning at startup when it cannot
  find one.
- Every machine talks to Atlas directly, so each one needs outbound network
  access to your cluster and an Atlas IP allow-list entry.
- Emailed links (`/accept-invitation/<token>`) open in the browser, since the mail
  client has no idea the desktop app exists. That is why the web app must remain
  deployed. A `serpy://` protocol handler could redirect those into the app later.
- `build/icon.png` is generated from the same geometry as the web favicon by
  `client/scripts/render-favicon.cjs`.
