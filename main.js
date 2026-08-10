const { app, BrowserWindow, Menu } = require("electron");

const SERVER_URL = process.env.INVENTORY_SERVER_URL || "https://160.251.172.180:8443";
// 自己署名証明書のため、この専用ホストに限りTLSエラーを許容する
const TRUSTED_HOST = "160.251.172.180";

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: "バーコード在庫管理",
    autoHideMenuBar: true,
  });
  win.loadURL(SERVER_URL);
}

Menu.setApplicationMenu(null);

app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
  if (new URL(url).hostname === TRUSTED_HOST) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
