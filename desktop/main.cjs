/**
 * Terralabs ERP desktop shell.
 *
 * The window loads the very same React bundle the website serves — there is no
 * second copy of the UI. The only difference is how the files are handed to the
 * renderer:
 *
 *   web      →  https://app.serpy.in/...   served by the host
 *   desktop  →  app://serpy/...            served by the protocol handler below
 *
 * A custom scheme is used instead of file:// for three reasons: the History API
 * keeps working so BrowserRouter needs no changes, requests carry a real Origin
 * ("app://serpy") that the API can allow-list rather than the wildcard `null`
 * that file:// sends, and the page counts as a secure context.
 *
 * The app was called SerpY before the rename. "serpy" is kept only where no one
 * sees it and changing it would cost something: the app:// host (the page's
 * origin — renaming it would sign every user out and needs the backend's CORS
 * list changed), the window.serpyDesktop bridge the client reads, and the
 * appId, which lets a new Windows installer upgrade an existing install.
 */

const { app, BrowserWindow, shell, protocol, net, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { resolveRequestPath } = require('./resolve-request-path.cjs');
const { startBackend } = require('./backend-runner.cjs');
const { checkForUpdates } = require('./updater.cjs');

/**
 * Builds named SerpY kept their data (login session, preferences) in
 * Application Support/SerpY (%APPDATA%\SerpY on Windows). The product is now
 * Terralabs ERP, so Electron looks in a new folder; copy the old one across
 * once so nobody is signed out by the rename. Caches and lock files are left
 * behind — they are rebuilt — and an existing new folder is never touched.
 * Runs before anything (the single-instance lock included) opens userData.
 */
function migrateUserData() {
  try {
    const current = app.getPath('userData');
    const previous = path.join(app.getPath('appData'), 'SerpY');
    if (fs.existsSync(current) || !fs.existsSync(previous)) return;
    const skip = /^(Singleton|Cache$|Code Cache$|GPUCache$|DawnGraphiteCache$|DawnWebGPUCache$|GraphiteDawnCache$|GPUPersistentCache$)/;
    fs.cpSync(previous, current, {
      recursive: true,
      filter: (src) => !skip.test(path.basename(src))
    });
    console.log(`[terralabs] carried app data over from ${previous}`);
  } catch (error) {
    // A failed copy only means signing in again; never block startup over it.
    console.warn('[terralabs] could not carry over data from the SerpY build:', error.message);
  }
}
migrateUserData();

const APP_SCHEME = 'app';
const APP_HOST = 'serpy';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

// Where the renderer bundle lives. Packaged builds get it from resources/;
// running from a checkout it is the client's desktop build output.
const DIST_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app-dist')
  : path.join(__dirname, '..', 'client', 'dist-desktop');

// Set by `npm run dev` to point at the Vite dev server instead of the bundle.
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

// The Express backend ships with the app and runs on this machine; only the
// database is remote. Packaged builds carry it in resources/backend.
const BACKEND_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'backend')
  : path.join(__dirname, '..', 'backend');

// The database is never user-configured — every installation talks to the same
// company Atlas cluster, baked in at build time by build/embed-config.cjs and
// bundled here as a resource. A checkout falls back to the backend's own .env
// so `npm start` just works for development.
const CONFIG_FILE = app.isPackaged
  ? path.join(process.resourcesPath, 'app.env')
  : path.join(BACKEND_DIR, '.env');

// Set once the local server is listening; the renderer reads it through preload.
let apiBase = null;
let stopBackend = () => {};

// Must run before the app is ready, otherwise fetch/XHR from the page is
// treated as a non-standard scheme and blocked.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
]);

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    const filePath = resolveRequestPath(pathname, DIST_DIR);
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

/**
 * Bring the backend up. There is nothing here for an end user to configure —
 * the database connection ships baked into the app — so failures never open a
 * form. A packaged app with no config file is a broken build (reinstall fixes
 * it); a live connection failure (no internet, Atlas paused) is the one case
 * worth retrying in place rather than forcing a relaunch.
 *
 * @returns {Promise<object|null>} the running backend, or null if the user quit
 */
async function startBackendOrQuit() {
  for (;;) {
    try {
      return await startBackend({
        backendDir: BACKEND_DIR,
        configFile: CONFIG_FILE,
        execPath: process.execPath,
        onLog: (line) => console.log(line)
      });
    } catch (error) {
      const isMissingConfig = error.code === 'NO_DB_CONFIG';

      // A checkout reads backend/.env, which is the developer's own file — fixing
      // it belongs in the editor, not in a dialog.
      if (!app.isPackaged) {
        dialog.showErrorBox(
          'Terralabs ERP — backend failed to start',
          `${error.message}\n\nConfiguration file:\n${CONFIG_FILE}`
        );
        return null;
      }

      const message = isMissingConfig
        ? `This build is missing its database configuration (${CONFIG_FILE} not found).\n\n` +
          'Reinstall the latest version of Terralabs ERP, or contact support.'
        : `Terralabs ERP could not reach the database.\n\n${error.message}\n\n` +
          'Check your internet connection and try again.';

      // A missing bundled file will never appear on retry — only a live
      // connection problem is worth asking the user to try again.
      const buttons = isMissingConfig ? ['Quit'] : ['Retry', 'Quit'];
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'Terralabs ERP — could not start',
        message,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1
      });

      if (!isMissingConfig && response === 0) continue; // Retry
      return null;
    }
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#ffffff',
    title: 'Terralabs ERP',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Avoid the white flash while the bundle parses.
  win.once('ready-to-show', () => win.show());

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    win.loadURL(`${APP_ORIGIN}/`);
  } else {
    dialog.showErrorBox(
      'Terralabs ERP — build missing',
      `No UI bundle found at:\n${DIST_DIR}\n\nRun "npm run build:renderer" in the desktop folder first.`
    );
    app.quit();
    return;
  }

  // Anything that isn't the app itself — invitation links, payment pages,
  // WhatsApp — belongs in the user's real browser, not in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_ORIGIN)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const sameApp = url.startsWith(APP_ORIGIN) || (DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL));
    if (!sameApp) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Invoice and quotation PDFs: save straight to Downloads and reveal the file,
  // rather than silently dropping it as a packaged app otherwise would.
  win.webContents.session.on('will-download', (_event, item) => {
    const target = path.join(app.getPath('downloads'), item.getFilename());
    item.setSavePath(target);
    item.once('done', (__event, state) => {
      if (state === 'completed') shell.showItemInFolder(target);
    });
  });

  return win;
}

// A single instance keeps one set of windows over one login session.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // The renderer asks for the API address during preload, before any of its own
  // code runs, so the base URL is known by the time apiClient is imported.
  ipcMain.on('serpy:api-base', (event) => {
    event.returnValue = apiBase;
  });

  app.whenReady().then(async () => {
    registerAppProtocol();
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenu()));

    // Start the local server first — the window must not open against an API
    // that isn't listening yet.
    const backend = await startBackendOrQuit();
    if (!backend) {
      app.quit();
      return;
    }
    apiBase = backend.apiBase;
    stopBackend = backend.stop;
    console.log(`[terralabs] backend ready on ${backend.apiBase}`);
    if (!backend.chromium) {
      console.warn('[terralabs] no Chrome/Edge found — PDF downloads will not work on this machine');
    }

    const mainWindow = createWindow();

    // Check once the window is up, and again daily for machines left running.
    if (app.isPackaged) {
      checkForUpdates({ parentWindow: mainWindow, silent: true });
      setInterval(() => checkForUpdates({ parentWindow: mainWindow, silent: true }),
        24 * 60 * 60 * 1000);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// Never leave the server running after the window is gone.
app.on('before-quit', () => stopBackend());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function buildMenu() {
  const isMac = process.platform === 'darwin';
  return [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Check for Updates…',
          click: () => checkForUpdates({
            parentWindow: BrowserWindow.getAllWindows()[0],
            silent: false
          })
        },
        { type: 'separator' },
        {
          label: 'Open Terralabs ERP on the web',
          click: () => shell.openExternal('https://app.serpy.in')
        }
      ]
    }
  ];
}

module.exports = { APP_ORIGIN };
