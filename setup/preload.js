const { contextBridge, ipcRenderer } = require("electron");

const CALLS = ["state", "login", "install", "reset-password", "find-kindles", "install-kindle", "open"];
contextBridge.exposeInMainWorld("setup", {
  call: (name, arg) => (CALLS.includes(name) ? ipcRenderer.invoke(name, arg) : Promise.reject(new Error("unknown call"))),
  onProgress: (fn) => ipcRenderer.on("progress", (_, msg) => fn(msg)),
});
