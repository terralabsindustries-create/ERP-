/**
 * The only bridge between the page and Node. Deliberately tiny: the renderer is
 * the same code the website runs, so it must not depend on anything here.
 *
 * `apiBaseUrl` points at the backend running on this machine. Its port is chosen
 * at startup (whatever is free), so it cannot be compiled into the bundle — the
 * renderer reads it from here instead. On the web this object is absent and the
 * client falls back to VITE_API_URL, exactly as before.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serpyDesktop', {
  isDesktop: true,
  platform: process.platform,
  apiBaseUrl: ipcRenderer.sendSync('serpy:api-base')
});
