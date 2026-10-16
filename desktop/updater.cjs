/**
 * In-app updates.
 *
 * On launch the app asks the release feed whether a newer version exists. If so
 * it downloads in the background and offers a restart. Nothing is installed
 * behind the user's back — a shop should never have the app restart mid-invoice.
 *
 * The feed is a public repository that holds only built installers; the source
 * repository stays private. No token is embedded in the app.
 *
 * macOS caveat: Squirrel.Mac refuses to apply an update to an unsigned app, so
 * on an unsigned build the user is told a new version exists and pointed at the
 * download instead of updating in place. Windows applies updates fine unsigned.
 */

const { autoUpdater } = require('electron-updater');
const { dialog, shell } = require('electron');

const RELEASES_PAGE = 'https://github.com/Akbarhaleel1/serpy-releases/releases/latest';

// We prompt before downloading and before restarting.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function isSigned() {
  // A macOS build that was never signed cannot self-apply an update.
  if (process.platform !== 'darwin') return true;
  return process.mas || process.env.SERPY_SIGNED === 'true';
}

/**
 * @param {object} opts
 * @param {BrowserWindow} [opts.parentWindow] parent for the dialogs
 * @param {boolean} [opts.silent] true for the automatic check on launch — stays
 *        quiet when already up to date or when the feed is unreachable
 * @param {function} [opts.log]
 */
function checkForUpdates({ parentWindow, silent = true, log = console.log } = {}) {
  const show = (options) =>
    parentWindow ? dialog.showMessageBox(parentWindow, options) : dialog.showMessageBox(options);

  autoUpdater.removeAllListeners();

  autoUpdater.on('update-available', async (info) => {
    log(`[updater] version ${info.version} is available`);

    if (!isSigned()) {
      const { response } = await show({
        type: 'info',
        buttons: ['Download', 'Later'],
        defaultId: 0,
        title: 'Update available',
        message: `Terralabs ERP ${info.version} is available.`,
        detail: 'This build is not code-signed, so it cannot update itself. ' +
                'Download the new version and drag it over the old one.'
      });
      if (response === 0) shell.openExternal(RELEASES_PAGE);
      return;
    }

    const { response } = await show({
      type: 'info',
      buttons: ['Download now', 'Later'],
      defaultId: 0,
      title: 'Update available',
      message: `Terralabs ERP ${info.version} is available.`,
      detail: 'It downloads in the background — you can carry on working, and ' +
              'install it whenever you are ready.'
    });
    if (response === 0) autoUpdater.downloadUpdate();
  });

  autoUpdater.on('update-downloaded', async (info) => {
    log(`[updater] version ${info.version} downloaded`);
    const { response } = await show({
      type: 'info',
      buttons: ['Restart now', 'Install on next launch'],
      defaultId: 1,
      title: 'Update ready',
      message: `Terralabs ERP ${info.version} is ready to install.`,
      detail: 'Restarting takes a few seconds. Finish anything in progress first — ' +
              'the update will also install by itself next time you close the app.'
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('update-not-available', () => {
    log('[updater] already on the latest version');
    if (!silent) {
      show({ type: 'info', title: 'No update', message: 'Terralabs ERP is up to date.' });
    }
  });

  autoUpdater.on('error', (err) => {
    // Offline or feed unreachable: never interrupt a launch over it.
    log(`[updater] check failed: ${err.message}`);
    if (!silent) {
      show({ type: 'error', title: 'Update check failed', message: err.message });
    }
  });

  autoUpdater.checkForUpdates().catch((err) => log(`[updater] ${err.message}`));
}

module.exports = { checkForUpdates, RELEASES_PAGE };
