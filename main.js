const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const https = require("https");
const path = require("path");

const SERVER_URL = process.env.INVENTORY_SERVER_URL || "https://160.251.172.180:8443";
// 自己署名証明書のため、この専用ホストに限りTLSエラーを許容する
const TRUSTED_HOST = "160.251.172.180";

// このビルドの元になったコミット（リリース時に更新する）
const BUILD_COMMIT = "fafa630da9e8708d20b211a454d2389c93149382";
const REPO_URL = "https://github.com/torishio/HCN-Barcodereader";

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: "バーコード在庫管理",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
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

function fetchLatestVersion() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `${SERVER_URL}/api/latest-version`,
      { rejectUnauthorized: false }, // 自己署名証明書のため
      res => {
        let body = "";
        res.on("data", chunk => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("timeout")));
  });
}

ipcMain.handle("check-for-update", async () => {
  try {
    const info = await fetchLatestVersion();
    if (!info.sha) return { hasUpdate: false };
    return {
      hasUpdate: info.sha !== BUILD_COMMIT,
      message: info.message,
      date: info.date,
      sha: info.sha.slice(0, 7),
    };
  } catch (e) {
    return { hasUpdate: false, error: e.message };
  }
});

ipcMain.handle("open-update-page", () => {
  shell.openExternal(REPO_URL);
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
