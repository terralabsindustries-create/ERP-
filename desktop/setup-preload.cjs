/**
 * Bridge for the setup window only. Separate from preload.cjs because that one is
 * loaded into the real app and must stay minimal — setup needs to write a file,
 * which the app itself never does.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serpySetup', {
  // Available synchronously so the form can render filled in on first paint.
  data: ipcRenderer.sendSync('serpy:setup-data'),
  save: (values) => ipcRenderer.invoke('serpy:setup-save', values),
  revealConfigFolder: () => ipcRenderer.send('serpy:setup-reveal')
});
