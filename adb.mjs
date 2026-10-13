// Optional ADB bridge (network debugging on the TV) to launch apps that have no deep link
// and to discover installed packages. Uses the bundled platform-tools adb binary.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const run = promisify(execFile);

export function createAdb(getHost, candidates, onStatus, t = (k) => k) {
  const bin = candidates.find((p) => existsSync(p));
  const status = { available: !!bin, connected: false, authorized: false, error: null, packages: [] };
  const emit = () => onStatus({ ...status });
  const target = () => `${getHost()}:5555`;
  const adb = async (...args) => (await run(bin, args, { timeout: 20000 })).stdout;

  async function connect() {
    if (!bin) { status.error = t("adb binary not found."); emit(); return false; }
    if (!getHost()) return false;
    try {
      const out = await adb("connect", target());
      status.connected = /connected/i.test(out) && !/cannot|failed|refused/i.test(out);
      status.error = status.connected ? null : out.trim();
      if (status.connected) {
        const st = (await adb("-s", target(), "get-state").catch((e) => e.stderr || e.message)).trim();
        status.authorized = st === "device";
        if (!status.authorized) status.error = /unauthorized/.test(st) ? t("Accept the “Allow USB debugging?” prompt on the TV.") : st;
      }
    } catch (e) { status.connected = false; status.authorized = false; status.error = (e.stderr || e.message).trim(); }
    emit();
    return status.connected && status.authorized;
  }
  async function shell(cmd) {
    if (!(status.connected && status.authorized) && !(await connect())) throw new Error(status.error || t("ADB not connected"));
    try { return await adb("-s", target(), "shell", cmd); }
    catch (e) { status.connected = false; emit(); throw new Error((e.stderr || e.message).trim()); }
  }
  // Try the TV (leanback) launcher category first, then the phone one, then resolve the MAIN activity explicitly.
  const launch = async (pkg) => {
    for (const cat of ["LEANBACK_LAUNCHER", "LAUNCHER"]) {
      const out = await shell(`monkey -p ${pkg} -c android.intent.category.${cat} 1`).catch(() => "");
      if (out && !/No activities found|monkey aborted/i.test(out)) return true;
    }
    const comp = (await shell(`cmd package resolve-activity --brief -a android.intent.action.MAIN ${pkg}`)).trim().split(/\r?\n/).pop();
    if (!comp || !comp.includes("/")) throw new Error(t("Could not open {pkg}", { pkg }));
    const out = await shell(`am start -n ${comp}`);
    if (/Error|does not exist/i.test(out)) throw new Error(t("Could not open {pkg}", { pkg }));
    return true;
  };
  const packages = async () => {
    const out = await shell("pm list packages -3");
    status.packages = out.split(/\r?\n/).map((l) => l.replace(/^package:/, "").trim()).filter(Boolean).sort();
    emit();
    return status.packages;
  };
  const disconnect = async () => { try { if (bin) await adb("disconnect", target()); } catch {} status.connected = false; status.authorized = false; emit(); };
  return { connect, launch, packages, disconnect, shell, get: () => ({ ...status }) };
}
