/**
 * First-run configuration window.
 *
 * A freshly installed copy has no credentials — they are deliberately kept out of
 * the installer (see backend-runner.cjs). Rather than naming a file in AppData and
 * quitting, the app asks for the connection string and writes that file itself.
 *
 * JWT_SECRET is generated here rather than typed: it only has to be long, random,
 * and stable for the installation, and asking a shop owner to invent one produces
 * weak secrets.
 *
 * Any keys already in the file (mail credentials, a custom FRONTEND_URL) are kept
 * — the window edits the file, it does not replace it.
 */

const { BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { parseEnvFile } = require('./backend-runner.cjs');

const FILE_HEADER = [
  '# SerpY configuration',
  '# Written by the SerpY setup window. Safe to edit by hand — keep one KEY=value',
  '# per line. Anything added here is passed to the local backend on next launch.',
  ''
].join('\n');

/** Accepts the two forms Atlas hands out; anything else is a typo, not a URI. */
function isValidMongoUri(value) {
  return /^mongodb(\+srv)?:\/\/.+/i.test((value || '').trim());
}

function generateSecret() {
  return crypto.randomBytes(48).toString('hex');
}

/**
 * Merge `values` into the config file, creating it (and its folder) if needed.
 * Returns the full set of resolved values.
 */
function writeConfig(configFile, values) {
  const merged = { ...parseEnvFile(configFile), ...values };
  if (!merged.JWT_SECRET) merged.JWT_SECRET = generateSecret();

  const body = Object.entries(merged)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  // 0600 is honoured on macOS/Linux and harmless on Windows, where the file
  // already sits in the per-user AppData folder.
  fs.writeFileSync(configFile, `${FILE_HEADER}${body}\n`, { mode: 0o600 });

  return merged;
}

/**
 * Show the setup window and resolve once the user saves or closes it.
 *
 * @param {object} opts
 * @param {string} opts.configFile  file to create or update
 * @param {string} [opts.message]   why setup is being shown (previous error)
 * @returns {Promise<boolean>} true when a config was written, false if cancelled
 */
function showSetupWindow({ configFile, message }) {
  return new Promise((resolve) => {
    const existing = parseEnvFile(configFile);
    let saved = false;

    const win = new BrowserWindow({
      width: 620,
      height: 560,
      resizable: false,
      title: 'SerpY — Setup',
      backgroundColor: '#ffffff',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'setup-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    win.setMenuBarVisibility(false);
    win.once('ready-to-show', () => win.show());

    // Scoped to this window so repeated attempts do not stack handlers.
    const onData = (event) => {
      event.returnValue = {
        configFile,
        message: message || '',
        mongoUri: existing.MONGODB_URI || ''
      };
    };

    const onSave = (_event, values) => {
      if (!isValidMongoUri(values.mongoUri)) {
        return { ok: false, error: 'That does not look like a MongoDB connection string. It should start with mongodb+srv:// or mongodb://' };
      }
      try {
        writeConfig(configFile, {
          MONGODB_URI: values.mongoUri.trim(),
          ...(values.emailUser?.trim() ? { EMAIL_USER: values.emailUser.trim() } : {}),
          ...(values.emailPass?.trim() ? { EMAIL_PASS: values.emailPass.trim() } : {})
        });
        saved = true;
        win.close();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: `Could not write ${configFile}: ${error.message}` };
      }
    };

    const onReveal = () => {
      if (fs.existsSync(configFile)) shell.showItemInFolder(configFile);
      else shell.openPath(path.dirname(configFile));
    };

    ipcMain.on('serpy:setup-data', onData);
    ipcMain.handle('serpy:setup-save', onSave);
    ipcMain.on('serpy:setup-reveal', onReveal);

    win.on('closed', () => {
      ipcMain.removeListener('serpy:setup-data', onData);
      ipcMain.removeHandler('serpy:setup-save');
      ipcMain.removeListener('serpy:setup-reveal', onReveal);
      resolve(saved);
    });

    win.loadFile(path.join(__dirname, 'setup.html'));
  });
}

module.exports = { showSetupWindow, writeConfig, isValidMongoUri, generateSecret };
