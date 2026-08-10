const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openRepoPage: () => ipcRenderer.invoke("open-repo-page"),
});
