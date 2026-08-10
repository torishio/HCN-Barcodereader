const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  checkForUpdate: () => ipcRenderer.invoke("check-for-update"),
  openUpdatePage: () => ipcRenderer.invoke("open-update-page"),
});
