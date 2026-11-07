/* ════════════════════════ PhonePad — phone side ════════════════════════
   Flow:  touches / tilt  ──►  controller state  ──►  14-byte packet  ──►  PC
   Sections:
     1. constants & settings      5. sticks, d-pad, pedals, strip
     2. controller state + send   6. tilt steering (gravity sensor)
     3. connection & latency      7. rumble, haptics, fullscreen
     4. touch routing             8. settings UI
*/
"use strict";

// ─────────────────────────── 1. constants & settings ───────────────────────────
// XInput button bits — must match the PC's XUSB_BUTTON values.
const BIT = {
  UP: 0x0001, DOWN: 0x0002, LEFT: 0x0004, RIGHT: 0x0008,
  START: 0x0010, BACK: 0x0020, L3: 0x0040, R3: 0x0080,
  LB: 0x0100, RB: 0x0200, GUIDE: 0x0400,
  A: 0x1000, B: 0x2000, X: 0x4000, Y: 0x8000,
};
const T_STATE = 1, T_PING = 2, T_RUMBLE = 3;

const DEFAULTS = {
  layout: "standard", size: 1,
  tilt: false, tiltLock: 40, tiltCurve: 1.2, tiltDead: 2, tiltSmooth: 35, tiltInvert: false,
  pedalMode: "analog", floatSticks: true, stickDead: 8,
  haptics: true, rumble: true, showPing: true,
};
const S = loadSettings();
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("phonepad") || "{}") }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() { try { localStorage.setItem("phonepad", JSON.stringify(S)); } catch {} }

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Deadzone + response curve.  Deadzone: ignore tiny movements near centre,
// then rescale so the output still reaches 1.0.  Curve > 1 = finer control
// near centre (great for steering), < 1 = more twitchy.
function shape(v, dead, curve = 1) {
  const a = Math.abs(v);
  if (a <= dead) return 0;
  return Math.sign(v) * Math.pow((a - dead) / (1 - dead), curve);
}

// ─────────────────────────── 2. controller state + send ───────────────────────
// Several input sources can drive the same axis; compose() decides the winner.
const src = {
  held: new Map(),                 // button bit -> number of fingers holding it
  trigBtn: { LT: 0, RT: 0 },       // digital trigger buttons (finger counts)
  pedal: { LT: new Map(), RT: new Map() },   // pointerId -> 0..1
  stickL: { x: 0, y: 0, on: false },
  stickR: { x: 0, y: 0, on: false },
  strip: { x: 0, on: false },
  tilt: 0,
};
const out = { buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
let seq = 0;

function compose() {
  let buttons = 0;
  for (const [bit, n] of src.held) if (n > 0) buttons |= bit;

  const pedalMax = (m) => { let v = 0; for (const x of m.values()) v = Math.max(v, x); return v; };
  const lt = Math.max(src.trigBtn.LT > 0 ? 1 : 0, pedalMax(src.pedal.LT));
  const rt = Math.max(src.trigBtn.RT > 0 ? 1 : 0, pedalMax(src.pedal.RT));

  // Left-stick X priority: finger on stick > steer strip > tilt
  let lx = src.stickL.on ? src.stickL.x : src.strip.on ? src.strip.x : (S.tilt ? src.tilt : 0);
  let ly = src.stickL.on ? src.stickL.y : 0;

  const n = {
    buttons,
    lt: Math.round(lt * 255), rt: Math.round(rt * 255),
    lx: toI16(lx), ly: toI16(-ly),             // screen Y points down, XInput Y points up
    rx: toI16(src.stickR.x), ry: toI16(-src.stickR.y),
  };
  let changed = false;
  for (const k in n) if (n[k] !== out[k]) { out[k] = n[k]; changed = true; }
  if (changed) sendState();
  drawSteer(lx);
}
const toI16 = (v) => Math.round(clamp(v, -1, 1) * 32767);

function sendState() {
  if (!ws || ws.readyState !== 1) return;
  // 14 bytes vs ~80 for JSON — less to transmit, nothing to parse.
  const dv = new DataView(new ArrayBuffer(14));
  dv.setUint8(0, T_STATE);
  dv.setUint8(1, seq++ & 255);
  dv.setUint16(2, out.buttons, true);         // true = little-endian (matches Python "<")
  dv.setUint8(4, out.lt);
  dv.setUint8(5, out.rt);
  dv.setInt16(6, out.lx, true);
  dv.setInt16(8, out.ly, true);
  dv.setInt16(10, out.rx, true);
  dv.setInt16(12, out.ry, true);
  ws.send(dv.buffer);
}
// Keep-alive: resend state every 50 ms. Feeds the PC watchdog AND stops the
// phone's Wi-Fi radio from dozing off between packets (power-save latency spikes).
setInterval(sendState, 50);

// ─────────────────────────── 3. connection & latency ──────────────────────────
let ws = null, connected = false;
const isUSB = ["localhost", "127.0.0.1"].includes(location.hostname);
const modeName = isUSB ? "USB" : "Wi-Fi";
let player = 0;
const rtts = [];

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { connected = true; rtts.length = 0; setStatus(); sendState(); ping(); };
  ws.onclose = () => {
    connected = false; setStatus(); stopRumble();
    setTimeout(connect, 700);                 // auto-reconnect
  };
  ws.onmessage = (ev) => {
    const dv = new DataView(ev.data);
    const type = dv.getUint8(0);
    if (type === T_PING) {
      rtts.push(performance.now() - dv.getFloat64(1, true));
      if (rtts.length > 15) rtts.shift();
      showPing();
    } else if (type === T_RUMBLE) {
      player = dv.getUint8(3) + 1;
      setStatus();
      rumble(dv.getUint8(1), dv.getUint8(2));
    }
  };
}

function ping() {
  if (!ws || ws.readyState !== 1) return;
  const dv = new DataView(new ArrayBuffer(9));
  dv.setUint8(0, T_PING);
  dv.setFloat64(1, performance.now(), true);
  ws.send(dv.buffer);
}
setInterval(ping, 1000);

function latencyStats() {
  if (!rtts.length) return null;
  const s = [...rtts].sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const jitter = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
  return { median, min: s[0], max: s[s.length - 1], jitter };
}
function showPing() {
  const el = $("ping"), st = latencyStats();
  if (!S.showPing || !st || !connected) { el.textContent = ""; return; }
  el.textContent = `${st.median.toFixed(st.median < 10 ? 1 : 0)} ms`;
  el.className = st.median < 15 ? "good" : st.median < 40 ? "mid" : "slow";
  const live = $("latencyLive");
  if (live) live.textContent =
    `median ${st.median.toFixed(1)} · min ${st.min.toFixed(1)} · max ${st.max.toFixed(1)} · jitter ±${st.jitter.toFixed(1)} ms`;
}

function setStatus() {
  const el = $("status");
  el.className = connected ? "ok" : "bad";
  $("statusText").textContent = connected ? `${player ? "P" + player + " · " : ""}${modeName}` : "Offline";
  $("conn").hidden = connected || !$("start").hidden;   // start screen takes priority
  $("connText").textContent = `Reconnecting to PC over ${modeName}…`;
  showPing();
}

// ─────────────────────────── 4. touch routing ─────────────────────────────────
// One listener on the whole pad. Each finger (pointerId) is tracked
// independently = true multi-touch: steer, brake and shift at once.
const pad = $("pad");
const tracks = new Map();   // pointerId -> { kind, el, ... }

pad.addEventListener("pointerdown", (e) => {
  const el = e.target.closest("[data-ctl]");
  if (!el) return;
  e.preventDefault();
  const kind = el.dataset.ctl;
  const t = { kind, el };
  tracks.set(e.pointerId, t);
  // Capture keeps sending this finger's moves to us even if it slides off.
  if (kind !== "btn") el.setPointerCapture?.(e.pointerId);
  if (kind === "btn") btnEnter(t, el);
  else if (kind === "stick") stickStart(t, e);
  else if (kind === "dpad") dpadMove(t, e);
  else if (kind === "pedal") pedalMove(t, e, e.pointerId);
  else if (kind === "strip") stripMove(t, e);
  compose();
}, { passive: false });

pad.addEventListener("pointermove", (e) => {
  const t = tracks.get(e.pointerId);
  if (!t) return;
  e.preventDefault();
  if (t.kind === "btn") {
    // "Glide": slide a thumb from A to B without lifting, like a real pad.
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-ctl="btn"]') || null;
    if (over !== t.el) { btnLeave(t); if (over) btnEnter(t, over); }
  }
  else if (t.kind === "stick") stickMove(t, e);
  else if (t.kind === "dpad") dpadMove(t, e);
  else if (t.kind === "pedal") pedalMove(t, e, e.pointerId);
  else if (t.kind === "strip") stripMove(t, e);
  compose();
}, { passive: false });

function endPointer(e) {
  const t = tracks.get(e.pointerId);
  if (!t) return;
  tracks.delete(e.pointerId);
  if (t.kind === "btn") btnLeave(t);
  else if (t.kind === "stick") stickEnd(t);
  else if (t.kind === "dpad") dpadSet(t, 0);
  else if (t.kind === "pedal") pedalEnd(t, e.pointerId);
  else if (t.kind === "strip") stripEnd(t);
  compose();
}
pad.addEventListener("pointerup", endPointer);
pad.addEventListener("pointercancel", endPointer);
pad.addEventListener("contextmenu", (e) => e.preventDefault());

// Release EVERYTHING (settings opened, app hidden, …)
function releaseAll() {
  for (const [id, t] of tracks) endPointer({ pointerId: id });
  tracks.clear();
}
document.addEventListener("visibilitychange", () => { if (document.hidden) releaseAll(); });

// ── buttons ──
const elHeld = new WeakMap();   // element -> finger count (for the pressed look)
function btnEnter(t, el) {
  t.el = el;
  const trig = el.dataset.trig;
  if (trig) src.trigBtn[trig]++;
  else hold(BIT[el.dataset.btn], +1);
  const n = (elHeld.get(el) || 0) + 1;
  elHeld.set(el, n);
  el.classList.add("on");
  haptic();
}
function btnLeave(t) {
  const el = t.el;
  if (!el) return;
  const trig = el.dataset.trig;
  if (trig) src.trigBtn[trig] = Math.max(0, src.trigBtn[trig] - 1);
  else hold(BIT[el.dataset.btn], -1);
  const n = Math.max(0, (elHeld.get(el) || 1) - 1);
  elHeld.set(el, n);
  if (!n) el.classList.remove("on");
  t.el = null;
}
function hold(bits, delta) {
  for (let b = 1; b <= 0x8000; b <<= 1) {
    if (bits & b) src.held.set(b, Math.max(0, (src.held.get(b) || 0) + delta));
  }
}

// ─────────────────────────── 5. sticks, d-pad, pedals, strip ──────────────────
function stickStart(t, e) {
  const zone = t.el, base = zone.querySelector(".base");
  t.side = zone.dataset.stick === "L" ? src.stickL : src.stickR;
  t.base = base; t.knob = base.querySelector(".knob");
  zone.classList.add("active");
  const zr = zone.getBoundingClientRect();
  if (S.floatSticks) {
    // Floating stick: the stick centre appears wherever your thumb lands.
    const r = base.offsetWidth / 2;
    const x = clamp(e.clientX - zr.left, r * 0.6, zr.width - r * 0.6);
    const y = clamp(e.clientY - zr.top, r * 0.6, zr.height - r * 0.6);
    base.style.left = x + "px"; base.style.top = y + "px";
  }
  const br = base.getBoundingClientRect();
  t.cx = br.left + br.width / 2; t.cy = br.top + br.height / 2;
  t.radius = br.width / 2 * 0.72;          // how far the knob can travel
  t.side.on = true;
  stickMove(t, e);
}
function stickMove(t, e) {
  let dx = (e.clientX - t.cx) / t.radius, dy = (e.clientY - t.cy) / t.radius;
  const mag = Math.hypot(dx, dy);
  if (mag > 1) { dx /= mag; dy /= mag; }    // clamp to the unit circle
  t.knob.style.transform = `translate(${dx * t.radius}px, ${dy * t.radius}px)`;
  // RADIAL deadzone (on distance, not per axis) keeps diagonals smooth.
  const m = Math.min(1, mag), dz = S.stickDead / 100;
  const k = m <= dz ? 0 : ((m - dz) / (1 - dz)) / (m || 1);
  t.side.x = dx * k;
  t.side.y = dy * k;
}
function stickEnd(t) {
  t.side.on = false; t.side.x = t.side.y = 0;
  t.knob.style.transform = "";
  t.el.classList.remove("active");
  t.base.style.left = t.base.style.top = "";
}

// D-pad: angle of finger from centre -> one of 8 directions (diagonals too).
const DIRS = [BIT.RIGHT, BIT.RIGHT | BIT.DOWN, BIT.DOWN, BIT.DOWN | BIT.LEFT,
              BIT.LEFT, BIT.LEFT | BIT.UP, BIT.UP, BIT.UP | BIT.RIGHT];
function dpadMove(t, e) {
  const r = t.el.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  if (Math.hypot(dx, dy) < r.width * 0.12) return dpadSet(t, 0);
  const sector = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
  dpadSet(t, DIRS[sector]);
}
function dpadSet(t, bits) {
  const old = t.bits || 0;
  if (bits === old) return;
  hold(old, -1); hold(bits, +1);
  t.bits = bits;
  if (bits & ~old) haptic();
  let all = bits;   // light up arms held by ANY finger on the d-pad
  for (const tr of tracks.values()) if (tr !== t && tr.kind === "dpad") all |= tr.bits || 0;
  const d = $("dpad");
  d.querySelector(".up").classList.toggle("on", !!(all & BIT.UP));
  d.querySelector(".down").classList.toggle("on", !!(all & BIT.DOWN));
  d.querySelector(".left").classList.toggle("on", !!(all & BIT.LEFT));
  d.querySelector(".right").classList.toggle("on", !!(all & BIT.RIGHT));
}

// Pedals: analog by height. Bottom of pedal = 25 %, top fifth = 100 %.
function pedalMove(t, e, id) {
  const r = t.el.getBoundingClientRect();
  let v = 1;
  if (S.pedalMode === "analog") {
    const h = clamp((r.bottom - e.clientY) / r.height, 0, 1);
    v = 0.25 + 0.75 * clamp(h / 0.8, 0, 1);
  }
  const which = t.el.dataset.pedal;
  if (!src.pedal[which].has(id)) haptic();
  src.pedal[which].set(id, v);
  drawPedal(t.el, which);
}
function pedalEnd(t, id) {
  const which = t.el.dataset.pedal;
  src.pedal[which].delete(id);
  drawPedal(t.el, which);
}
function drawPedal(el, which) {
  let v = 0;
  for (const x of src.pedal[which].values()) v = Math.max(v, x);
  el.querySelector(".fill").style.transform = `scaleY(${v})`;
  el.querySelector(".pct").textContent = Math.round(v * 100) + "%";
  el.classList.toggle("on", v > 0);
}

// Steer strip (racing layout without tilt): finger X position = steering.
function stripMove(t, e) {
  const r = t.el.getBoundingClientRect();
  const raw = clamp(((e.clientX - r.left) / r.width - 0.5) / 0.44, -1, 1);
  src.strip.on = true;
  src.strip.x = shape(raw, 0.03, S.tiltCurve);
  t.el.querySelector(".thumb").style.transform = `translateX(${raw * r.width * 0.44}px)`;
}
function stripEnd(t) {
  src.strip.on = false; src.strip.x = 0;
  t.el.querySelector(".thumb").style.transform = "";
}

// Wheel graphic mirrors whatever is steering.
const wheelSvg = document.querySelector("#wheel svg");
let lastWheel = null;
function drawSteer(x) {
  if (S.layout !== "racing") return;
  const deg = Math.round(x * S.tiltLock);
  if (deg === lastWheel) return;
  lastWheel = deg;
  wheelSvg.style.transform = `rotate(${deg}deg)`;
  $("wheelVal").textContent = `${deg > 0 ? "R " : deg < 0 ? "L " : ""}${Math.abs(deg)}°`;
}

// ─────────────────────────── 6. tilt steering ─────────────────────────────────
// Hold the phone like a steering wheel. Gravity always points "down"; as you
// rotate the phone, gravity's direction *inside the screen plane* rotates too.
// atan2(gx, gy) gives that angle; subtract the calibrated centre; scale by the
// steering lock (e.g. 40° of phone rotation = full lock).
const tilt = { sensor: null, listening: false, centre: null, raw: 0, smooth: 0, source: "off", lastAt: 0 };

function onGravity(gx, gy) {
  tilt.lastAt = performance.now();
  if (Math.hypot(gx, gy) < 2.5) return;      // phone lying flat: angle meaningless
  const ang = Math.atan2(gx, gy);
  tilt.raw = ang;
  if (tilt.centre === null) tilt.centre = ang;
  const d = Math.atan2(Math.sin(ang - tilt.centre), Math.cos(ang - tilt.centre));  // wrap to ±180°
  let steer = (-d * 180 / Math.PI) / S.tiltLock;
  if (S.tiltInvert) steer = -steer;
  steer = shape(clamp(steer, -1, 1), S.tiltDead / 100, S.tiltCurve);
  // Low-pass filter (exponential smoothing): hides hand shake. More smoothing
  // = steadier but slightly laggier — that's the trade-off you're tuning.
  const alpha = 1 - (S.tiltSmooth / 100) * 0.9;
  tilt.smooth += alpha * (steer - tilt.smooth);
  src.tilt = Math.abs(tilt.smooth) < 0.002 ? 0 : tilt.smooth;
  compose();
}

function startTilt() {
  if (tilt.sensor || tilt.listening) return;
  if (!window.isSecureContext) { tilt.source = "blocked"; renderSettingsNote(); return; }
  const useMotion = () => {
    if (tilt.listening) return;
    tilt.listening = true; tilt.source = "motion events";
    window.addEventListener("devicemotion", onMotion);
    renderSettingsNote();
  };
  if ("GravitySensor" in window) {
    try {
      // Fused accelerometer + gyroscope gravity: much less jittery than raw accel.
      const s = new GravitySensor({ frequency: 60, referenceFrame: "device" });
      s.addEventListener("reading", () => { if (s.x != null) onGravity(s.x, s.y); });
      s.addEventListener("error", () => { tilt.sensor = null; useMotion(); });
      s.start();
      tilt.sensor = s; tilt.source = "gravity sensor";
      setTimeout(() => { if (tilt.sensor && !tilt.lastAt) { s.stop(); tilt.sensor = null; useMotion(); } }, 1200);
    } catch { useMotion(); }
  } else useMotion();
  renderSettingsNote();
}
function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (g && g.x != null) onGravity(g.x, g.y);
}
function stopTilt() {
  tilt.sensor?.stop(); tilt.sensor = null;
  if (tilt.listening) window.removeEventListener("devicemotion", onMotion);
  tilt.listening = false; tilt.source = "off"; tilt.lastAt = 0;
  src.tilt = 0; tilt.smooth = 0; compose();
}
function recentre() {
  tilt.centre = tilt.raw || null; tilt.smooth = 0; src.tilt = 0;
  haptic(30); compose();
}
$("recenter").addEventListener("click", recentre);
$("wheel").addEventListener("pointerdown", (e) => { e.stopPropagation(); if (S.tilt) recentre(); });

// ─────────────────────────── 7. rumble, haptics, fullscreen ───────────────────
const canVibrate = "vibrate" in navigator;
function haptic(ms = 12) { if (S.haptics && canVibrate) navigator.vibrate(ms); }

// Phones can't vary vibration strength, so we fake it with PWM:
// buzz for N ms out of every 40 ms — more N feels stronger.
let rumbleTimer = null;
function rumble(large, small) {
  clearInterval(rumbleTimer); rumbleTimer = null;
  if (!S.rumble || !canVibrate) return;
  const i = Math.max(large, small * 0.7) / 255;
  if (i < 0.05) { navigator.vibrate(0); return; }
  const on = Math.round(8 + 32 * i), period = 40;
  const pat = on >= period ? [1000] : Array.from({ length: 50 }, (_, k) => (k % 2 ? period - on : on));
  navigator.vibrate(pat);
  rumbleTimer = setInterval(() => navigator.vibrate(pat), 950);
}
function stopRumble() { clearInterval(rumbleTimer); rumbleTimer = null; if (canVibrate) navigator.vibrate(0); }

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
// The browser drops the wake lock when you switch apps; grab it again on return.
document.addEventListener("visibilitychange", () => { if (!document.hidden && $("start").hidden) keepAwake(); });

$("startBtn").addEventListener("click", async () => {
  $("start").hidden = true;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    await screen.orientation?.lock?.("landscape");
  } catch {}
  keepAwake();
  if (S.tilt) startTilt();
  setStatus();
});
$("startMode").textContent = isUSB
  ? "USB cable mode · lowest latency"
  : location.protocol === "https:" ? "Wi-Fi mode (secure) · tilt steering available" : "Wi-Fi mode · tilt needs the https:// address";

// ─────────────────────────── 8. settings UI ───────────────────────────────────
const SCHEMA = [
  { sec: "Layout" },
  { key: "layout", label: "Controller layout", type: "seg", opts: [["standard", "Standard"], ["racing", "Racing"]] },
  { key: "size", label: "Control size", type: "range", min: 0.8, max: 1.2, step: 0.05, fmt: (v) => Math.round(v * 100) + "%" },
  { sec: "Tilt steering" },
  { key: "tilt", label: "Tilt to steer", hint: "Rotate phone like a wheel → left stick X", type: "toggle" },
  { key: "tiltLock", label: "Steering angle", hint: "Phone rotation for full lock", type: "range", min: 15, max: 90, step: 1, fmt: (v) => v + "°" },
  { key: "tiltCurve", label: "Centre precision", hint: "Higher = gentler near centre", type: "range", min: 0.6, max: 2.5, step: 0.1, fmt: (v) => v.toFixed(1) + "×" },
  { key: "tiltDead", label: "Tilt deadzone", type: "range", min: 0, max: 10, step: 0.5, fmt: (v) => v + "%" },
  { key: "tiltSmooth", label: "Smoothing", hint: "Steadier vs. more responsive", type: "range", min: 0, max: 90, step: 5, fmt: (v) => v + "%" },
  { key: "tiltInvert", label: "Invert steering", type: "toggle" },
  { action: "Re-centre now", run: recentre, label: "Calibrate", hint: "Hold phone in neutral position, then tap" },
  { sec: "Sticks & pedals" },
  { key: "floatSticks", label: "Floating sticks", hint: "Stick appears where your thumb lands", type: "toggle" },
  { key: "stickDead", label: "Stick deadzone", type: "range", min: 0, max: 25, step: 1, fmt: (v) => v + "%" },
  { key: "pedalMode", label: "Racing pedals", type: "seg", opts: [["analog", "Analog"], ["digital", "On/Off"]] },
  { sec: "Feedback" },
  { key: "haptics", label: "Vibrate on press", type: "toggle" },
  { key: "rumble", label: "Game rumble", hint: "Force feedback from the game", type: "toggle" },
  { key: "showPing", label: "Show latency", type: "toggle" },
  { note: "latency" },
];

function renderSettings() {
  const body = $("settingsBody");
  body.innerHTML = "";
  for (const item of SCHEMA) {
    if (item.sec) { body.insertAdjacentHTML("beforeend", `<div class="sec">${item.sec}</div>`); continue; }
    if (item.note) { const n = document.createElement("div"); n.className = "note"; n.id = "settingsNote"; body.append(n); continue; }
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<label>${item.label}${item.hint ? `<small>${item.hint}</small>` : ""}</label>`;
    if (item.action) {
      const b = document.createElement("button"); b.className = "act"; b.textContent = item.action;
      b.onclick = item.run; row.append(b);
    } else if (item.type === "toggle") {
      const b = document.createElement("button"); b.className = "tog" + (S[item.key] ? " sel" : "");
      b.onclick = () => { set(item.key, !S[item.key]); b.classList.toggle("sel", S[item.key]); };
      row.append(b);
    } else if (item.type === "seg") {
      const g = document.createElement("div"); g.className = "seg";
      for (const [val, txt] of item.opts) {
        const b = document.createElement("button"); b.textContent = txt;
        b.className = S[item.key] === val ? "sel" : "";
        b.onclick = () => { set(item.key, val); [...g.children].forEach((c) => c.classList.toggle("sel", c === b)); };
        g.append(b);
      }
      row.append(g);
    } else if (item.type === "range") {
      const w = document.createElement("div"); w.className = "rng";
      const r = Object.assign(document.createElement("input"), { type: "range", min: item.min, max: item.max, step: item.step, value: S[item.key] });
      const o = document.createElement("output"); o.textContent = item.fmt(S[item.key]);
      r.oninput = () => { const v = parseFloat(r.value); o.textContent = item.fmt(v); set(item.key, v); };
      w.append(r, o); row.append(w);
    }
    body.append(row);
  }
  renderSettingsNote();
}
function renderSettingsNote() {
  const n = $("settingsNote");
  if (!n) return;
  const tiltMsg = !window.isSecureContext
    ? `<span class="warn">Tilt is blocked on plain http:// over Wi-Fi.</span> Use USB (<b>localhost</b>) or the <b>https://…:8443</b> address.`
    : S.tilt ? `Tilt source: <b>${tilt.source}</b>` : "Tilt is off.";
  n.innerHTML = `<b>Connection:</b> ${modeName} · <span id="latencyLive">measuring…</span><br>${tiltMsg}
    ${canVibrate ? "" : '<br><span class="warn">This browser cannot vibrate — rumble disabled.</span>'}`;
  showPing();
}

function set(key, val) {
  S[key] = val;
  saveSettings();
  apply();
}
function apply() {
  document.body.dataset.layout = S.layout;
  document.body.classList.toggle("tilt", S.tilt);
  document.documentElement.style.setProperty("--s", S.size);
  if (S.tilt && $("start").hidden) startTilt(); else if (!S.tilt) stopTilt();
  lastWheel = null;
  if (!S.rumble) stopRumble();
  compose();
  showPing();
  renderSettingsNote();
}

$("gear").addEventListener("click", () => { releaseAll(); renderSettings(); $("settings").hidden = false; });
$("closeSettings").addEventListener("click", () => { $("settings").hidden = true; });

// ─────────────────────────── boot ─────────────────────────────────────────────
apply();
connect();
setStatus();
