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

Credentials are **not** compiled into the app. On first run the app looks for:

| Platform | File |
|---|---|
| macOS | `~/Library/Application Support/SerpY/serpy.env` |
| Windows | `%APPDATA%\SerpY\serpy.env` |

```
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/serpy
JWT_SECRET=<a long random string>
EMAIL_USER=...
EMAIL_PASS=...
```

That folder name comes from `app.getName()`, which is why **`productName` must
stay at the top level of package.json**, not only inside `build`. Electron reads
the top-level field; with it missing the folder silently becomes `serpy-desktop`
and no one following these docs can find it.

If the file is missing — which is the case for every fresh installation — the app
opens a setup window asking for the connection string, then writes the file
itself. `JWT_SECRET` is generated there rather than typed. Bad credentials bring
the same window back with the connection error, so a wrong paste is recoverable
without hunting through AppData. Closing the window quits the app.

Keys already in the file are preserved when it is rewritten, so mail settings
added by hand survive a later trip through the setup window.

Running from a checkout uses `backend/.env` instead and skips the setup window
entirely — a developer's broken `.env` belongs in the editor, so `npm start`
reports the error and exits.

**Anything you put in that file is readable by whoever runs the app.** A shared
Atlas user in every installation means every shop holds credentials to the whole
database. Give each installation its own Atlas user with least privilege, and
restrict Atlas network access — or put an API in front of Atlas instead.

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
