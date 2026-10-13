// Downloads Android platform-tools (adb) into vendor/platform-tools for the current OS.
// ADB is optional: it is only used to launch TV apps that have no deep link (Stremio, Kick, AirPlay Server…).
// Usage: node scripts/setup-adb.mjs
import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "vendor");
const target = join(vendor, "platform-tools");
const os = { darwin: "darwin", win32: "windows", linux: "linux" }[process.platform];
if (!os) { console.error("Unsupported platform:", process.platform); process.exit(1); }
if (existsSync(join(target, process.platform === "win32" ? "adb.exe" : "adb"))) { console.log("adb already present in", target); process.exit(0); }

const url = `https://dl.google.com/android/repository/platform-tools-latest-${os}.zip`;
const zip = join(vendor, "platform-tools.zip");
mkdirSync(vendor, { recursive: true });
console.log("Downloading", url);
const res = await fetch(url);
if (!res.ok) { console.error("Download failed:", res.status); process.exit(1); }
await pipeline(res.body, createWriteStream(zip));
if (process.platform === "win32") execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${zip}' -DestinationPath '${vendor}'`], { stdio: "inherit" });
else execFileSync("unzip", ["-q", "-o", zip, "-d", vendor], { stdio: "inherit" });
rmSync(zip, { force: true });
console.log("adb installed in", target);
