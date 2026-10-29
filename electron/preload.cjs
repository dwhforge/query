const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dwh", {
  invoke: (cmd, args) => ipcRenderer.invoke("dwh:invoke", cmd, args),
  open: (opts) => ipcRenderer.invoke("dwh:open", opts),
  save: (opts) => ipcRenderer.invoke("dwh:save", opts),
  revealItemInDir: (p) => ipcRenderer.invoke("dwh:reveal", p),
  windowAction: (action) => ipcRenderer.invoke("dwh:window", action),
});
