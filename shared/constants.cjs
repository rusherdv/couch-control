// Android key codes (android.view.KeyEvent)
const KEY = {
  POWER: 26, SLEEP: 223, WAKEUP: 224, TV_POWER: 177,
  HOME: 3, BACK: 4, MENU: 82, SETTINGS: 176, SEARCH: 84, ASSIST: 219, INFO: 165, GUIDE: 172,
  DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22, DPAD_CENTER: 23,
  VOLUME_UP: 24, VOLUME_DOWN: 25, VOLUME_MUTE: 164,
  CHANNEL_UP: 166, CHANNEL_DOWN: 167,
  MEDIA_PLAY_PAUSE: 85, MEDIA_PLAY: 126, MEDIA_PAUSE: 127, MEDIA_STOP: 86,
  MEDIA_NEXT: 87, MEDIA_PREVIOUS: 88, MEDIA_REWIND: 89, MEDIA_FAST_FORWARD: 90,
  CAPTIONS: 175,
  TV: 170, TV_INPUT: 178,
  TV_INPUT_HDMI_1: 243, TV_INPUT_HDMI_2: 244, TV_INPUT_HDMI_3: 245, TV_INPUT_HDMI_4: 246,
  NUM_0: 7, NUM_1: 8, NUM_2: 9, NUM_3: 10, NUM_4: 11, NUM_5: 12, NUM_6: 13, NUM_7: 14, NUM_8: 15, NUM_9: 16,
  DEL: 67, ENTER: 66, TAB: 61,
};

// Apps. `link` = deep link sent through the Android TV remote protocol (the ones listed were verified on a
// MediaTek Google TV). Apps without a working link are launched through ADB using `pkg` (or a package
// auto-detected via ADB, see PKG_HINTS). `logo` = file in assets/logos, rendered as a mask tinted with `fg`;
// `lw`/`lh` = logo size as a percentage of the tile.
const APPS = [
  { id: "netflix", name: "Netflix", link: "https://www.netflix.com/title", pkg: ["com.netflix.ninja"], bg: "#000", fg: "#E50914", logo: "netflix", lw: "45%", lh: "60%" },
  { id: "crunchy", name: "Crunchyroll", link: "crunchyroll://", pkg: ["com.crunchyroll.crunchyroid", "com.crunchyroll.crunchyroll"], bg: "#F47521", fg: "#fff", logo: "crunchyroll" },
  { id: "youtube", name: "YouTube", link: "vnd.youtube://", pkg: ["com.google.android.youtube.tv"], bg: "#fff", fg: "#FF0000", logo: "youtube" },
  { id: "stremio", name: "Stremio", link: null, pkg: ["com.stremio.one"], bg: "#7B5BF5", fg: "#fff", logo: "stremio" },
  { id: "spotify", name: "Spotify", link: "https://open.spotify.com", pkg: ["com.spotify.tv.android"], bg: "#000", fg: "#1DB954", logo: "spotify" },
  { id: "kick", name: "Kick", link: null, pkg: ["com.kick.mobile"], bg: "#000", fg: "#53FC18", logo: "kick", lw: "50%" },
  { id: "twitch", name: "Twitch", link: "twitch://stream", pkg: ["tv.twitch.android.app", "tv.twitch.android.viewer"], bg: "#9146FF", fg: "#fff", logo: "twitch" },
  { id: "disney", name: "Disney+", link: "https://www.disneyplus.com", pkg: ["com.disney.disneyplus"], bg: "#0F2452", fg: "#fff", logo: "disneyplus", lw: "72%", lh: "50%" },
  { id: "prime", name: "Prime Video", link: "https://app.primevideo.com", pkg: ["com.amazon.amazonvideo.livingroom"], bg: "#00A8E1", fg: "#fff", logo: "primevideo", lw: "74%", lh: "56%" },
  { id: "airplay", name: "AirPlay Server", link: null, pkg: [], bg: "#1c1c1e", fg: "#fff", media: false, hidden: true, svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1"/><path d="M12 15l5 6H7z"/></svg>' },
  { id: "store", name: "Play Store", link: "market://", pkg: ["com.android.vending"], bg: "#fff", fg: "#01875F", logo: "googleplay", media: false },
  { id: "settings", name: "Settings", link: null, key: "SETTINGS", pkg: ["com.android.tv.settings"], bg: "#3a3a3c", fg: "#fff", glyph: "⚙", media: false },
];

// Friendly names for package names reported by the TV (translated at display time).
const APP_NAMES = Object.fromEntries(APPS.flatMap((a) => a.pkg.map((p) => [p, a.name])));
Object.assign(APP_NAMES, {
  "com.google.android.apps.tv.launcherx": "Home",
  "com.google.android.tvlauncher": "Home",
  "com.google.android.tvrecommendations": "Home",
  "com.android.tv": "Live TV",
  "com.google.android.tv": "Live TV",
  "com.mediatek.wwtv.tvcenter": "HDMI input / TV",
  "com.google.android.tv.remote.service": "Remote service",
  "com.google.android.katniss": "Google Assistant",
  "com.android.systemui": "System",
  "android": "System",
  "com.google.android.apps.mediashell": "Chromecast",
  "com.google.android.apps.tv.dreamx": "Screensaver",
});

// HDMI inputs are switched by launching the TV-input passthrough URI (MediaTek-based Google TVs ignore the
// KEYCODE_TV_INPUT_HDMI_* keys). KEYCODE_TV opens the Live TV / inputs app.
const mtk = (hw) => "content://android.media.tv/passthrough/" + encodeURIComponent("com.mediatek.tvinput/.hdmi.HDMIInputService/" + hw);
// HDMI_BASE: MediaTek hardware id of HDMI 1 (HDMI n = HW(base + n - 1)). Adjustable from Settings.
const HDMI_BASE_DEFAULT = 4;
const hdmiInputs = (base = HDMI_BASE_DEFAULT) => [1, 2, 3, 4].map((n) => ({ id: "hdmi" + n, name: "HDMI " + n, link: mtk("HW" + (base + n - 1)) }));
const INPUTS = [
  ...hdmiInputs(),
  { id: "picker", name: "TV inputs", key: "TV" },
];
const INPUT_PKGS = ["com.mediatek.wwtv.tvcenter", "com.android.tv", "com.google.android.tv"];

// Device presets for HDMI inputs (name, colors, logo). `logo` files live in assets/logos.
const DEVICE_TYPES = [
  { id: "hdmi", name: "Generic", bg: "#3a3a40", fg: "#fff",
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h16v8H4z"/><path d="M8 16v2h8v-2M9 11h6"/></svg>' },
  { id: "soundbar", name: "Sound bar", bg: "#2a2d33", fg: "#f5c451",
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="9" width="20" height="6" rx="3"/><circle cx="6.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="17.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><path d="M10 12h4"/><path d="M4 5.5c2-1.7 4.6-1.7 6.5 0M13.5 5.5c2-1.7 4.6-1.7 6.5 0M4 18.5c2 1.7 4.6 1.7 6.5 0M13.5 18.5c2 1.7 4.6 1.7 6.5 0" opacity=".7"/></svg>' },
  { id: "ps5", name: "PlayStation 5", bg: "#0a0a0f", fg: "#fff", logo: "playstation", lw: "62%", lh: "62%" },
  { id: "xbox", name: "Xbox", bg: "#107C10", fg: "#fff", logo: "xbox", lw: "70%", lh: "50%" },
  { id: "switch", name: "Nintendo Switch", bg: "#E60012", fg: "#fff", logo: "nintendoswitch", lw: "66%", lh: "60%" },
  { id: "appletv", name: "Apple TV", bg: "#1c1c1e", fg: "#fff", logo: "appletv", lw: "62%" },
  { id: "chromecast", name: "Chromecast", bg: "#1a73e8", fg: "#fff", logo: "chromecast" },
  { id: "pc", name: "PC / Laptop", bg: "#2b2b30", fg: "#9ad0ff",
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>' },
  { id: "decoder", name: "Cable box", bg: "#2b2b30", fg: "#fff",
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="9" width="20" height="8" rx="2"/><path d="M6 13h.01M10 13h6M8 9l4-5 4 5"/></svg>' },
];

// Package auto-detection (via ADB `pm list packages`) for apps whose package name is unknown or varies.
const PKG_HINTS = { kick: /kick/i, stremio: /stremio/i, airplay: /airplay|airscreen|airreceiver|airpin|airserver/i, crunchy: /crunchyroll/i, twitch: /twitch/i };

// Air conditioner modes / fan speeds (IR code keys are "<mode>|<temp>|<fan>" or "off").
const AC_MODES = [
  { id: "cool", name: "Cool", svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19"/></svg>' },
  { id: "dry", name: "Dry", svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s-6 6.5-6 11a6 6 0 0 0 12 0c0-4.5-6-11-6-11z"/></svg>' },
  { id: "fan", name: "Fan", svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="2.5"/><path d="M12 9.5C12 5 9 3 7 4c-1.5 1 0 4 5 5.5M14.2 13.3c4 2.3 7.3 1.4 7.3-.8 0-1.8-3.2-2.4-7.3-.8M9.8 13.3c-4 2.3-5.3 5.5-3.7 6.7 1.5 1 4-1.2 5.9-4.2"/></svg>' },
];
const AC_FANS = [
  { id: "auto", name: "Auto" }, { id: "low", name: "Low" }, { id: "mid", name: "Medium" }, { id: "high", name: "High" },
];
const acKey = (s) => (s.power ? `${s.mode}|${s.temp}|${s.fan}` : "off");

module.exports = { KEY, APPS, APP_NAMES, INPUTS, INPUT_PKGS, hdmiInputs, HDMI_BASE_DEFAULT, DEVICE_TYPES, PKG_HINTS, AC_MODES, AC_FANS, acKey };
