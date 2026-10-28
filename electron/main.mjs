import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
} from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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
/** @type {{ kind: "unix", path: string } | { kind: "tcp", port: number } | null} */
let hostEndpoint = null;
/** @type {import('node:net').Socket | null} */
let hostSock = null;
/** @type {Promise<import('node:net').Socket> | null} */
let hostConnecting = null;
/** @type {Buffer} */
let hostBuf = Buffer.alloc(0);
let rpcNextId = 1;
/** @type {Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void }>} */
const rpcPending = new Map();
/** @type {BrowserWindow | null} */
let mainWindow = null;

/** Dev UI only when Vite URL is set — portable packs are NOT packaged asar. */
function useViteDevServer() {
  return Boolean(process.env.VITE_DEV_SERVER_URL);
}

function portableRoot() {
  // Unpacked portable: dwh-host next to package.json (ROOT = parent of electron/).
  if (
    fs.existsSync(path.join(ROOT, "dwh-host")) ||
    fs.existsSync(path.join(ROOT, "dwh-host.exe"))
  ) {
    return ROOT;
  }
  if (app.isPackaged) {
    const cand = path.dirname(app.getAppPath());
    if (
      fs.existsSync(path.join(cand, "dwh-host")) ||
      fs.existsSync(path.join(cand, "dwh-host.exe"))
    ) {
      return cand;
    }
  }
  return null;
}

function resolveIndexHtml() {
  const candidates = [
    path.join(ROOT, "dist", "index.html"),
    path.join(app.getAppPath(), "dist", "index.html"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
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
      // DWH_HOST_READY unix <path>  |  DWH_HOST_READY tcp <port>
      // Legacy: DWH_HOST_READY <port>
      const mUnix = text.match(/DWH_HOST_READY\s+unix\s+(\S+)/);
      const mTcp = text.match(/DWH_HOST_READY\s+tcp\s+(\d+)/);
      const mLegacy = text.match(/DWH_HOST_READY\s+(\d+)\b/);
      if (settled) return;
      if (mUnix) {
        settled = true;
        clearTimeout(failTimer);
        hostEndpoint = { kind: "unix", path: mUnix[1] };
        resolve(hostEndpoint);
      } else if (mTcp) {
        settled = true;
        clearTimeout(failTimer);
        hostEndpoint = { kind: "tcp", port: Number(mTcp[1]) };
        resolve(hostEndpoint);
      } else if (mLegacy) {
        settled = true;
        clearTimeout(failTimer);
        hostEndpoint = { kind: "tcp", port: Number(mLegacy[1]) };
        resolve(hostEndpoint);
      }
    };
    hostProc.stdout?.on("data", onData);
    hostProc.stderr?.on("data", (b) => process.stderr.write(b));
    hostProc.on("exit", (code) => {
      hostEndpoint = null;
      closeHostSock("dwh-host exited");
      if (!settled) {
        settled = true;
        clearTimeout(failTimer);
        reject(new Error(`dwh-host exited early (code ${code})`));
      }
    });
  });
}

function closeHostSock(reason) {
  hostConnecting = null;
  if (hostSock) {
    try {
      hostSock.destroy();
    } catch {
      /* ignore */
    }
    hostSock = null;
  }
  hostBuf = Buffer.alloc(0);
  for (const [, p] of rpcPending) {
    p.reject(new Error(reason || "host socket closed"));
  }
  rpcPending.clear();
}

function onHostData(chunk) {
  hostBuf = Buffer.concat([hostBuf, chunk]);
  while (hostBuf.length >= 4) {
    const len = hostBuf.readUInt32LE(0);
    if (hostBuf.length < 4 + len) break;
    const body = hostBuf.subarray(4, 4 + len);
    hostBuf = hostBuf.subarray(4 + len);
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch (e) {
      console.error("[dwh] bad host frame", e);
      continue;
    }
    const id = parsed.id;
    const pending = id != null ? rpcPending.get(id) : null;
    if (pending) {
      rpcPending.delete(id);
      if (parsed.ok) pending.resolve(parsed.result);
      else pending.reject(new Error(parsed.error || "host error"));
    }
  }
}

function connectHostSock() {
  if (!hostEndpoint) {
    return Promise.reject(new Error("dwh-host is not running"));
  }
  if (hostSock && !hostSock.destroyed) {
    return Promise.resolve(hostSock);
  }
  if (hostConnecting) return hostConnecting;

  hostConnecting = new Promise((resolve, reject) => {
    const sock =
      hostEndpoint.kind === "unix"
        ? net.createConnection(hostEndpoint.path)
        : net.createConnection({ host: "127.0.0.1", port: hostEndpoint.port });
    sock.setNoDelay(true);
    sock.once("connect", () => {
      hostSock = sock;
      hostBuf = Buffer.alloc(0);
      hostConnecting = null;
      resolve(sock);
    });
    sock.on("data", onHostData);
    sock.once("error", (e) => {
      hostConnecting = null;
      closeHostSock(String(e));
      reject(e);
    });
    sock.on("close", () => {
      if (hostSock === sock) {
        hostSock = null;
        for (const [, p] of rpcPending) {
          p.reject(new Error("host socket closed"));
        }
        rpcPending.clear();
      }
    });
  });
  return hostConnecting;
}

async function rpc(cmd, args) {
  const sock = await connectHostSock();
  const id = rpcNextId++;
  const payload = Buffer.from(
    JSON.stringify({ id, cmd, args: args ?? {} }),
    "utf8",
  );
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return new Promise((resolve, reject) => {
    rpcPending.set(id, { resolve, reject });
    sock.write(Buffer.concat([header, payload]), (err) => {
      if (err) {
        rpcPending.delete(id);
        closeHostSock(String(err));
        reject(err);
      }
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "DWHForge Query",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[dwh] did-fail-load ${code} ${desc} url=${url}`);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[dwh] render-process-gone", details);
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const indexHtml = resolveIndexHtml();

  if (useViteDevServer() && devUrl) {
    void mainWindow.loadURL(devUrl);
  } else if (indexHtml) {
    void mainWindow.loadFile(indexHtml);
  } else {
    const msg =
      "UI not found (dist/index.html). For portable: re-pack release. " +
      "For dev: npm run electron:dev (sets VITE_DEV_SERVER_URL).";
    console.error(`[dwh] ${msg}`);
    dialog.showErrorBox("DWHForge Query", msg);
  }

  // Autofill.enable -32601 is harmless DevTools noise.
  if (process.env.DWH_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
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

/** Window chrome from in-app menu (system menu bar is hidden). */
ipcMain.handle("dwh:window", async (e, action) => {
  const win =
    BrowserWindow.fromWebContents(e.sender) ?? mainWindow;
  if (!win || win.isDestroyed()) return null;
  const z = () => win.webContents.getZoomFactor();
  switch (action) {
    case "zoom-in":
      win.webContents.setZoomFactor(Math.min(3, Math.round((z() + 0.1) * 10) / 10));
      break;
    case "zoom-out":
      win.webContents.setZoomFactor(Math.max(0.5, Math.round((z() - 0.1) * 10) / 10));
      break;
    case "zoom-reset":
      win.webContents.setZoomFactor(1);
      break;
    case "toggle-fullscreen":
      win.setFullScreen(!win.isFullScreen());
      break;
    case "close":
      win.close();
      break;
    default:
      break;
  }
  return { zoomFactor: win.webContents.getZoomFactor(), fullScreen: win.isFullScreen() };
});

app.whenReady().then(async () => {
  // Hide native File/Edit/… bar — chrome lives in the in-app AppMenu.
  Menu.setApplicationMenu(null);
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
