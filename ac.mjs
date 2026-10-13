// Air conditioner over a Broadlink RM (IR blaster): discovery, learning IR codes from the
// original remote, and sending learned codes.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { discover, genDevice } = require("node-broadlink");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createAc(getInfo, onStatus, onDevice, t = (k) => k) {
  const st = { connected: false, locked: false, device: null, learning: null, busy: null, error: null };
  let dev = null, cancelLearn = false;
  const emit = () => onStatus({ ...st });

  async function find() {
    const devs = await discover(5000);
    const rm = devs.find((d) => /^Rm/i.test(d.constructor.name)) || devs[0];
    if (!rm) return null;
    const info = { host: rm.host.address, port: rm.host.port || 80, mac: [...rm.mac], devtype: rm.deviceType, model: rm.model || rm.constructor.name, locked: !!rm.isLocked };
    onDevice(info);
    return info;
  }
  async function connect({ rediscover = false } = {}) {
    if (st.busy === "connect") return st.connected;
    st.busy = "connect"; st.error = null; emit();
    try {
      let info = rediscover ? null : getInfo();
      if (!info) info = await find();
      if (!info) { st.connected = false; st.device = null; st.error = t("No Broadlink found on the network. It must be on the same Wi-Fi network as this computer."); return false; }
      st.device = { model: info.model, host: info.host };
      dev = genDevice(info.devtype, { address: info.host, port: info.port || 80, family: "IPv4", size: 128 }, info.mac);
      try {
        await dev.auth();
        st.connected = true; st.locked = false;
      } catch (e) {
        st.connected = false;
        st.locked = String(e.message) === "65535" || !!info.locked;
        st.error = st.locked ? t("The Broadlink is locked. In the Broadlink app open the device → settings (⋯) → turn off “Lock device”, then reconnect.") : t("Could not connect to the Broadlink ({error}).", { error: e.message });
      }
      return st.connected;
    } catch (e) { st.connected = false; st.error = e.message; return false; }
    finally { st.busy = null; emit(); }
  }
  async function ensure() {
    if (!dev || !st.connected) await connect();
    if (!st.connected) throw new Error(st.error || t("Broadlink not connected."));
    return dev;
  }
  // Put the RM in learning mode and wait (up to 30 s) for an IR code; resolves with the hex payload.
  async function learn(key) {
    if (st.learning) throw new Error(t("A learning session is already running."));
    const d = await ensure();
    st.learning = key; cancelLearn = false; emit();
    try {
      await d.enterLearning();
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        if (cancelLearn) throw new Error(t("Learning cancelled."));
        await sleep(800);
        try {
          const data = await d.checkData();
          if (data && data.length) return Buffer.from(data).toString("hex");
        } catch { /* no data yet */ }
      }
      throw new Error(t("No signal received in 30 s. Point the remote at the Broadlink (less than 1 m away) and press the button."));
    } finally { st.learning = null; emit(); }
  }
  async function send(hex) {
    const d = await ensure();
    try { await d.sendData(hex); }
    catch (e) { st.connected = false; emit(); throw new Error(t("Could not send the code ({error}).", { error: e.message })); }
  }
  return { connect, learn, send, cancel: () => { cancelLearn = true; }, get: () => ({ ...st }) };
}
