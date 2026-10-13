// Google Cast sender: receiver status (running app, volume), media session control,
// and casting URLs / local files to the Default Media Receiver.
import castv2 from "castv2-client";
import { createServer } from "node:http";
import { statSync, createReadStream } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, basename } from "node:path";

const { Client, DefaultMediaReceiver } = castv2;
const MEDIA_NS = "urn:x-cast:com.google.cast.media";
const TYPES = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };

export function createCast(getHost, onStatus, t = (k) => k) {
  const status = { connected: false, app: null, statusText: null, volume: null, media: null, mine: false, error: null };
  let client = null, player = null, joinedSession = null, reconnectTimer = null, server = null, stopped = false;
  const emit = () => onStatus({ ...status });

  function cleanup() {
    try { client?.close(); } catch {}
    client = null; player = null; joinedSession = null;
    Object.assign(status, { connected: false, app: null, statusText: null, media: null, mine: false });
    emit();
  }
  function scheduleReconnect(ms = 5000) {
    clearTimeout(reconnectTimer);
    if (!stopped) reconnectTimer = setTimeout(connect, ms);
  }

  function connect() {
    const host = getHost();
    if (client || !host) return;
    const c = (client = new Client());
    c.on("error", (e) => { status.error = e.message; if (client === c) { cleanup(); scheduleReconnect(); } });
    c.client.on("close", () => { if (client === c) { cleanup(); scheduleReconnect(); } });
    c.connect(host, () => {
      if (client !== c) return;
      status.connected = true; status.error = null;
      c.receiver.on("status", handleReceiverStatus);
      c.getStatus((err, s) => { if (!err && s) handleReceiverStatus(s); else emit(); });
    });
  }

  function handleReceiverStatus(s) {
    const app = s.applications?.[0] ?? null;
    status.app = app ? { id: app.appId, name: app.displayName, statusText: app.statusText, sessionId: app.sessionId, idle: !!app.isIdleScreen } : null;
    status.statusText = app?.statusText ?? null;
    if (s.volume) status.volume = { level: s.volume.level, muted: s.volume.muted };
    if (!app || app.isIdleScreen) { player = null; joinedSession = null; status.media = null; status.mine = false; }
    else if (app.sessionId !== joinedSession && app.transportId && (app.namespaces || []).some((n) => n.name === MEDIA_NS)) { if (joinedSession) status.mine = false; join(app); }
    emit();
  }

  function attach(p, session) {
    player = p; joinedSession = session.sessionId;
    p.on("status", handleMediaStatus);
    p.on("close", () => { if (player === p) { player = null; joinedSession = null; status.media = null; emit(); } });
    p.getStatus((err, m) => { if (!err) handleMediaStatus(m); });
  }
  function join(session) {
    joinedSession = session.sessionId;
    client?.join(session, DefaultMediaReceiver, (err, p) => { if (err) { joinedSession = null; return; } attach(p, session); });
  }
  function handleMediaStatus(m) {
    if (!m) { status.media = null; return emit(); }
    const md = m.media?.metadata || {};
    status.media = {
      state: m.playerState, title: md.title || null, subtitle: md.subtitle || md.artist || md.seriesTitle || null,
      image: md.images?.[0]?.url || null, duration: m.media?.duration || 0, currentTime: m.currentTime || 0,
      contentId: m.media?.contentId || null, contentType: m.media?.contentType || null,
      artist: md.artist || null, album: md.albumName || null, supports: m.supportedMediaCommands || 0, appName: status.app?.name || null,
    };
    emit();
  }

  // ----- actions -----
  const play = (url, { title, contentType } = {}) => new Promise((resolve, reject) => {
    if (!client) return reject(new Error(t("Cast not connected")));
    const type = contentType || TYPES[extname(url.split("?")[0]).slice(1).toLowerCase()] || "video/mp4";
    client.launch(DefaultMediaReceiver, (err, p) => {
      if (err) return reject(err);
      status.mine = true;
      attach(p, p.session);
      const meta = { type: 0, metadataType: 0, title: title || basename(url.split("?")[0]) };
      if (type.startsWith("image/")) { meta.metadataType = 4; meta.images = [{ url }]; }
      p.load({ contentId: url, contentType: type, streamType: "BUFFERED", metadata: meta }, { autoplay: true }, (e, m) => { if (e) reject(e); else { handleMediaStatus(m); resolve(true); } });
    });
  });
  const control = (action, value) => new Promise((resolve) => {
    if (!player) return resolve(false);
    const cb = (err, m) => { if (!err && m) handleMediaStatus(m); resolve(!err); };
    if (action === "seek") player.seek(Number(value), cb);
    else if (action === "next" || action === "prev") player.media.sessionRequest({ type: "QUEUE_UPDATE", jump: action === "next" ? 1 : -1 }, cb);
    else if (typeof player[action] === "function") player[action](cb); else resolve(false);
  });
  const stopApp = () => new Promise((resolve) => {
    const sid = status.app?.sessionId;
    if (!client || !sid) return resolve(false);
    client.receiver.stop(sid, (err) => resolve(!err));
  });
  const setVolume = (level) => new Promise((resolve) => { if (!client) return resolve(false); client.setVolume({ level: Math.max(0, Math.min(1, level)) }, (err, v) => { if (!err && v) { status.volume = { level: v.level, muted: v.muted }; emit(); } resolve(!err); }); });
  const setMuted = (muted) => new Promise((resolve) => { if (!client) return resolve(false); client.setVolume({ muted }, (err, v) => { if (!err && v) { status.volume = { level: v.level, muted: v.muted }; emit(); } resolve(!err); }); });

  // Serve one local file over LAN (with Range support) and cast it.
  function lanIp() {
    const host = getHost() || ""; const prefix = host.split(".").slice(0, 3).join(".") + ".";
    const all = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal);
    return (all.find((i) => i.address.startsWith(prefix)) || all[0])?.address;
  }
  const castFile = (path) => new Promise((resolve, reject) => {
    const ip = lanIp(); if (!ip) return reject(new Error(t("Local IP address not found")));
    const type = TYPES[extname(path).slice(1).toLowerCase()];
    if (!type) return reject(new Error(t("Format not supported by Cast")));
    server?.close();
    server = createServer((req, res) => {
      const size = statSync(path).size; const range = req.headers.range;
      res.setHeader("Content-Type", type); res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Access-Control-Allow-Origin", "*");
      if (range) {
        const [a, b] = range.replace("bytes=", "").split("-"); const start = Number(a) || 0; const end = b ? Number(b) : size - 1;
        res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
        createReadStream(path, { start, end }).pipe(res);
      } else { res.writeHead(200, { "Content-Length": size }); createReadStream(path).pipe(res); }
    });
    server.listen(0, "0.0.0.0", () => {
      const url = `http://${ip}:${server.address().port}/${encodeURIComponent(basename(path))}`;
      play(url, { title: basename(path), contentType: type }).then(resolve, reject);
    });
  });

  return { connect, get: () => ({ ...status }), play, control, stopApp, setVolume, setMuted, castFile,
    stop: () => { stopped = true; clearTimeout(reconnectTimer); server?.close(); cleanup(); },
    reset: () => { cleanup(); stopped = false; connect(); } };
}
