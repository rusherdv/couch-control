import { app, BrowserWindow, Tray, nativeImage, ipcMain, screen, Menu, shell, dialog, nativeTheme } from "electron";
import { createCast } from "./cast.mjs";
import { createAdb } from "./adb.mjs";
import { createAc } from "./ac.mjs";
import { createAndroidRemote, RemoteDirection } from "@kud/androidtv-remote";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { connect as tcpConnect } from "node:net";
import constants from "./shared/constants.cjs";
import i18n from "./shared/i18n.cjs";
const { KEY, APP_NAMES, APPS, onScreenApp, PKG_HINTS, AC_MODES, AC_FANS, acKey, INPUT_PKGS, DEVICE_TYPES } = constants;
let t = i18n.makeT("en");
const localeFor = () => (config.language && config.language !== "auto" ? config.language : app.getLocale());
let activeInputId = null; // last input chosen from the panel (the TV only reports "input mode", not which one)

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEV = process.argv.includes("--dev");
const CONFIG_PATH = join(app.getPath("userData"), "config.json");
// Settings created by pre-release builds lived in a differently named folder; migrate them once.
const LEGACY_CONFIG = join(app.getPath("appData"), "google-tv-remote", "config.json");

// ---------- Config ----------
const defaultConfig = () => ({
  ip: "",
  name: "Google TV",
  brand: "Google TV",
  language: "auto", // "auto" | "en" | "es"
  cert: null,
  favorites: ["netflix", "crunchy", "youtube", "twitch"],
  inputs: {}, // per-HDMI custom name + device type, e.g. { hdmi2: { name: "PS5", type: "ps5" } }
  shortcuts: [], // content shortcuts: { name, url, app }
  audio: { soundbar: false, ratio: 3, name: "Sound bar" }, // TV volume units per sound bar unit
  adb: false, // launch apps without deep links through ADB (network debugging on the TV)
  appPkgs: {}, // app id -> package name detected via ADB
  ac: { name: "Air conditioner", broadlink: null, codes: {}, last: { power: false, mode: "cool", temp: 24, fan: "auto" }, minTemp: 16, maxTemp: 30 },
  hdmiBase: 4,
  launchAtLogin: false,
});

let config = defaultConfig();
function loadConfig() {
  const src = existsSync(CONFIG_PATH) ? CONFIG_PATH : existsSync(LEGACY_CONFIG) ? LEGACY_CONFIG : null;
  if (src) {
    try { config = { ...defaultConfig(), ...JSON.parse(readFileSync(src, "utf8")) }; } catch {}
    if (src === LEGACY_CONFIG) saveConfig();
  }
  t = i18n.makeT(localeFor());
}
function saveConfig() {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}
const publicConfig = () => ({ ...config, cert: undefined, paired: !!config.cert, locale: t.lang });

// ---------- TV state ----------
const state = {
  status: "disconnected", // disconnected | connecting | pairing | connected | error
  powered: null,
  volume: null, // {level, maximum, muted}
  app: null, // package name
  appName: null,
  error: null,
};
let tv = null;
let pairingResolve = null;
let castState = { connected: false };
const cast = createCast(() => config.ip, (s) => { castState = s; broadcast("cast:state", s); updateTray(); }, (k, v) => t(k, v));
let dialogOpen = false;
let adbState = { available: false, connected: false };
// ---- Air conditioner (Broadlink RM) ----
let acState = { connected: false };
const acPublic = () => ({ ...acState, last: config.ac.last, codes: Object.keys(config.ac.codes || {}), minTemp: config.ac.minTemp, maxTemp: config.ac.maxTemp, name: config.ac.name });
const ac = createAc(() => config.ac.broadlink, (s) => { acState = s; broadcast("ac:state", acPublic()); }, (info) => { config.ac.broadlink = info; saveConfig(); }, (k, v) => t(k, v));
const acLabel = (s) => s.power ? t("{mode} {temp}°C, fan {fan}", { mode: t(AC_MODES.find((x) => x.id === s.mode)?.name || s.mode), temp: s.temp, fan: t(AC_FANS.find((x) => x.id === s.fan)?.name || s.fan).toLowerCase() }) : t("Off");
function acCodeFor(next) {
  const codes = config.ac.codes || {};
  const key = acKey(next);
  if (codes[key]) return { key, hex: codes[key] };
  if (next.power) { // fall back to the same mode+temp with any fan speed
    const alt = Object.keys(codes).find((k) => k.startsWith(`${next.mode}|${next.temp}|`));
    if (alt) return { key: alt, hex: codes[alt], fallback: true };
  }
  return { key, hex: null };
}
const adb = createAdb(() => config.ip, [join(process.resourcesPath || "", "platform-tools", process.platform === "win32" ? "adb.exe" : "adb"), join(__dirname, "vendor", "platform-tools", process.platform === "win32" ? "adb.exe" : "adb"), join(process.env.HOME || "", "Library/Android/sdk/platform-tools/adb"), join(process.env.LOCALAPPDATA || "", "Android", "Sdk", "platform-tools", "adb.exe"), "/opt/homebrew/bin/adb", "/usr/local/bin/adb"], (s) => { adbState = s; broadcast("adb:state", s); }, (k, v) => t(k, v));
async function adbConnectAndResolve() {
  if (!config.adb || !config.ip) return false;
  const ok = await adb.connect();
  if (!ok) return false;
  try {
    const pkgs = await adb.packages();
    const found = { ...(config.appPkgs || {}) };
    for (const [id, re] of Object.entries(PKG_HINTS)) { const hit = pkgs.find((p) => re.test(p)); if (hit) found[id] = hit; }
    config.appPkgs = found; saveConfig(); broadcast("config", publicConfig());
  } catch {}
  return true;
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}
function setState(patch) {
  Object.assign(state, patch);
  if (patch.app !== undefined) state.appName = APP_NAMES[patch.app] ?? patch.app;
  broadcast("tv:state", state);
  updateTray();
  if (DEV) console.log("[state]", JSON.stringify(state));
}

// Plain TCP probe of the TV. The remote library swallows socket errors, so this is how we tell
// "macOS is blocking local network access" (EHOSTUNREACH/EPERM despite the TV being up) apart
// from a wrong code or a cancelled pairing.
function probe(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const sock = tcpConnect({ host, port, family: 4 });
    const done = (code) => { sock.destroy(); resolve(code); };
    sock.setTimeout(timeout, () => done("ETIMEDOUT"));
    sock.once("connect", () => done(null));
    sock.once("error", (e) => done(e.code || "ERROR"));
  });
}
const networkError = (code) => ["EHOSTUNREACH", "EPERM", "EACCES", "ENETUNREACH"].includes(code) && process.platform === "darwin"
  ? t("macOS is blocking local network access. Open System Settings → Privacy & Security → Local Network, enable Couch Control and try again.")
  : t("Could not connect. Is the TV on and on the same network?");

let badCode = false;
async function connect({ pairing = false } = {}) {
  if (!config.ip) return setState({ status: "disconnected" });
  disconnect();
  badCode = false;
  // "pairing" (which shows the code box) only once the TV is actually displaying the code.
  setState({ status: "connecting", error: null });
  const token = {};
  connectToken = token;
  const netErr = await probe(config.ip, pairing || !config.cert ? 6467 : 6466);
  if (connectToken !== token) return;
  if (netErr) {
    setState({ status: "error", error: networkError(netErr) });
    pairingResolve?.(false);
    pairingResolve = null;
    return;
  }

  tv = createAndroidRemote(config.ip, {
    ...(config.cert && !pairing ? { cert: config.cert } : {}),
    service_name: "TV Remote macOS",
    manufacturer: "Apple",
    model: "Mac",
    debug: DEV,
  });
  const me = tv;
  me.on("secret", () => setState({ status: "pairing" }));
  me.on("ready", () => {
    config.cert = me.getCertificate();
    saveConfig();
    setState({ status: "connected", error: null });
    broadcast("config", publicConfig());
    pairingResolve?.(true);
    pairingResolve = null;
  });
  me.on("powered", (powered) => setState({ powered }));
  me.on("volume", (volume) => setState({ volume }));
  me.on("current_app", (pkg) => setState({ app: pkg }));
  me.on("unpaired", () => {
    config.cert = null;
    saveConfig();
    setState({ status: "error", error: t("The TV rejected the pairing. Pair again.") });
    broadcast("config", publicConfig());
  });
  me.on("error", (err) => setState({ status: state.status === "connected" ? "connected" : "error", error: err.message }));

  try {
    const ok = await me.start();
    if (me !== tv) return;
    if (!ok && state.status !== "connected") {
      setState({ status: "error", error: config.cert ? t("Could not connect. Is the TV on and on the same network?") : badCode ? t("Wrong code. Press “Save and connect” to get a new one.") : t("Pairing cancelled or failed.") });
      pairingResolve?.(false);
      pairingResolve = null;
    }
  } catch (e) {
    if (me !== tv) return;
    setState({ status: "error", error: e.message });
  }
}
let connectToken = null;
function disconnect() {
  connectToken = null;
  try { tv?.stop(); } catch {}
  tv = null;
}

// ---------- IPC ----------
ipcMain.handle("config:get", () => publicConfig());
ipcMain.handle("tv:get", () => state);
ipcMain.handle("config:save", (_e, patch) => {
  const ipChanged = patch.ip && patch.ip !== config.ip;
  Object.assign(config, patch);
  if (ipChanged) config.cert = null;
  saveConfig();
  if ("language" in patch) t = i18n.makeT(localeFor());
  if ("launchAtLogin" in patch) app.setLoginItemSettings({ openAtLogin: !!config.launchAtLogin });
  if ("adb" in patch) { if (config.adb) adbConnectAndResolve(); else adb.disconnect(); }
  broadcast("config", publicConfig());
  if (ipChanged) { connect({ pairing: true }); cast.reset(); }
  return publicConfig();
});
ipcMain.handle("tv:pair", () => new Promise((resolve) => { pairingResolve = resolve; connect({ pairing: true }); }));
ipcMain.handle("tv:code", (_e, raw) => {
  // The code is hexadecimal; a typo would make the library drop the whole pairing session, so check it first.
  const code = String(raw).trim().toUpperCase().replace(/O/g, "0").replace(/\s/g, "");
  if (!/^[0-9A-F]{6}$/.test(code)) return { ok: false, error: t("The code has 6 characters (0-9 and A-F).") };
  if (!tv || state.status !== "pairing") return { ok: false, error: t("The TV is not waiting for a code. Press “Save and connect” again.") };
  let ok = false;
  try { ok = tv.sendCode(code); } catch {}
  if (!ok) badCode = true;
  return ok ? { ok: true } : { ok: false, error: t("Wrong code. Press “Save and connect” to get a new one.") };
});
ipcMain.handle("tv:reconnect", () => connect());
ipcMain.handle("tv:forget", () => { disconnect(); config.cert = null; saveConfig(); setState({ status: "disconnected" }); broadcast("config", publicConfig()); });
ipcMain.handle("tv:key", (_e, name, long = false) => {
  const code = KEY[name];
  if (!tv || code == null) return false;
  if (long) { tv.sendKey(code, RemoteDirection.START_LONG); setTimeout(() => tv?.sendKey(code, RemoteDirection.END_LONG), 400); }
  else tv.sendKey(code);
  return true;
});
ipcMain.handle("tv:power", () => { tv?.sendPower(); return !!tv; });
ipcMain.handle("tv:app", (_e, link) => { tv?.sendAppLink(link); return !!tv; });
ipcMain.handle("tv:launch", async (_e, appId) => {
  const a = APPS.find((x) => x.id === appId);
  if (!a) return { ok: false, error: t("Unknown app.") };
  const pkg = config.appPkgs?.[a.id] || a.pkg?.[0] || null;
  const viaAdb = async () => { try { await adb.launch(pkg); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } };
  if (a.link) {
    tv?.sendAppLink(a.link);
    // Fallback: if the TV didn't switch to the app and ADB is enabled, launch by package.
    if (config.adb && pkg) setTimeout(() => { if (!a.pkg.includes(state.app) && state.app !== pkg) viaAdb(); }, 4000);
    return { ok: true };
  }
  if (a.key) { tv?.sendKey(KEY[a.key]); return { ok: true }; }
  if (!config.adb) return { ok: false, error: t("{name} has no direct link. Enable “Launch apps via ADB” in Settings.", { name: a.name }) };
  if (!pkg) return { ok: false, error: t("{name} was not found on the TV (via ADB).", { name: a.name }) };
  return viaAdb();
});
// ---- AC ----
ipcMain.handle("ac:get", () => acPublic());
ipcMain.handle("ac:connect", (_e, opts) => ac.connect(opts || {}).then(() => acPublic()));
ipcMain.handle("ac:learn", async (_e, key) => {
  try { const hex = await ac.learn(key); config.ac.codes[key] = hex; saveConfig(); broadcast("ac:state", acPublic()); return { ok: true, key }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("ac:cancelLearn", () => ac.cancel());
ipcMain.handle("ac:forget", (_e, key) => { delete config.ac.codes[key]; saveConfig(); broadcast("ac:state", acPublic()); });
ipcMain.handle("ac:set", async (_e, patch) => {
  const next = { ...config.ac.last, ...patch };
  next.temp = Math.max(config.ac.minTemp, Math.min(config.ac.maxTemp, Number(next.temp) || 24));
  // While off, changing mode/temp/fan only updates the target; nothing is sent until power is turned on.
  if (!next.power && !config.ac.last.power && patch.power === undefined) { config.ac.last = next; saveConfig(); broadcast("ac:state", acPublic()); return { ok: true, sent: false }; }
  const { key, hex, fallback } = acCodeFor(next);
  if (!hex) return { ok: false, missing: key, error: t("No learned code for “{label}”.", { label: acLabel(next) }) };
  try { await ac.send(hex); } catch (e) { return { ok: false, error: e.message }; }
  config.ac.last = next; saveConfig(); broadcast("ac:state", acPublic());
  return { ok: true, sent: true, fallback: !!fallback };
});
ipcMain.handle("ac:config", (_e, patch) => { Object.assign(config.ac, patch); saveConfig(); broadcast("ac:state", acPublic()); return acPublic(); });
// ---- ADB ----
ipcMain.handle("adb:get", () => adbState);
ipcMain.handle("adb:connect", () => adbConnectAndResolve());
ipcMain.handle("adb:disconnect", () => adb.disconnect());
ipcMain.handle("tv:text", (_e, text) => { tv?.sendText(text); return !!tv; });
ipcMain.handle("tv:volume", async (_e, target) => {
  if (castState.connected && await cast.setVolume(Math.round(target) / 100)) return true;
  if (!tv || !state.volume) return false;
  const delta = Math.round(target) - state.volume.level;
  const key = delta > 0 ? KEY.VOLUME_UP : KEY.VOLUME_DOWN;
  for (let i = 0; i < Math.abs(delta); i++) { tv?.sendKey(key); await new Promise((r) => setTimeout(r, 60)); }
  return true;
});
// ---- Cast ----
ipcMain.handle("cast:get", () => castState);
ipcMain.handle("cast:play", (_e, url, title) => cast.play(url, { title }).then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message })));
ipcMain.handle("cast:control", (_e, action, value) => cast.control(action, value));
ipcMain.handle("cast:stopApp", () => cast.stopApp());
ipcMain.handle("cast:mute", (_e, muted) => cast.setMuted(muted));
ipcMain.handle("cast:file", async () => {
  dialogOpen = true;
  const r = await dialog.showOpenDialog(win, { title: t("Send a file to the TV"), properties: ["openFile"], filters: [{ name: t("Video, audio and images"), extensions: ["mp4", "m4v", "mov", "webm", "mkv", "mp3", "m4a", "aac", "wav", "flac", "ogg", "jpg", "jpeg", "png", "gif", "webp"] }] }).finally(() => { dialogOpen = false; win?.focus(); });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  return cast.castFile(r.filePaths[0]).then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message }));
});
ipcMain.handle("ui:input", (_e, id) => { activeInputId = id; config.activeInput = id; saveConfig(); updateTray(); });
ipcMain.handle("win:hide", () => win?.hide());
ipcMain.handle("win:quit", () => app.quit());
ipcMain.handle("open:external", (_e, url) => shell.openExternal(url));

// ---------- Window + Tray ----------
let win, tray;
const WIDTH = 380, HEIGHT = 720;

function createWindow() {
  win = new BrowserWindow({
    width: WIDTH, height: HEIGHT, show: false, frame: false, transparent: true,
    resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: false },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(join(__dirname, "renderer", "index.html"));
  if (DEV) win.webContents.on("console-message", (_e, level, msg, line, src) => console.log("[renderer]", level, msg, src?.split("/").pop(), line));
  win.on("blur", () => { if (!dialogOpen && !win.webContents.isDevToolsOpened()) win.hide(); });
}

function showWindow() {
  if (win.isVisible()) return;
  const b = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const wa = display.workArea;
  // Windows: the tray lives at the bottom (or the tray bounds may be empty); open the panel above it, bottom-right.
  const trayKnown = b.width > 0 && b.height > 0;
  const below = trayKnown && b.y < wa.y + wa.height / 2;
  const cx = trayKnown ? b.x + b.width / 2 : wa.x + wa.width - WIDTH / 2 - 8;
  const x = Math.round(Math.min(Math.max(cx - WIDTH / 2, wa.x + 8), wa.x + wa.width - WIDTH - 8));
  const y = Math.round(below ? b.y + b.height + 4 : wa.y + wa.height - HEIGHT - 8);
  win.setPosition(x, y, false);
  win.webContents.send("win:arrow", below ? cx - x : -1);
  win.show();
  win.focus();
  if (DEV) console.log("[window]", x, y, WIDTH, HEIGHT);
}
function toggleWindow() { win.isVisible() ? win.hide() : showWindow(); }

function trayIcon() {
  // macOS: template (auto light/dark) icon. Windows/Linux: white icon for dark taskbars.
  const file = process.platform === "darwin" ? "trayTemplate.png" : "trayWhite.png";
  const img = nativeImage.createFromPath(join(__dirname, "assets", file));
  if (process.platform === "darwin") img.setTemplateImage(true);
  return img;
}
// Menu-bar icon: the logo of the media app on screen (pre-rendered PNGs in assets/tray), else the TV glyph.
const trayCache = new Map();
let trayCurrent = "default";
// Badged icons are colored, so they can't be template images: pick the variant matching the menu bar (dark/light).
function trayImageFor(id) {
  const variant = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  const key = `${id}-${variant}`;
  if (trayCache.has(key)) return trayCache.get(key);
  let img = null;
  const p = join(__dirname, "assets", "tray", `${key}.png`);
  if (existsSync(p)) { img = nativeImage.createFromPath(p); if (img.isEmpty()) img = null; }
  trayCache.set(key, img);
  return img;
}
function updateTrayIcon() {
  const on = state.status === "connected" && state.powered !== false;
  const a = on ? onScreenApp(state.app, castState.app) : null;
  let id = a?.id || null;
  if (!id && on && INPUT_PKGS.includes(state.app) && activeInputId) {
    const type = config.inputs?.[activeInputId]?.type;
    if (type && DEVICE_TYPES.find((d) => d.id === type)?.logo) id = "dev-" + type;
  }
  const img = id ? trayImageFor(id) : null;
  const want = img ? `${id}-${nativeTheme.shouldUseDarkColors ? "dark" : "light"}` : "default";
  if (want === trayCurrent) return;
  trayCurrent = want;
  tray.setImage(img || trayIcon());
  if (DEV) console.log("[tray] icon:", want);
}
nativeTheme.on("updated", () => { if (tray) updateTrayIcon(); });
function updateTray() {
  if (!tray) return;
  updateTrayIcon();
  const parts = [config.name || "TV"];
  if (state.status === "connected") {
    if (state.appName) parts.push(t(state.appName));
    if (state.volume) parts.push(`Vol ${state.volume.muted ? t("muted") : state.volume.level}`);
  } else parts.push({ connecting: t("connecting…"), pairing: t("pairing…"), error: t("not connected"), disconnected: t("not set up") }[state.status]);
  tray.setToolTip(parts.join(" · "));
}

// Dev-only local control channel so the running app can be driven from a terminal.
if (DEV) { const devServer = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"); const q = Object.fromEntries(u.searchParams);
  let out = { ok: true };
  if (u.pathname === "/state") out = state;
  else if (u.pathname === "/shot") { // /shot?tab=home&path=/tmp/x.png -> screenshot of the panel
    try { await win.webContents.executeJavaScript(`showTab("${q.tab || "home"}")`); if (q.js) await win.webContents.executeJavaScript(q.js); await new Promise((r) => setTimeout(r, 300)); writeFileSync(q.path, (await win.webContents.capturePage()).toPNG()); }
    catch (e) { out = { ok: false, error: e.message }; }
  }
  else if (u.pathname === "/ac") out = acPublic();
  else if (u.pathname === "/key") tv?.sendKey(Number(q.code ?? KEY[q.name]));
  else if (u.pathname === "/app") tv?.sendAppLink(q.link);
  else if (u.pathname === "/text") tv?.sendText(q.text);
  else out = { ok: false };
  res.setHeader("content-type", "application/json"); res.end(JSON.stringify(out));
});
  devServer.on("error", (e) => { console.log("[dev server]", e.code, "- retrying in 1 s"); setTimeout(() => devServer.listen(47123, "127.0.0.1"), 1000); });
  devServer.listen(47123, "127.0.0.1"); }

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => showWindow());
app.dock?.hide();
app.whenReady().then(() => {
  loadConfig();
  activeInputId = config.activeInput || null;
  createWindow();
  tray = new Tray(trayIcon());
  tray.on("click", toggleWindow);
  tray.on("right-click", () => tray.popUpContextMenu(Menu.buildFromTemplate([
    { label: t("Open remote"), click: showWindow },
    { type: "separator" },
    { label: t("Turn TV on / off"), click: () => tv?.sendPower() },
    { label: t("Reconnect"), click: () => connect() },
    { type: "separator" },
    { label: t("Quit"), click: () => app.quit() },
  ])));
  updateTray();
  if (config.launchAtLogin) app.setLoginItemSettings({ openAtLogin: true });
  if (config.cert) connect();
  if (config.ip) cast.connect();
  if (config.adb) adbConnectAndResolve();
  setTimeout(() => ac.connect(), 800);
  if (DEV || !config.ip) setTimeout(showWindow, 500);
});
app.on("window-all-closed", (e) => e.preventDefault());
app.on("before-quit", () => { disconnect(); cast.stop(); });
