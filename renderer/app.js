const { APPS, INPUT_PKGS, hdmiInputs, HDMI_BASE_DEFAULT, DEVICE_TYPES, AC_MODES, AC_FANS } = window.tv.constants;
const $ = (s) => document.querySelector(s);

// ---------- i18n (English source strings, dictionaries from shared/i18n.cjs) ----------
let t = (k, vars) => fill(k, vars);
const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s);
function makeT(locale) {
  const lang = String(locale || "en").toLowerCase().split(/[-_]/)[0];
  const dict = window.tv.i18n.dicts[lang] || {};
  const fn = (k, vars) => fill(dict[k] ?? k, vars);
  fn.lang = window.tv.i18n.dicts[lang] ? lang : "en";
  return fn;
}
const originals = new WeakMap(); // node/attr -> English source text, so the DOM can be re-translated
function translateDom() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim() || n.parentElement.closest("script,style")) continue;
    if (!originals.has(n)) originals.set(n, n.nodeValue);
    const src = originals.get(n), lead = src.match(/^\s*/)[0], trail = src.match(/\s*$/)[0];
    n.nodeValue = lead + t(src.trim()) + trail;
  }
  for (const attr of ["title", "placeholder"]) {
    for (const el of document.querySelectorAll(`[${attr}]`)) {
      if (!el.dataset["i18n_" + attr]) el.dataset["i18n_" + attr] = el.getAttribute(attr);
      el.setAttribute(attr, t(el.dataset["i18n_" + attr]));
    }
  }
  document.documentElement.lang = t.lang;
}

// ---------- state ----------
const deviceOf = (i) => DEVICE_TYPES.find((d) => d.id === i?.type) || DEVICE_TYPES[0];
let INPUTS = window.tv.constants.INPUTS;
const rebuildInputs = () => {
  const custom = config.inputs || {};
  INPUTS = [
    ...hdmiInputs(config.hdmiBase || HDMI_BASE_DEFAULT).map((i) => ({ ...i, port: i.name, name: custom[i.id]?.name || i.name, type: custom[i.id]?.type || "hdmi" })),
    ...window.tv.constants.INPUTS.filter((i) => !i.id.startsWith("hdmi")),
  ];
};
let config = { favorites: [], name: "", ip: "", paired: false };
let state = { status: "disconnected", powered: null, volume: null, app: null, appName: null, error: null };
let activeInput = null;
let playing = null; // null = no media app on screen; true/false = local guess of the playback state
let lastMediaApp = null;
let castState = { connected: false };
let seekBusy = false;
let adbState = { available: false, connected: false };
let acState = { connected: false, last: { power: false, mode: "cool", temp: 24, fan: "auto" }, codes: [], minTemp: 16, maxTemp: 30 };
let learnSeq = null;
let sliderBusy = false;
const appByName = (name) => APPS.find((x) => x.name.toLowerCase() === String(name || "").toLowerCase());
const appByPkg = (pkg) => APPS.find((a) => a.pkg.includes(pkg));
const isMediaApp = (a) => !!a && a.media !== false;
const audioCfg = () => ({ soundbar: !!config.audio?.soundbar, ratio: Math.max(1, Number(config.audio?.ratio) || 3), name: config.audio?.name || t("Sound bar") });
const volRatio = () => (audioCfg().soundbar ? audioCfg().ratio : 1);
const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

// ---------- helpers ----------
const sendKey = (name, long) => { flash(); return window.tv.key(name, long); };
function flash() { const el = $("#connStatus"); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 250); }
function appIcon(a, cls = "app-ico") {
  const d = document.createElement("div");
  d.className = cls; d.style.background = a.bg; d.style.color = a.fg;
  if (a.logo) {
    const l = document.createElement("span"); l.className = "logo";
    l.style.setProperty("--logo", `url("../assets/logos/${a.logo}.svg")`); l.style.background = a.fg;
    if (a.lw) l.style.setProperty("--lw", a.lw); if (a.lh) l.style.setProperty("--lh", a.lh);
    d.appendChild(l);
  } else if (a.svg) d.innerHTML = a.svg;
  else { d.textContent = a.glyph || "?"; if ((a.glyph || "").length > 2) d.classList.add("text-sm"); }
  return d;
}
function toast(text, cls = "") { const el = $("#toast"); el.textContent = text; el.className = "toast " + cls; el.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 4500); }
const fmtTime = (s) => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
  $("#content").scrollTop = 0;
  if (name === "settings") fillSettings();
}
$("#tabs").addEventListener("click", (e) => { const b = e.target.closest(".tab"); if (b) showTab(b.dataset.tab); });
document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.goto)));

// ---------- generic key buttons ----------
document.addEventListener("click", (e) => { const b = e.target.closest("[data-key]"); if (b) sendKey(b.dataset.key); });
// Play / pause: explicit PLAY / PAUSE keys so the button does what it shows; MEDIA_PLAY_PAUSE when the state is unknown.
function togglePlay(viaToggleKey = false) {
  if (viaToggleKey || playing === null) { sendKey("MEDIA_PLAY_PAUSE"); playing = !playing; }
  else if (playing === false) { sendKey("MEDIA_PLAY"); playing = true; }
  else { sendKey("MEDIA_PAUSE"); playing = false; }
  renderPlay();
}
document.addEventListener("click", (e) => { if (e.target.closest(".play-toggle")) togglePlay(); });
function renderPlay() {
  document.querySelectorAll(".play-toggle").forEach((b) => { b.innerHTML = playing ? ICON_PAUSE : ICON_PLAY; b.title = playing ? t("Pause") : t("Play"); });
}
// Long press on the d-pad / volume rocker repeats the key.
let pressTimer;
document.addEventListener("mousedown", (e) => {
  const b = e.target.closest(".dpad-btn[data-key], .rocker [data-key]");
  if (!b) return;
  pressTimer = setTimeout(() => { pressTimer = setInterval(() => sendKey(b.dataset.key), 150); }, 450);
});
["mouseup", "mouseleave"].forEach((ev) => document.addEventListener(ev, () => { clearTimeout(pressTimer); clearInterval(pressTimer); }, true));

// ---------- header ----------
$("#powerBtn").addEventListener("click", () => { flash(); window.tv.power(); });
$("#menuBtn").addEventListener("click", (e) => { e.stopPropagation(); $("#menu").hidden = !$("#menu").hidden; });
document.addEventListener("click", () => { $("#menu").hidden = true; });
$("#menu").addEventListener("click", (e) => {
  const act = e.target.dataset.act;
  if (act === "reconnect") window.tv.reconnect();
  if (act === "settings") showTab("settings");
  if (act === "quit") window.tv.quit();
});
$("#quitBtn").addEventListener("click", () => window.tv.quit());

// ---------- volume (in sound bar units when a sound bar is configured) ----------
const slider = $("#volSlider");
slider.addEventListener("input", () => { sliderBusy = true; paintSlider(slider.value); $("#volValue").textContent = slider.value; });
slider.addEventListener("change", async () => { await window.tv.setVolume(Number(slider.value) * volRatio()); sliderBusy = false; });
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-vol]"); if (!b) return;
  flash();
  const r = volRatio(), step = Number(b.dataset.vol);
  if (state.volume) { const cur = Math.round(state.volume.level / r); window.tv.setVolume(Math.max(0, Math.min(Math.floor((state.volume.maximum || 100) / r), cur + step)) * r); }
  else sendKey(step > 0 ? "VOLUME_UP" : "VOLUME_DOWN");
});
$("#muteBtn").addEventListener("click", () => { if (castState.connected && state.volume) { flash(); window.tv.castMute(!state.volume.muted); } else sendKey("VOLUME_MUTE"); });
function paintSlider(v) { slider.style.setProperty("--pct", `${(100 * v) / (slider.max || 100)}%`); }

// ---------- apps ----------
async function launch(a) {
  flash();
  const r = await window.tv.launch(a.id);
  if (!r.ok) toast(r.error);
}
function renderApps() {
  const fav = $("#favGrid"), all = $("#allApps");
  fav.innerHTML = ""; all.innerHTML = "";
  const favs = config.favorites.map((id) => APPS.find((a) => a.id === id)).filter(Boolean);
  for (const a of favs) fav.appendChild(appButton(a));
  for (const a of APPS.filter((x) => !x.hidden)) all.appendChild(appButton(a));
  markCurrentApp();
}
function appButton(a) {
  const b = document.createElement("button");
  b.className = "app"; b.dataset.app = a.id; b.title = t(a.name);
  b.appendChild(appIcon(a));
  const n = document.createElement("span"); n.className = "app-name"; n.textContent = t(a.name); b.appendChild(n);
  b.addEventListener("click", () => launch(a));
  b.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const favs = config.favorites.includes(a.id) ? config.favorites.filter((x) => x !== a.id) : [...config.favorites, a.id];
    window.tv.saveConfig({ favorites: favs });
  });
  return b;
}
function markCurrentApp() {
  const cur = appByPkg(state.app)?.id;
  document.querySelectorAll(".app").forEach((b) => b.classList.toggle("current", b.dataset.app === cur));
}

// ---------- inputs ----------
function renderInputs() {
  const onInput = INPUT_PKGS.includes(state.app);
  for (const el of [$("#inputListHome"), $("#inputListFull")]) {
    el.innerHTML = "";
    const list = el.id === "inputListHome" ? INPUTS.slice(0, 4) : INPUTS;
    for (const i of list) {
      const b = document.createElement("button");
      b.className = "input" + (activeInput === i.id && onInput ? " active" : "");
      const dev = i.type ? deviceOf(i) : null;
      const ico = dev && dev.id !== "hdmi" ? appIcon(dev, "input-ico dev").outerHTML : `<div class="input-ico">${i.id.startsWith("hdmi") ? "HDMI" : "⇄"}</div>`;
      const sub = i.port ? (dev && dev.id !== "hdmi" ? `${i.port} · ${t(dev.name)}` : t("{port} input", { port: i.port })) : t("Opens the input menu on the TV");
      const here = activeInput === i.id && onInput;
      b.innerHTML = `${ico}<div><div class="input-name">${t(i.name)}</div><div class="input-sub">${here ? sub + " · " + t("On screen") : sub}</div></div>${here ? `<span class="badge">${t("ON SCREEN ✓")}</span>` : ""}`;
      b.addEventListener("click", () => { activeInput = i.id; window.tv.setInput(i.id); flash(); if (i.link) window.tv.app(i.link); else sendKey(i.key); renderInputs(); renderHome(); });
      el.appendChild(b);
    }
  }
}

// ---------- cast (sessions started by this app: links and local files) ----------
function renderCast() {
  const cs = castState, media = cs.mine ? cs.media : null;
  $("#castMedia").hidden = !media;
  $("#castStopApp").hidden = !(cs.app && !cs.app.idle && cs.mine);
  if (media) {
    $("#castTitle").textContent = media.title || t("Content");
    $("#castSub").textContent = [media.subtitle, { PLAYING: t("Playing"), PAUSED: t("Paused"), BUFFERING: t("Loading…"), IDLE: t("Stopped") }[media.state] || media.state].filter(Boolean).join(" · ");
    const img = $("#castImg"); if (media.image) { img.src = media.image; img.hidden = false; } else img.hidden = true;
    $("#castPlay").innerHTML = media.state === "PLAYING" ? ICON_PAUSE : ICON_PLAY;
    if (!seekBusy) { const seek = $("#castSeek"); seek.max = Math.max(1, Math.round(media.duration)); seek.value = Math.round(media.currentTime); seek.style.setProperty("--pct", `${(100 * media.currentTime) / Math.max(1, media.duration)}%`); }
    $("#castCur").textContent = fmtTime(media.currentTime); $("#castDur").textContent = fmtTime(media.duration);
  }
}
$("#castPlay").addEventListener("click", () => { flash(); window.tv.castControl(castState.media?.state === "PLAYING" ? "pause" : "play"); });
document.querySelectorAll("[data-cast]").forEach((b) => b.addEventListener("click", () => {
  const act = b.dataset.cast, m = castState.media; flash();
  if (act === "stop") window.tv.castControl("stop");
  else if (m) window.tv.castControl("seek", Math.max(0, Math.min(m.duration, m.currentTime + (act === "seek-fwd" ? 15 : -15))));
}));
$("#castSeek").addEventListener("input", () => { seekBusy = true; $("#castCur").textContent = fmtTime($("#castSeek").value); });
$("#castSeek").addEventListener("change", async () => { await window.tv.castControl("seek", Number($("#castSeek").value)); seekBusy = false; });
$("#castStopApp").addEventListener("click", () => { flash(); window.tv.castStopApp(); });
const ytId = (url) => { try { const u = new URL(url); if (u.hostname === "youtu.be") return u.pathname.slice(1); if (u.hostname.endsWith("youtube.com")) return u.searchParams.get("v") || (u.pathname.startsWith("/shorts/") ? u.pathname.split("/")[2] : null); } catch {} return null; };
function castMsg(text, cls) { const b = $("#castMsg"); b.hidden = !text; b.className = "status-box " + (cls || ""); b.textContent = text || ""; }
$("#castSend").addEventListener("click", async () => {
  const url = $("#castUrl").value.trim(); if (!url) return;
  const id = ytId(url);
  if (id) { window.tv.app("vnd.youtube:" + id); castMsg(t("Opening in the YouTube app…"), "ok"); return; }
  castMsg(t("Sending…"), "warn");
  const r = await window.tv.castPlay(url, null);
  castMsg(r.ok ? t("Playing on the TV.") : t("Could not play: {error}", { error: r.error }), r.ok ? "ok" : "err");
});
$("#castUrlBtn").addEventListener("click", () => { const b = $("#castUrlBox"); b.hidden = !b.hidden; if (!b.hidden) $("#castUrl").focus(); });
$("#castUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#castSend").click(); });
$("#castFileBtn").addEventListener("click", async () => {
  const r = await window.tv.castFile();
  if (r.canceled) return;
  castMsg(r.ok ? t("Playing the file on the TV.") : t("Could not send: {error}", { error: r.error }), r.ok ? "ok" : "err");
});
$("#airplayBtn").addEventListener("click", async () => {
  flash(); castMsg(t("Opening AirPlay Server…"), "warn");
  const r = await window.tv.launch("airplay");
  castMsg(r.ok ? t("AirPlay Server is open. Look for the TV in the AirPlay menu (Control Center → Screen Mirroring).") : r.error, r.ok ? "ok" : "err");
});

// ---------- timelines (progress keeps ticking between cast status updates) ----------
function makeTimeline(curId, seekId, durId) {
  const el = { cur: $(curId), seek: $(seekId), dur: $(durId) };
  const tl = { media: null, base: { t: 0, at: 0 }, busy: false, tick: null };
  const paint = () => {
    const m = tl.media; if (!m || tl.busy) return;
    const pos = m.state === "PLAYING" ? Math.min(m.duration || Infinity, tl.base.t + (Date.now() - tl.base.at) / 1000) : tl.base.t;
    el.seek.value = Math.round(pos); el.seek.style.setProperty("--pct", `${(100 * pos) / Math.max(1, m.duration || 1)}%`);
    el.cur.textContent = fmtTime(pos);
  };
  tl.update = (m) => {
    tl.media = m;
    if (!m) { clearInterval(tl.tick); tl.tick = null; return; }
    tl.base = { t: m.currentTime || 0, at: Date.now() };
    el.seek.max = Math.max(1, Math.round(m.duration || 0)); el.dur.textContent = fmtTime(m.duration);
    paint(); if (!tl.tick) tl.tick = setInterval(paint, 1000);
  };
  el.seek.addEventListener("input", () => { tl.busy = true; el.cur.textContent = fmtTime(el.seek.value); });
  el.seek.addEventListener("change", async () => { await window.tv.castControl("seek", Number(el.seek.value)); tl.busy = false; });
  return tl;
}
const nowTl = makeTimeline("#nowCur", "#nowSeek", "#nowDur");
const bgTl = makeTimeline("#bgCur", "#bgSeek", "#bgDur");
// Timeline under the Now tile: the on-screen app's own cast session (e.g. YouTube) when it reports a duration.
function renderNowTimeline(a, media) {
  const cm = castState.media, same = a && castState.app && !castState.mine && String(castState.app.name).toLowerCase() === a.name.toLowerCase();
  const show = media && same && cm && cm.duration > 0 && ["PLAYING", "PAUSED", "BUFFERING"].includes(cm.state);
  $("#nowTimeline").hidden = !show;
  nowTl.update(show ? cm : null);
}

// ---------- background player (a cast session of an app that is not on screen, e.g. Spotify Connect) ----------
function bgSession() {
  const cs = castState, m = cs.media;
  if (!m || cs.mine || !cs.app || cs.app.idle) return null;
  if (!["PLAYING", "PAUSED", "BUFFERING"].includes(m.state)) return null;
  const onScreen = appByPkg(state.app);
  if (onScreen && onScreen.name.toLowerCase() === String(cs.app.name).toLowerCase()) return null; // the Now tile already covers it
  return m;
}
function renderBgPlayer() {
  const m = bgSession(); const tile = $("#bgPlayer");
  tile.hidden = !m;
  if (!m) { bgTl.update(null); return; }
  const app = appByName(castState.app.name);
  const ico = $("#bgIco"); const fresh = app ? appIcon(app, "bg-ico") : null;
  if (fresh) { fresh.id = "bgIco"; ico.replaceWith(fresh); } else { ico.innerHTML = ""; ico.style.background = "var(--card2)"; }
  $("#bgTitle").textContent = m.title || castState.app.name;
  $("#bgSub").textContent = [m.artist, m.album].filter(Boolean).join(" · ") || castState.app.name;
  $("#bgPlay").innerHTML = m.state === "PLAYING" ? ICON_PAUSE : ICON_PLAY;
  bgTl.update(m);
}
$("#bgPlay").addEventListener("click", () => { flash(); window.tv.castControl(castState.media?.state === "PLAYING" ? "pause" : "play"); });
document.querySelectorAll("[data-bg]").forEach((b) => b.addEventListener("click", () => { flash(); window.tv.castControl(b.dataset.bg); }));

// ---------- content shortcuts ----------
const APP_HOSTS = [["netflix.com", "netflix"], ["youtube.com", "youtube"], ["youtu.be", "youtube"], ["primevideo.com", "prime"], ["amazon.com", "prime"], ["disneyplus.com", "disney"], ["spotify.com", "spotify"], ["crunchyroll.com", "crunchy"], ["twitch.tv", "twitch"], ["kick.com", "kick"]];
const appForUrl = (url) => { try { const h = new URL(url).hostname; return APPS.find((x) => x.id === (APP_HOSTS.find(([d]) => h === d || h.endsWith("." + d))?.[1])); } catch { return null; } };
function renderShortcuts() {
  const g = $("#shortcutGrid"); g.innerHTML = "";
  for (const [i, s] of (config.shortcuts || []).entries()) {
    const app = APPS.find((x) => x.id === s.app) || appForUrl(s.url) || { bg: "#3a3a40", fg: "#fff", glyph: "▶", name: t("Link") };
    const b = document.createElement("button"); b.className = "app"; b.title = s.url;
    const ico = appIcon(app); ico.classList.add("sc"); ico.insertAdjacentHTML("beforeend", '<span class="sc-badge"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>'); b.appendChild(ico);
    const n = document.createElement("span"); n.className = "app-name"; n.textContent = s.name; b.appendChild(n);
    b.addEventListener("click", () => { flash(); const id = ytId(s.url); window.tv.app(id ? "vnd.youtube:" + id : s.url); });
    b.addEventListener("contextmenu", (e) => { e.preventDefault(); const list = [...config.shortcuts]; list.splice(i, 1); window.tv.saveConfig({ shortcuts: list }); });
    g.appendChild(b);
  }
}
$("#scAdd").addEventListener("click", () => {
  const name = $("#scName").value.trim(), url = $("#scUrl").value.trim();
  if (!name || !/^https?:\/\//.test(url)) return;
  window.tv.saveConfig({ shortcuts: [...(config.shortcuts || []), { name, url, app: appForUrl(url)?.id || null }] });
  $("#scName").value = ""; $("#scUrl").value = "";
});

// ---------- keyboard ----------
$("#sendText").addEventListener("click", () => { const txt = $("#textInput").value; if (txt) { window.tv.text(txt); flash(); } });
$("#textInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#sendText").click(); } });
$("#sendClipboard").addEventListener("click", async () => { const txt = await navigator.clipboard.readText(); if (txt) { window.tv.text(txt); flash(); } });
// Keyboard shortcuts when nothing editable is focused.
document.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
  if (["+", "=", "-"].includes(e.key)) { e.preventDefault(); document.querySelector(`[data-vol="${e.key === "-" ? -1 : 1}"]`)?.click(); return; }
  const map = { ArrowUp: "DPAD_UP", ArrowDown: "DPAD_DOWN", ArrowLeft: "DPAD_LEFT", ArrowRight: "DPAD_RIGHT", Enter: "DPAD_CENTER", Escape: "BACK", Backspace: "BACK", h: "HOME", m: "VOLUME_MUTE", n: "MEDIA_NEXT", p: "MEDIA_PREVIOUS" };
  if (e.key === " ") { e.preventDefault(); togglePlay(true); return; }
  const k = map[e.key];
  if (k) { e.preventDefault(); sendKey(k); }
});

// ---------- air conditioner ----------
const modeName = (id) => t(AC_MODES.find((m) => m.id === id)?.name || id);
const fanName = (id) => t(AC_FANS.find((f) => f.id === id)?.name || id);
async function acSet(patch) {
  flash();
  const r = await window.tv.acSet(patch);
  if (!r.ok) toast(r.error + (r.missing ? " " + t("Learn it in Settings → Air conditioner.") : ""));
  else if (r.fallback) toast(t("Sent with another fan speed (the exact one is not learned)."), "ok");
}
document.addEventListener("click", (e) => {
  const tb = e.target.closest("[data-ac-temp]"); if (tb) acSet({ temp: acState.last.temp + Number(tb.dataset.acTemp) });
  const mo = e.target.closest("[data-ac-mode]"); if (mo) acSet({ mode: mo.dataset.acMode });
});
$("#acPower").addEventListener("click", () => acSet({ power: !acState.last.power }));
const learnSel = () => ({ mode: $("#learnMode").value || acState.last.mode, fan: $("#learnFan").value || acState.last.fan });
function renderAc() {
  const s = acState, l = s.last;
  // Home tile
  $("#acTemp").textContent = l.temp;
  $("#acStatus").textContent = !s.connected
    ? (s.busy === "connect" ? t("Connecting to the Broadlink…") : s.locked ? t("Broadlink is locked") : t("Broadlink not connected"))
    : l.power ? t("{mode} · fan {fan}", { mode: modeName(l.mode), fan: fanName(l.fan).toLowerCase() }) : t("Off");
  const tile = $("#acTile"); tile.classList.toggle("on", !!l.power);
  $("#acIco").innerHTML = (AC_MODES.find((m) => m.id === l.mode) || AC_MODES[0]).svg;
  $("#acPower").classList.toggle("on", !!l.power); $("#acPower").title = l.power ? t("Turn the AC off") : t("Turn the AC on");
  $("#acModes").innerHTML = AC_MODES.map((m) => `<button class="seg ${l.mode === m.id ? "sel" : ""}" data-ac-mode="${m.id}" title="${t(m.name)}">${m.svg}<span>${t(m.name)}</span></button>`).join("");
  // Settings: Broadlink status + learning
  const bl = $("#acBl"); bl.className = "status-box";
  if (s.busy === "connect") { bl.classList.add("warn"); bl.textContent = t("Searching for the Broadlink on the network…"); }
  else if (s.connected) { bl.classList.add("ok"); bl.textContent = t("{model} · {host} · connected · {n} learned codes", { model: s.device.model, host: s.device.host, n: s.codes.length }); }
  else { bl.classList.add(s.locked ? "warn" : "err"); bl.textContent = s.error || t("No connection with the Broadlink."); }
  const lm = $("#learnMode"), lf = $("#learnFan");
  if (!lm.options.length) { lm.innerHTML = AC_MODES.map((m) => `<option value="${m.id}">${t(m.name)}</option>`).join(""); lm.value = l.mode; lf.innerHTML = AC_FANS.map((f) => `<option value="${f.id}">${t(f.name)}</option>`).join(""); lf.value = l.fan; }
  const sel = learnSel();
  const grid = $("#acLearnGrid"); grid.innerHTML = "";
  for (let temp = s.minTemp; temp <= s.maxTemp; temp++) {
    const key = `${sel.mode}|${temp}|${sel.fan}`;
    const b = document.createElement("button"); b.textContent = temp + "°"; b.dataset.learnKey = key; b.title = t("{mode} {temp}°C, fan {fan}", { mode: modeName(sel.mode), temp, fan: fanName(sel.fan).toLowerCase() });
    if (s.codes.includes(key)) b.classList.add("learned"); if (s.learning === key) b.classList.add("learning");
    grid.appendChild(b);
  }
  $("#acLearnOff").classList.toggle("learned", s.codes.includes("off"));
  $("#acLearnOff").classList.toggle("learning", s.learning === "off");
  $("#acLearnCancelRow").hidden = !s.learning && !learnSeq;
  if (!s.learning && !learnSeq && !$("#acLearnStatus").classList.contains("keep")) $("#acLearnStatus").hidden = true;
  if (document.activeElement !== $("#acMin")) $("#acMin").value = s.minTemp;
  if (document.activeElement !== $("#acMax")) $("#acMax").value = s.maxTemp;
}
["#learnMode", "#learnFan"].forEach((s) => $(s).addEventListener("change", renderAc));
function learnStatus(text, cls, keep = false) { const b = $("#acLearnStatus"); b.hidden = !text; b.className = "status-box " + (cls || "") + (keep ? " keep" : ""); b.textContent = text || ""; }
async function learnOne(key, label) {
  learnStatus(t("Waiting for the signal for “{label}”… Press that button on the remote while pointing it at the Broadlink.", { label }), "warn");
  const r = await window.tv.acLearn(key);
  if (r.ok) learnStatus(t("Learned: {label}.", { label }), "ok", true); else learnStatus(r.error, "err", true);
  setTimeout(() => $("#acLearnStatus").classList.remove("keep"), 4000);
  return r.ok;
}
$("#acLearnGrid").addEventListener("click", (e) => { const b = e.target.closest("[data-learn-key]"); if (b && !acState.learning) learnOne(b.dataset.learnKey, b.title); });
$("#acLearnOff").addEventListener("click", () => { if (!acState.learning) learnOne("off", t("Off")); });
$("#acLearnSeq").addEventListener("click", async () => {
  if (acState.learning || learnSeq) return;
  learnSeq = true; renderAc();
  const l = learnSel();
  for (let temp = acState.minTemp; temp <= acState.maxTemp && learnSeq; temp++) {
    const key = `${l.mode}|${temp}|${l.fan}`;
    if (acState.codes.includes(key)) continue;
    const ok = await learnOne(key, t("{mode} {temp}°C, fan {fan}", { mode: modeName(l.mode), temp, fan: fanName(l.fan).toLowerCase() }));
    if (!ok) break;
    await new Promise((r) => setTimeout(r, 1200));
  }
  learnSeq = null; renderAc();
});
$("#acLearnCancel").addEventListener("click", () => { learnSeq = null; window.tv.acCancelLearn(); });
$("#acReconnect").addEventListener("click", () => window.tv.acConnect({}));
$("#acRediscover").addEventListener("click", () => window.tv.acConnect({ rediscover: true }));
["#acMin", "#acMax"].forEach((s) => $(s).addEventListener("change", () => { const minTemp = Math.max(10, Math.min(30, Number($("#acMin").value) || 16)), maxTemp = Math.max(minTemp, Math.min(35, Number($("#acMax").value) || 30)); window.tv.acConfig({ minTemp, maxTemp }); }));

// ---------- settings ----------
function fillSettings() {
  $("#cfgName").value = config.name || "";
  $("#cfgIp").value = config.ip || "";
  $("#cfgLogin").checked = !!config.launchAtLogin;
  $("#cfgHdmi").value = String(config.hdmiBase || HDMI_BASE_DEFAULT);
  const lang = $("#cfgLanguage");
  lang.innerHTML = window.tv.i18n.languages.map(([v, n]) => `<option value="${v}">${t(n)}</option>`).join("");
  lang.value = config.language || "auto";
  renderInputEditor();
  const au = audioCfg(); $("#cfgSoundbar").checked = au.soundbar; $("#cfgAudioName").value = au.name; $("#cfgAudioRatio").value = au.ratio;
  $("#cfgAdb").checked = !!config.adb;
  renderAdb();
  renderPairStatus();
}
function renderPairStatus() {
  const box = $("#pairStatus");
  box.className = "status-box";
  if (state.status === "pairing") { box.classList.add("warn"); box.textContent = t("Look at the TV: a 6-character code is shown. Enter it below."); $("#pinBox").hidden = false; $("#pinInput").focus(); return; }
  $("#pinBox").hidden = true;
  if (state.status === "connected") { box.classList.add("ok"); box.textContent = t("Paired and connected. The code is saved, no need to repeat it."); }
  else if (state.status === "connecting") { box.classList.add("warn"); box.textContent = t("Connecting…"); }
  else if (state.status === "error") { box.classList.add("err"); box.textContent = state.error || t("Connection error."); }
  else box.textContent = config.ip ? t("Not connected.") : t("Enter the TV's IP and press “Save and connect”. The TV will show a code once.");
}
$("#cfgSave").addEventListener("click", async () => {
  const ip = $("#cfgIp").value.trim(), name = $("#cfgName").value.trim() || "Google TV";
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { $("#pairStatus").className = "status-box err"; $("#pairStatus").textContent = t("Invalid IP."); return; }
  const changed = ip !== config.ip;
  await window.tv.saveConfig({ ip, name });
  if (!changed) window.tv[config.paired ? "reconnect" : "pair"]();
});
$("#pinSend").addEventListener("click", () => { const c = $("#pinInput").value.trim().toUpperCase(); if (c) { window.tv.sendCode(c); $("#pinInput").value = ""; } });
$("#pinInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#pinSend").click(); });
$("#cfgForget").addEventListener("click", () => window.tv.forget());
function renderInputEditor() {
  const box = $("#inputEditor"); box.innerHTML = "";
  const custom = config.inputs || {};
  for (const n of [1, 2, 3, 4]) {
    const id = "hdmi" + n, cur = custom[id] || {};
    const row = document.createElement("div"); row.className = "input-edit";
    row.innerHTML = `<span class="port">HDMI ${n}</span><input placeholder="${t("Name (e.g. PS5)")}" value="${(cur.name || "").replace(/"/g, "&quot;")}" data-id="${id}" data-f="name" /><select data-id="${id}" data-f="type">${DEVICE_TYPES.map((d) => `<option value="${d.id}" ${(cur.type || "hdmi") === d.id ? "selected" : ""}>${t(d.name)}</option>`).join("")}</select>`;
    box.appendChild(row);
  }
  box.querySelectorAll("input,select").forEach((el) => el.addEventListener("change", () => {
    const inputs = { ...(config.inputs || {}) };
    const id = el.dataset.id; const entry = { ...(inputs[id] || {}) };
    entry[el.dataset.f] = el.value.trim();
    if (!entry.name && (!entry.type || entry.type === "hdmi")) delete inputs[id]; else inputs[id] = entry;
    window.tv.saveConfig({ inputs });
  }));
}
const saveAudio = () => window.tv.saveConfig({ audio: { soundbar: $("#cfgSoundbar").checked, name: $("#cfgAudioName").value.trim() || t("Sound bar"), ratio: Math.max(1, Number($("#cfgAudioRatio").value) || 3) } });
["#cfgSoundbar", "#cfgAudioName", "#cfgAudioRatio"].forEach((s) => $(s).addEventListener("change", saveAudio));
function renderAdb() {
  const box = $("#adbStatus"); box.className = "status-box";
  const pk = config.appPkgs || {};
  const found = ["stremio", "kick", "airplay"].map((id) => `${APPS.find((x) => x.id === id).name}: ${pk[id] || t("not detected")}`).join(" · ");
  if (!config.adb) box.textContent = t("Disabled.") + " " + (adbState.available ? "" : t("adb binary not found."));
  else if (adbState.connected && adbState.authorized) { box.classList.add("ok"); box.textContent = t("Connected to the TV.") + " " + found; }
  else { box.classList.add(adbState.error ? "err" : "warn"); box.textContent = adbState.error || t("Connecting…"); }
}
$("#cfgAdb").addEventListener("change", (e) => window.tv.saveConfig({ adb: e.target.checked }));
$("#adbConnectBtn").addEventListener("click", async () => { if (!config.adb) await window.tv.saveConfig({ adb: true }); else await window.tv.adbConnect(); renderAdb(); });
$("#cfgHdmi").addEventListener("change", (e) => window.tv.saveConfig({ hdmiBase: Number(e.target.value) }));
$("#cfgLogin").addEventListener("change", (e) => window.tv.saveConfig({ launchAtLogin: e.target.checked }));
$("#cfgLanguage").addEventListener("change", (e) => window.tv.saveConfig({ language: e.target.value }));

// ---------- home ----------
function renderHome() {
  const connected = state.status === "connected";
  const off = state.powered === false;
  const a = appByPkg(state.app);
  // Media app on screen: assume it is playing when it appears, then follow the cast session state if there is one.
  const media = connected && !off && isMediaApp(a);
  if (media) {
    if (lastMediaApp !== a.id) { playing = true; lastMediaApp = a.id; }
    if (castState.media?.state && ["PLAYING", "PAUSED"].includes(castState.media.state)) playing = castState.media.state === "PLAYING";
  } else { playing = null; lastMediaApp = null; }
  // Non-media context (an HDMI input, the launcher, TV off): hide playback buttons and collapse the right column to one row.
  $("#mediaCard").hidden = !media;
  $("#castMedia").hidden = $("#castMedia").hidden || !media;
  $(".cc-grid").classList.toggle("compact", !media);
  renderNowTimeline(a, media);
  renderPlay();
  renderInputs();

  const onInput = INPUT_PKGS.includes(state.app);
  const nowIco = $("#nowIco"); const nowInp = INPUTS.find((i) => i.id === activeInput); const nowDev = nowInp?.type ? deviceOf(nowInp) : null;
  const ico = connected && !off ? (a ? appIcon(a, "now-ico") : onInput && nowDev && nowDev.id !== "hdmi" ? appIcon(nowDev, "now-ico") : null) : null;
  if (ico) { ico.id = "nowIco"; nowIco.replaceWith(ico); } else { nowIco.innerHTML = ""; nowIco.removeAttribute("style"); }
  $("#nowTitle").textContent = !connected ? t("Not connected") : off ? t("TV is off") : a ? t(a.name) : onInput ? (nowInp ? t(nowInp.name) : t("Input")) : t(state.appName || "Google TV");
  $("#nowText").textContent = !connected
    ? ({ connecting: t("Connecting to the TV…"), pairing: t("Waiting for the pairing code…"), error: state.error || t("Could not connect."), disconnected: t("Set up the TV in Settings.") }[state.status])
    : off ? t("Turn it on with the button above")
    : a ? (castState.media?.title && castState.app?.name === a.name ? castState.media.title : t("App on screen"))
    : onInput ? (nowInp ? `${nowInp.port || t("Input")}${nowDev && nowDev.id !== "hdmi" ? " · " + t(nowDev.name) : ""}` : t("External input"))
    : state.appName ? t("On screen") : t("Ready for commands.");

  const v = state.volume;
  const au = audioCfg(), r = volRatio();
  if (v && !sliderBusy) {
    const lvl = Math.round(v.level / r);
    slider.max = Math.floor((v.maximum || 100) / r); slider.value = lvl; paintSlider(lvl);
    $("#volValue").textContent = v.muted ? "–" : lvl;
    $("#volOut").textContent = v.muted ? t("Muted") : au.soundbar ? t("{name} · TV {level}", { name: au.name, level: v.level }) : t("TV speakers");
  } else if (!v) { $("#volValue").textContent = "–"; $("#volOut").textContent = au.soundbar ? au.name : t("TV speakers"); }
  const pb = $("#powerBtn"); pb.classList.remove("off", "unknown");
  if (state.powered === false) pb.classList.add("off"); else if (state.powered === null || !connected) pb.classList.add("unknown");
  pb.title = state.powered === false ? t("Turn the TV on") : state.powered === true ? t("Turn the TV off") : t("Turn the TV on / off");
  markCurrentApp();
}
function renderFooter() {
  const c = $("#connStatus");
  c.className = "conn " + state.status;
  $("#connText").textContent = { connected: t("Connected"), connecting: t("Connecting…"), pairing: t("Pairing…"), error: t("Not connected"), disconnected: t("Not set up") }[state.status];
  $("#footerIp").textContent = config.ip || "";
}
function renderHeader() {
  $("#tvName").textContent = config.name || "Google TV";
  $("#tvBrand").textContent = config.brand || "Google TV";
}
function renderAll() { renderHeader(); renderHome(); renderFooter(); renderPairStatus(); renderAc(); renderBgPlayer(); }
function applyLocale() {
  const next = makeT(config.locale);
  if (next.lang === t.lang) return;
  t = next; translateDom();
  $("#learnMode").innerHTML = ""; // rebuilt with translated names on the next AC render
  renderApps(); renderShortcuts(); renderCast();
}

// ---------- wiring ----------
window.tv.onState((s) => { state = s; renderHome(); renderFooter(); renderBgPlayer(); if ($("[data-view=settings]").classList.contains("active")) renderPairStatus(); });
window.tv.onCast((s) => { castState = s; renderCast(); renderHome(); renderBgPlayer(); });
window.tv.onAdb((s) => { adbState = s; if ($("[data-view=settings]").classList.contains("active")) renderAdb(); });
window.tv.onAc((s) => { acState = s; renderAc(); });
window.tv.onConfig((c) => { config = c; applyLocale(); rebuildInputs(); renderApps(); renderShortcuts(); renderAll(); if ($("[data-view=settings]").classList.contains("active")) fillSettings(); });
window.tv.onArrow((x) => { const ar = $("#arrow"); ar.hidden = x < 0; ar.style.left = `${x}px`; });

(async () => {
  config = await window.tv.getConfig();
  t = makeT(config.locale); translateDom();
  activeInput = config.activeInput || null;
  state = await window.tv.getState();
  castState = await window.tv.castGet();
  adbState = await window.tv.adbGet();
  acState = await window.tv.acGet();
  rebuildInputs();
  renderApps(); renderShortcuts(); renderCast(); renderInputs(); renderAll();
  if (!config.ip) showTab("settings");
})();
