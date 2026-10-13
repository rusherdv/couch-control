// One-off generator: TV glyph with the app logo as a small badge (bottom-right), for the menu bar / tray.
// Outputs assets/tray/<id>-dark.png (+@2x, white glyph for dark menu bars) and <id>-light.png (+@2x, black glyph).
// Run with: npm run gen:tray
import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import constants from "../shared/constants.cjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 36; // @2x of an 18 px icon
const TRAY_APPS = [
  ...constants.APPS.filter((a) => a.logo && !["disney", "prime", "store"].includes(a.id)),
  ...constants.DEVICE_TYPES.filter((d) => d.logo).map((d) => ({ ...d, id: "dev-" + d.id })),
];
const TV = (color) => `<svg viewBox="0 0 24 24" width="${SIZE}" height="${SIZE}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`;

app.whenReady().then(async () => {
  mkdirSync(join(root, "assets", "tray"), { recursive: true });
  const w = new BrowserWindow({ width: SIZE, height: SIZE, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  for (const a of TRAY_APPS) {
    const svg = readFileSync(join(root, "assets", "logos", `${a.logo}.svg`), "utf8");
    const dataUri = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
    const color = a.id.startsWith("dev-") ? (variantColor) => variantColor : (a.bg === "#fff" || ["#000", "#0a0a0f", "#1c1c1e", "#282A2D"].includes(a.bg) ? a.fg : a.bg);
    for (const variant of ["dark", "light"]) {
      const glyph = variant === "dark" ? "#ffffff" : "#000000";
      const badge = Math.round(SIZE * 0.62);
      // Badge sits bottom-right over a small "cutout" circle in the glyph color's opposite so it reads on any background.
      const html = `<html><body style="margin:0;background:transparent"><div style="position:relative;width:${SIZE}px;height:${SIZE}px">
        ${TV(glyph)}
        <span style="position:absolute;right:-1px;bottom:-1px;width:${badge}px;height:${badge}px;border-radius:50%;background:${variant === "dark" ? "#1e1e1e" : "#f2f2f2"}"></span>
        <span style="position:absolute;right:2px;bottom:2px;width:${badge - 6}px;height:${badge - 6}px;background:${typeof color === "function" ? color(glyph) : color};-webkit-mask:url('${dataUri}') center/contain no-repeat"></span>
      </div></body></html>`;
      const tmp = join(tmpdir(), `tray-${a.id}-${variant}.html`); writeFileSync(tmp, html);
      try { await w.loadFile(tmp); } catch (e) { console.log("skip", a.id, e.message); continue; }
      await new Promise((r) => setTimeout(r, 150));
      const img = await w.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
      writeFileSync(join(root, "assets", "tray", `${a.id}-${variant}@2x.png`), img.toPNG());
      writeFileSync(join(root, "assets", "tray", `${a.id}-${variant}.png`), img.resize({ width: SIZE / 2, height: SIZE / 2 }).toPNG());
    }
    console.log("tray icon:", a.id);
  }
  w.destroy();
  app.quit();
});
