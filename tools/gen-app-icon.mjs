// One-off generator for the application icon (build/icon.png, 1024×1024). electron-builder derives .icns/.ico from it.
// Run with: npm run gen:icon
import { app, BrowserWindow } from "electron";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 1024;
const html = `<html><body style="margin:0;background:transparent">
<div style="width:${SIZE}px;height:${SIZE}px;border-radius:${SIZE * 0.22}px;background:linear-gradient(160deg,#1e3a8a,#0f172a 60%,#111827);display:grid;place-items:center;position:relative;overflow:hidden">
  <div style="position:absolute;inset:0;background:radial-gradient(60% 50% at 50% 0%,rgba(96,165,250,.35),transparent 70%)"></div>
  <svg viewBox="0 0 24 24" width="${SIZE * 0.62}" height="${SIZE * 0.62}" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="position:relative">
    <rect x="2" y="4" width="20" height="13" rx="2.2"/><path d="M8 21h8M12 17v4"/>
  </svg>
  <div style="position:absolute;right:${SIZE * 0.14}px;bottom:${SIZE * 0.14}px;width:${SIZE * 0.3}px;height:${SIZE * 0.3}px;border-radius:50%;background:#0ea5e9;display:grid;place-items:center;box-shadow:0 ${SIZE * 0.02}px ${SIZE * 0.06}px rgba(0,0,0,.45)">
    <svg viewBox="0 0 24 24" width="${SIZE * 0.18}" height="${SIZE * 0.18}" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19"/></svg>
  </div>
</div></body></html>`;

app.whenReady().then(async () => {
  mkdirSync(join(root, "build"), { recursive: true });
  const tmp = join(tmpdir(), "app-icon.html"); writeFileSync(tmp, html);
  const w = new BrowserWindow({ width: SIZE, height: SIZE, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await w.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 300));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  writeFileSync(join(root, "build", "icon.png"), img.toPNG());
  console.log("build/icon.png written");
  w.destroy(); app.quit();
});
