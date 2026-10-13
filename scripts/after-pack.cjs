// electron-builder afterPack hook (macOS): give the app's executables their own Mach-O UUID.
//
// electron-builder only renames Electron's prebuilt binaries, so "Couch Control" keeps the exact LC_UUID of the
// stock Electron executable. macOS Local Network privacy resolves the process by that UUID, maps it to whatever
// Electron app it saw first (com.github.Electron) and never shows the permission alert for this app, while the
// kernel keeps blocking its LAN connections. A stable UUID derived from the app id fixes the identity (and keeps
// it across rebuilds, so the user's grant survives updates). Runs before signing.
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync, readdirSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const LC_UUID = 0x1b;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;

// Rewrites the LC_UUID of one thin 64-bit Mach-O slice starting at `base`. Returns true if found.
function patchSlice(buf, base, uuid) {
  if (buf.readUInt32LE(base) !== MH_MAGIC_64) return false;
  const ncmds = buf.readUInt32LE(base + 16);
  let off = base + 32;
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(off), size = buf.readUInt32LE(off + 4);
    if (cmd === LC_UUID) { uuid.copy(buf, off + 8); return true; }
    off += size;
  }
  return false;
}

function patchFile(file, seed) {
  const buf = readFileSync(file);
  let patched = 0;
  const uuidFor = (arch) => createHash("sha256").update(`${seed}:${arch}`).digest().subarray(0, 16);
  if (buf.readUInt32BE(0) === FAT_MAGIC) {
    const n = buf.readUInt32BE(4);
    for (let i = 0; i < n; i++) {
      const entry = 8 + i * 20;
      if (patchSlice(buf, buf.readUInt32BE(entry + 8), uuidFor(buf.readUInt32BE(entry)))) patched++;
    }
  } else if (patchSlice(buf, 0, uuidFor(buf.readUInt32LE(4)))) patched++;
  if (!patched) throw new Error(`after-pack: no LC_UUID found in ${file}`);
  writeFileSync(file, buf);
  return patched;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin" && context.electronPlatformName !== "mas") return;
  const name = context.packager.appInfo.productFilename;
  const appId = context.packager.appInfo.id;
  const contents = join(context.appOutDir, `${name}.app`, "Contents");
  const targets = [join(contents, "MacOS", name)];
  const frameworks = join(contents, "Frameworks");
  for (const entry of readdirSync(frameworks)) {
    if (!entry.endsWith(".app")) continue;
    const exe = join(frameworks, entry, "Contents", "MacOS", entry.slice(0, -4));
    if (existsSync(exe)) targets.push(exe);
  }
  for (const file of targets) {
    const label = file.slice(contents.length + 1);
    patchFile(file, `${appId}:${label}`);
    console.log(`  • after-pack: unique Mach-O UUID for ${label}`);
  }
};
