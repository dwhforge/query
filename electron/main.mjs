import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
} from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Linux without root: chrome-sandbox must be root:4755. Skip rather than abort.
// (common on workstations / containers where sudo isn't available)
if (process.platform === "linux") {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
}

/** @type {import('node:child_process').ChildProcess | null} */
let hostProc = null;
/** @type {number | null} */
let hostPort = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;

const isDev = !app.isPackaged;

function portableRoot() {
  // Unpacked portable layout: electron + dwh-host sit next to package.json.
  if (!app.isPackaged) return null;
  const cand = path.dirname(app.getAppPath());
  if (fs.existsSync(path.join(cand, "dwh-host")) ||
      fs.existsSync(path.join(cand, "dwh-host.exe"))) {
    return cand;
  }
  return null;
}

function hostBinaryPath() {
  const name = process.platform === "win32" ? "dwh-host.exe" : "dwh-host";
  const portable = portableRoot();
  if (portable) return path.join(portable, name);
  // Portable folder / electron . from pack staging
  const beside = path.join(ROOT, name);
  if (fs.existsSync(beside)) return beside;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, name);
  }
  const release = path.join(ROOT, "target", "release", name);
  const debug = path.join(ROOT, "target", "debug", name);
  if (fs.existsSync(release)) return release;
  return debug;
}

function resourceDirs() {
  const portable = portableRoot();
  if (portable) {
    return {
      extensions: path.join(portable, "extensions"),
      fixtures: path.join(portable, "fixtures"),
      libDir: portable,
    };
  }
  // Pack staging: extensions next to package.json
  if (fs.existsSync(path.join(ROOT, "extensions"))) {
    return {
      extensions: path.join(ROOT, "extensions"),
      fixtures: path.join(ROOT, "fixtures"),
      libDir: ROOT,
    };
  }
  if (app.isPackaged) {
    return {
      extensions: path.join(process.resourcesPath, "extensions"),
      fixtures: path.join(process.resourcesPath, "fixtures"),
      libDir: process.resourcesPath,
    };
  }
  return {
    extensions: path.join(ROOT, "extensions"),
    fixtures: path.join(ROOT, "fixtures"),
    libDir: path.dirname(hostBinaryPath()),
  };
}

function startHost() {
  return new Promise((resolve, reject) => {
    const bin = hostBinaryPath();
    if (!fs.existsSync(bin)) {
      reject(
        new Error(
          `dwh-host not found at ${bin}. Run: cargo build -p dwh-host --release`,
        ),
      );
      return;
    }
    const dirs = resourceDirs();
    const env = {
      ...process.env,
      DWH_EXTENSIONS_DIR: dirs.extensions,
      DWH_FIXTURES_DIR: dirs.fixtures,
    };
    if (process.platform !== "win32") {
      env.LD_LIBRARY_PATH = [
        dirs.libDir,
        process.env.LD_LIBRARY_PATH || "",
      ]
        .filter(Boolean)
        .join(path.delimiter);
    } else {
      env.PATH = [dirs.libDir, process.env.PATH || ""].join(path.delimiter);
    }

    hostProc = spawn(bin, [], {
      env,
      cwd: dirs.libDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const failTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("dwh-host did not become ready in time"));
      }
    }, 20000);

    const onData = (buf) => {
      const text = buf.toString();
      process.stderr.write(text);
      const m = text.match(/DWH_HOST_READY\s+(\d+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(failTimer);
        hostPort = Number(m[1]);
        resolve(hostPort);
      }
    };
    hostProc.stdout?.on("data", onData);
    hostProc.stderr?.on("data", (b) => process.stderr.write(b));
    hostProc.on("exit", (code) => {
      hostPort = null;
      if (!settled) {
        settled = true;
        clearTimeout(failTimer);
        reject(new Error(`dwh-host exited early (code ${code})`));
      }
    });
  });
}

function rpc(cmd, args) {
  return new Promise((resolve, reject) => {
    if (!hostPort) {
      reject(new Error("dwh-host is not running"));
      return;
    }
    const body = JSON.stringify({ cmd, args: args ?? {} });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: hostPort,
        path: "/rpc",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (parsed.ok) resolve(parsed.result);
            else reject(parsed.error || "host error");
          } catch (e) {
            reject(String(e));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "DWHForge Query",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    const url = process.env.VITE_DEV_SERVER_URL || "http://localhost:1420";
    void mainWindow.loadURL(url);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const appRoot = app.getAppPath();
    void mainWindow.loadFile(path.join(appRoot, "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function mapFilters(filters) {
  if (!filters?.length) return [];
  return filters.map((f) => ({
    name: f.name,
    extensions: f.extensions?.length ? f.extensions : ["*"],
  }));
}

ipcMain.handle("dwh:invoke", async (_e, cmd, args) => rpc(cmd, args));

ipcMain.handle("dwh:open", async (_e, opts = {}) => {
  const properties = [];
  if (opts.directory) properties.push("openDirectory");
  else properties.push("openFile");
  if (opts.multiple) properties.push("multiSelections");
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    properties,
    filters: mapFilters(opts.filters),
  });
  if (result.canceled || !result.filePaths.length) return null;
  if (opts.multiple) return result.filePaths;
  return result.filePaths[0];
});

ipcMain.handle("dwh:save", async (_e, opts = {}) => {
  const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
    defaultPath: opts.defaultPath,
    filters: mapFilters(opts.filters),
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle("dwh:reveal", async (_e, targetPath) => {
  shell.showItemInFolder(targetPath);
});

app.whenReady().then(async () => {
  try {
    await startHost();
  } catch (e) {
    dialog.showErrorBox("DWHForge Query", String(e));
    app.quit();
    return;
  }
  createWindow();
});

app.on("window-all-closed", () => {
  if (hostProc && !hostProc.killed) hostProc.kill();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (hostProc && !hostProc.killed) hostProc.kill();
});
