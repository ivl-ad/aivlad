/* ============================================================
   NOVA JUMP — an endless vector runner.
   Everything on screen is drawn with canvas paths — no assets.

   Coordinate system: 1 unit = 1% of screen HEIGHT. The screen is
   always 100 units tall; its width in units (Wu) depends on the
   aspect ratio. All world state lives in unit space, so rotation
   or resize only changes the pixel scale, never the game state.

   Passability guarantee: every obstacle that must be jumped is
   generated no wider than 55% of the current jump distance
   (speed x airtime) and no taller than ~72% of the jump apex,
   and the gap between consecutive obstacles never drops below
   80% of the jump distance — so a takeoff window always exists.
   Moving hazards keep the guarantee by construction: patrol
   walkers and sliding blocks reserve their whole patrol range
   plus (patrol speed x airtime) as their effective width, birds
   bob inside an envelope whose highest point is still clearable,
   and overhead saws keep head clearance at every phase of their
   bob. Whatever the phase when you arrive, a winning line exists.
   Late game (difficulty > 0.7) adds obstacles that REQUIRE the
   double jump: chasms and spike carpets 1.05-1.3x the single-jump
   distance and walls taller than the single-jump apex — all well
   inside double-jump reach (~1.5-1.9x jump distance, ~2x apex),
   so the winning line always exists, it just costs both jumps.
   ============================================================ */
(() => {
'use strict';

// never run two game instances, even if the script is injected twice
if (window.__NOVA_JUMP_BOOTED) return;
window.__NOVA_JUMP_BOOTED = true;

// ---------- canvas & unit scale ----------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, U = 1, Wu = 0, DPR = 1;
let vignette = null;

// ---------- physics constants (unit space) ----------
const GROUND = 78;                 // y of the ground line
const GRAV = 330;                  // gravity, units/s^2
const JUMP_V = 108;                // takeoff speed, units/s
const AIR_T = 2 * JUMP_V / GRAV;   // full-jump airtime, s
const PW = 6.4, PH = 6.4;          // player body size
const M_PER_U = 1 / 6;             // world units -> "meters" for score

// ---------- fixed gameplay colors (readability across themes) ----------
const COL = {
  spike: '#ff4d6d', spikeDark: '#96103a',
  block: '#ffb700', blockDark: '#8a5a00',
  sawBody: '#e8eef7', sawEdge: '#8fa1b8', sawCore: '#ff5d8f',
  walker: '#ff6b35', walkerDark: '#6e2000',
  bird: '#d64bff', birdDark: '#4d0d66',
  flag: '#ffd23e',
};
const NS = window.NovaScores;
const avatar = () => NS.current(); // {color, dark, id} — picked by the player

// ---------- environment themes (cycled + blended by distance) ----------
const THEMES = [
  { skyT:'#2ea8ff', skyB:'#bdebff', sun:'#ffde3d', far:'#7c8cff', near:'#3ec9ff', gTop:'#52e07c', gBody:'#22a34a' },
  { skyT:'#ff5e85', skyB:'#ffc65c', sun:'#fff06a', far:'#9b5de5', near:'#f15bb5', gTop:'#ff9e44', gBody:'#c95f22' },
  { skyT:'#10123f', skyB:'#5a4fd6', sun:'#edf2ff', far:'#2e2a8f', near:'#6c3fd4', gTop:'#8f6fff', gBody:'#4530ad' },
  { skyT:'#00c2ff', skyB:'#cffbff', sun:'#ffe066', far:'#ff8fa3', near:'#ff5d8f', gTop:'#63f5c6', gBody:'#12a37a' },
];
const THEME_RGB = THEMES.map(t => {
  const o = {};
  for (const k in t) {
    const h = t[k];
    o[k] = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  return o;
});

// ---------- state ----------
let state = 'menu';                // menu | play | dying | over
let paused = false;
let time = 0, hitStop = 0, shake = 0, flash = 0;
let meters = 0, bonusPts = 0, score = 0, best = 0, gotBest = false;
let menuCam = 0, overAt = 0, deathT = 0;
let nextMilestone = 100, nextLevelAt = 250;
let obstacles = [], nextX = 0, clusterN = 0;
let particles = [], popups = [], clouds = [];
let runDustT = 0, speedLineT = 0;

const P = {
  x: 0, y: GROUND, vy: 0,
  grounded: true, airJumps: 1, coyote: 0, buffer: 0, cutUsed: false,
  spinT: 0, landT: 0, blinkT: 2, rot: 0, trail: [],
};

// ---------- DOM ----------
const el = id => document.getElementById(id);
const scoreEl = el('score'), bestChip = el('bestChip'), muteBtn = el('muteBtn');
const menuEl = el('menu'), overEl = el('over'), pausedEl = el('paused');
const finalScoreEl = el('finalScore'), overBestEl = el('overBest'), newBestEl = el('newBest');
let lastScoreStr = '';

// ---------- storage (may be unavailable in private mode) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
best = parseInt(store.get('novaJumpBest') || '0', 10) || 0;

// ---------- helpers ----------
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (a = 1, b) => b === undefined ? Math.random() * a : a + Math.random() * (b - a);
const mod = (a, m) => ((a % m) + m) % m;

function mixRGB(a, b, t) {
  return 'rgb(' + Math.round(lerp(a[0], b[0], t)) + ',' + Math.round(lerp(a[1], b[1], t)) + ',' + Math.round(lerp(a[2], b[2], t)) + ')';
}

// ---------- evolving sky ----------
// The 4 hand-made palettes play first, in order. Once they're exhausted the
// sequence extends forever with procedurally generated palettes: each new sky
// hue keeps >=45deg distance from the recent ones, so no weather repeats, and
// segment-to-segment blending keeps every transition smooth.
let themeSeq = THEME_RGB.slice();
let usedHues = [];

function hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const f = n => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

function genTheme() {
  let hue = rnd(360), tries = 0;
  while (tries++ < 40 && usedHues.some(h => hueDist(h, hue) < 45)) hue = rnd(360);
  usedHues.push(hue);
  if (usedHues.length > 6) usedHues.shift();
  const night = Math.random() < 0.22; // occasional dusk/night mood
  const sL = night ? rnd(16, 30) : rnd(45, 62);
  let gh = (hue + rnd(80, 160)) % 360;
  if (gh > 335 || gh < 25) gh = (gh + 45) % 360; // keep the ground off spike-red
  const mh = (hue + 360 + rnd(-40, 40)) % 360;
  return {
    skyT: hsl2rgb(hue, rnd(60, 85), sL),
    skyB: hsl2rgb(hue + rnd(15, 40), rnd(65, 90), night ? sL + 20 : rnd(72, 84)),
    sun: hsl2rgb(hue + rnd(140, 220), rnd(75, 95), night ? 88 : rnd(60, 70)),
    far: hsl2rgb(mh, rnd(40, 60), night ? sL + 14 : rnd(50, 65)),
    near: hsl2rgb(mh + rnd(20, 60), rnd(50, 75), night ? sL + 24 : rnd(48, 60)),
    gTop: hsl2rgb(gh, rnd(55, 80), night ? 42 : rnd(55, 65)),
    gBody: hsl2rgb(gh, rnd(55, 80), night ? 26 : rnd(34, 42)),
  };
}

// blended theme at a given distance; blends over the last 25% of each 260 m segment
function themeNow(m) {
  const seg = Math.max(0, m) / 260;
  const i = Math.floor(seg);
  while (themeSeq.length <= i + 1) themeSeq.push(genTheme());
  const f = seg - i;
  const k = f < 0.75 ? 0 : (f - 0.75) / 0.25;
  const kk = k * k * (3 - 2 * k);
  const A = themeSeq[i], B = themeSeq[i + 1];
  const out = {};
  for (const key in A) out[key] = mixRGB(A[key], B[key], kk);
  return out;
}

function rr(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- difficulty & speed ----------
const diffAt = m => 1 - Math.exp(-m / 350);
const baseSpeed = () => clamp(Wu * 0.6, 34, 92);
const speedMult = () => 1 + 0.85 * diffAt(meters) + Math.min(0.35, meters / 5000);
const curSpeed = () => baseSpeed() * speedMult();
const playerScreenX = () => clamp(Wu * 0.26, 8, 56);
const camX = () => state === 'menu' ? menuCam : P.x - playerScreenX();

// ---------- resize / rotation ----------
function resize() {
  const prevW = W, prevH = H;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  // visualViewport fires on pinch-zoom/keyboard with the layout viewport
  // unchanged — skip so the canvas doesn't blank and clouds don't shuffle
  if (W === window.innerWidth && H === window.innerHeight && dpr === DPR && W > 0) return;
  DPR = dpr;
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.max(1, Math.round(W * DPR));
  canvas.height = Math.max(1, Math.round(H * DPR));
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  U = H / 100; Wu = W / U;
  vignette = null;
  makeClouds();
  // A big mid-run size change (rotation) alters speed & jump distance, which
  // could invalidate obstacles generated for the old metrics. Drop everything
  // still ahead of the player and respawn with fresh, guaranteed spacing.
  if (state === 'play' && prevW > 0 &&
      (Math.abs(W - prevW) / prevW > 0.12 || Math.abs(H - prevH) / prevH > 0.12)) {
    obstacles = obstacles.filter(o => o.x < P.x + 4);
    nextX = camX() + Wu + 10;
  }
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 60));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);

function makeClouds() {
  // adjust the population without teleporting clouds that already exist
  const n = Math.ceil(Wu / 26) + 3;
  while (clouds.length > n) clouds.pop();
  while (clouds.length < n) {
    clouds.push({ x: rnd(Wu * 1.5 + 40), y: rnd(5, 36), s: rnd(2.1, 4.6), p: rnd(0.14, 0.4) });
  }
}

// ---------- audio (synthesized, no assets) ----------
let AC = null, master = null, muted = store.get('novaJumpMuted') === '1';

function initAudio() {
  if (AC) { if (AC.state === 'suspended') AC.resume(); return; }
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    master = AC.createGain();
    master.gain.value = 0.24;
    master.connect(AC.destination);
  } catch (e) { AC = null; }
}

function tone(f0, f1, dur, type, vol, delay) {
  if (!AC || muted) return;
  const t0 = AC.currentTime + (delay || 0);
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type || 'square';
  o.frequency.setValueAtTime(Math.max(1, f0), t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
  g.gain.setValueAtTime(vol || 0.15, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

function noiseHit(dur, vol) {
  if (!AC || muted) return;
  const n = Math.floor(AC.sampleRate * dur);
  const buf = AC.createBuffer(1, n, AC.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = AC.createBufferSource(), g = AC.createGain();
  src.buffer = buf;
  g.gain.value = vol;
  src.connect(g); g.connect(master);
  src.start();
}

const sfx = {
  jump()  { tone(300, 560, 0.11, 'square', 0.11); },
  djump() { tone(400, 780, 0.1, 'square', 0.11); tone(780, 1150, 0.08, 'square', 0.08, 0.05); },
  land()  { noiseHit(0.05, 0.08); tone(150, 90, 0.06, 'triangle', 0.12); },
  close() { tone(1250, 1900, 0.06, 'sine', 0.09); tone(1900, 2500, 0.05, 'sine', 0.07, 0.055); },
  mile()  { tone(660, 660, 0.07, 'triangle', 0.12); tone(990, 990, 0.09, 'triangle', 0.12, 0.075); },
  best()  { [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.1, 'triangle', 0.13, i * 0.07)); },
  death() { tone(320, 55, 0.4, 'sawtooth', 0.2); noiseHit(0.22, 0.2); },
  start() { tone(440, 880, 0.14, 'triangle', 0.13); },
};

function setMuted(m) {
  muted = m;
  store.set('novaJumpMuted', m ? '1' : '0');
  muteBtn.classList.toggle('muted', m);
}
setMuted(muted);
muteBtn.addEventListener('click', e => { e.stopPropagation(); initAudio(); setMuted(!muted); });

// ---------- particles & popups ----------
function spawnP(x, y, vx, vy, life, size, color, grav) {
  if (particles.length > 220) particles.shift();
  particles.push({ x, y, vx, vy, life, maxLife: life, size, color, grav: grav || 0 });
}

function dust(x, y, n) {
  for (let i = 0; i < n; i++) {
    spawnP(x + rnd(-2.5, 2.5), y + rnd(-0.6, 0.4), rnd(-14, 4), rnd(-16, -2), rnd(0.25, 0.5), rnd(0.7, 1.6), 'rgba(255,255,255,0.85)', 120);
  }
}

function burst(x, y, color, n, power) {
  for (let i = 0; i < n; i++) {
    const a = rnd(Math.PI * 2), sp = rnd(power * 0.3, power);
    spawnP(x, y, Math.cos(a) * sp, Math.sin(a) * sp, rnd(0.35, 0.75), rnd(0.8, 2), color, 90);
  }
}

function confetti(x, y) {
  const cols = ['#ffd23e', '#ff5d8f', '#2bffc6', '#7c8cff', '#ffffff'];
  for (let i = 0; i < 34; i++) {
    const a = rnd(-Math.PI, 0);
    spawnP(x + rnd(-4, 4), y, Math.cos(a) * rnd(10, 46), Math.sin(a) * rnd(20, 60), rnd(0.6, 1.2), rnd(0.8, 1.8), cols[i % cols.length], 110);
  }
}

function popup(x, y, text, color, big) {
  popups.push({ x, y, text, color: color || '#fff', life: 1, big: !!big });
}

// ---------- obstacle generation ----------
// types: spike {x,w,h} | block {x,w,h} | saw {x,w,r,cy,bob,phase,high} | pit {x,w}

function spawnNext() {
  const d = diffAt(meters), sp = curSpeed(), jd = sp * AIR_T;
  const maxW = jd * 0.55;
  const x = nextX;
  clusterN++;
  const ents = [];
  let w = 0, needJump = true, gapMul = 1;

  const pool = [['spike1', 1]];
  if (d > 0.08) pool.push(['block', 0.9]);
  if (d > 0.18) pool.push(['spike2', 0.9]);
  if (d > 0.28) pool.push(['lowSaw', 0.85]);
  if (d > 0.34) pool.push(['highSaw', 0.75]);
  if (d > 0.45) pool.push(['pit', 0.8]);
  if (d > 0.5) pool.push(['walker', 0.75]);
  if (d > 0.52) pool.push(['spike3', 0.7]);
  if (d > 0.56) pool.push(['bird', 0.75]);
  if (d > 0.62) pool.push(['tallBlock', 0.7]);
  if (d > 0.66) pool.push(['slider', 0.65]);
  // from here on, the double jump stops being a luxury:
  if (d > 0.7) pool.push(['megaPit', 0.75]);
  if (d > 0.76) pool.push(['spikeRun', 0.7]);
  if (d > 0.82) pool.push(['tallWall', 0.65]);

  let type;
  if (clusterN <= 2 || clusterN % 11 === 0) {
    type = 'spike1'; // warmup + periodic breather
  } else {
    let total = 0;
    for (const p of pool) total += p[1];
    let roll = Math.random() * total;
    type = pool[pool.length - 1][0];
    for (const p of pool) { roll -= p[1]; if (roll <= 0) { type = p[0]; break; } }
  }
  if (type === 'spike3' && 14.4 > maxW) type = 'spike2';
  if (type === 'spike2' && 9.6 > maxW) type = 'spike1';
  // movers need enough jump distance to cover their whole patrol
  // envelope plus the ground they cover during one airtime
  if (type === 'walker' && jd * 0.6 - 4.6 - Math.min(0.22 * sp, 14) * AIR_T < 3) type = 'spike1';
  if (type === 'slider' && jd * 0.55 - 5.5 - Math.min(0.2 * sp, 12) * AIR_T < 3) type = 'block';

  switch (type) {
    case 'spike1': {
      const h = Math.min(4.5 + rnd(1.5 + 5 * d), 10.5);
      ents.push({ type: 'spike', x, w: 5, h });
      w = 5; break;
    }
    case 'spike2': {
      const h = Math.min(4.2 + rnd(1 + 4 * d), 9.5);
      ents.push({ type: 'spike', x, w: 4.8, h });
      ents.push({ type: 'spike', x: x + 4.8, w: 4.8, h: h * rnd(0.85, 1) });
      w = 9.6; break;
    }
    case 'spike3': {
      const h = Math.min(4 + rnd(1 + 3.5 * d), 8.6);
      for (let i = 0; i < 3; i++) ents.push({ type: 'spike', x: x + i * 4.8, w: 4.8, h: h * rnd(0.85, 1) });
      w = 14.4; break;
    }
    case 'block': {
      const bw = Math.min(5 + rnd(3), maxW - 1);
      const h = Math.min(5 + rnd(3 + 6 * d), 12.5);
      ents.push({ type: 'block', x, w: bw, h });
      w = bw; break;
    }
    case 'tallBlock': { // tall enough that hopping ONTO it is the natural line
      const bw = 6;
      const h = Math.min(10 + rnd(3), 13);
      ents.push({ type: 'block', x, w: bw, h });
      w = bw; break;
    }
    case 'lowSaw': {
      const r = 4 + 1.9 * d;
      ents.push({ type: 'saw', x, w: 2 * r, r, cy: GROUND - r * 0.6, bob: 0, phase: rnd(6.28), high: false });
      w = 2 * r; break;
    }
    case 'highSaw': { // passes overhead — run under it, do NOT jump
      const r = 4 + 1.9 * d;
      const bob = 1 + 1.5 * d;
      const cy = Math.max(GROUND - (PH + 3.6 + bob + r) - 1.2, r + 6);
      ents.push({ type: 'saw', x, w: 2 * r, r, cy, bob, phase: rnd(6.28), high: true });
      w = 2 * r; needJump = false; break;
    }
    case 'pit': {
      const pw = Math.max(6.5, Math.min(7 + rnd(3 + 7 * d), jd * 0.5));
      ents.push({ type: 'pit', x, w: pw });
      w = pw; break;
    }
    case 'walker': { // angry square patrolling a bounded stretch of ground
      const bw = 4.6, bh = 4.6;
      const spd = Math.min(0.22 * sp, 14);
      const range = clamp(Math.min(6 + 8 * d, jd * 0.6 - bw - spd * AIR_T), 3, 24);
      ents.push({
        type: 'walker', x, w: range + bw, bw, bh,
        x0: x, x1: x + range, wx: x + rnd(range), dir: Math.random() < 0.5 ? -1 : 1, spd,
      });
      w = range + bw; break;
    }
    case 'bird': { // bobbing flyer — its HIGHEST point is still jumpable
      const bw = 5.2;
      const amp = Math.min(2 + 2.5 * d, 3);
      // highest body top stays <= 10 units above ground (apex is ~17.7)
      ents.push({
        type: 'bird', x, w: bw, cyB: GROUND - 8 + amp, amp,
        phase: rnd(6.28), freq: 2 + 2 * d,
      });
      w = bw; break;
    }
    case 'slider': { // sliding block — jump it or ride its top
      const bw = 5.5, bh = Math.min(6 + rnd(3 + 4 * d), 10);
      const spd = Math.min(0.2 * sp, 12);
      const range = clamp(Math.min(5 + 7 * d, jd * 0.55 - bw - spd * AIR_T), 3, 20);
      ents.push({
        type: 'slider', x, w: range + bw, bw, bh,
        x0: x, x1: x + range, wx: x + rnd(range), dir: Math.random() < 0.5 ? -1 : 1, spd,
      });
      w = range + bw; break;
    }
    // ---- double-jump-required obstacles (late game) ----
    // A single jump covers exactly jd at best; chaining the air jump at the
    // first apex covers ~1.48*jd and at the last moment ~1.9*jd. These spawn
    // at 1.05-1.3*jd wide (or taller than the single-jump apex), so a double
    // jump is REQUIRED yet always sufficient with a comfortable margin.
    case 'megaPit': { // a chasm one jump cannot cross
      const pw = jd * (1.08 + rnd(0.22));
      ents.push({ type: 'pit', x, w: pw });
      w = pw; gapMul = 1.15; break;
    }
    case 'spikeRun': { // a spike carpet longer than any single arc
      const total = jd * (1.05 + rnd(0.2));
      const n = Math.max(4, Math.round(total / 4.8));
      const h = 5 + rnd(2);
      for (let i = 0; i < n; i++) {
        ents.push({ type: 'spike', x: x + i * 4.8, w: 4.8, h: h * rnd(0.85, 1) });
      }
      w = n * 4.8; gapMul = 1.15; break;
    }
    case 'tallWall': { // taller than the single-jump apex — double up and over
      const bw = 6.5;
      const h = 16.5 + rnd(2.5);
      ents.push({ type: 'block', x, w: bw, h });
      w = bw; gapMul = 1.1; break;
    }
  }

  for (const e of ents) { e.passed = false; e.minClear = Infinity; }
  obstacles.push(...ents);

  const ease = clusterN <= 3 ? 1.5 : 1;
  let gap = jd * lerp(1.8, 1.08, d) * rnd(0.85, 1.4) * ease * (needJump ? 1 : 0.8) * gapMul;
  gap = Math.max(gap, jd * 0.8 * gapMul, sp * 0.33); // hard floor: takeoff window always exists
  nextX = x + w + gap;
}

function updateObstacles() {
  const view = camX();
  while (nextX < view + Wu + 40) spawnNext();
  while (obstacles.length && obstacles[0].x + obstacles[0].w < view - 12) obstacles.shift();
}

// ---------- player physics ----------
function platformsAt(l, r) {
  const tops = [];
  let onGround = true;
  for (const o of obstacles) {
    if (o.type === 'pit') {
      if (P.x > o.x + 0.8 && P.x < o.x + o.w - 0.8) onGround = false;
    } else if (o.type === 'block') {
      if (r > o.x + 0.5 && l < o.x + o.w - 0.5) tops.push(GROUND - o.h);
    } else if (o.type === 'slider') { // moving platform: use its live position
      if (r > o.wx + 0.5 && l < o.wx + o.bw - 0.5) tops.push(GROUND - o.bh);
    }
  }
  if (onGround) tops.push(GROUND);
  return tops;
}

function updateMovers(dt) {
  for (const o of obstacles) {
    if (o.type === 'walker' || o.type === 'slider') {
      o.wx += o.dir * o.spd * dt;
      if (o.wx < o.x0) { o.wx = o.x0; o.dir = 1; }
      else if (o.wx > o.x1) { o.wx = o.x1; o.dir = -1; }
    }
  }
}

function supportAt() {
  const tops = platformsAt(P.x - PW / 2, P.x + PW / 2);
  let bestT = null;
  for (const t of tops) if (Math.abs(t - P.y) <= 0.9 && (bestT === null || t < bestT)) bestT = t;
  return bestT;
}

function landAt(prevBottom) {
  const tops = platformsAt(P.x - PW / 2, P.x + PW / 2);
  let bestT = null;
  for (const t of tops) if (prevBottom <= t + 0.9 && P.y >= t && (bestT === null || t < bestT)) bestT = t;
  return bestT;
}

function doJump(air) {
  P.vy = -JUMP_V * (air ? 0.98 : 1);
  P.grounded = false;
  P.coyote = 0;
  P.buffer = 0;
  P.cutUsed = false;
  if (air) {
    P.spinT = 0.5;
    burst(P.x, P.y - PH / 2, avatar().color, 10, 42);
    sfx.djump();
  } else {
    dust(P.x, P.y, 5);
    sfx.jump();
  }
}

function land(t) {
  const impact = P.vy;
  P.y = t;
  P.vy = 0;
  P.grounded = true;
  P.airJumps = 1;
  P.landT = 0.18;
  P.spinT = 0;
  dust(P.x, P.y, impact > 90 ? 8 : 4);
  if (impact > 40) sfx.land();
}

function die(launch) {
  if (state !== 'play') return;
  state = 'dying';
  deathT = 0;
  hitStop = 0.09;
  shake = 0.55;
  flash = 0.55;
  P.vy = launch ? -78 : 24;
  burst(P.x, P.y - PH / 2, avatar().color, 26, 70);
  burst(P.x, P.y - PH / 2, '#ffffff', 12, 45);
  sfx.death();
}

// ---------- score / HUD ----------
function setScoreHUD() {
  score = Math.floor(meters) + bonusPts;
  const s = String(score);
  if (s !== lastScoreStr) { lastScoreStr = s; scoreEl.textContent = s; }
}

function scorePop() {
  scoreEl.classList.remove('pop');
  void scoreEl.offsetWidth;
  scoreEl.classList.add('pop');
}

// one physics/collision step; called 1..N times per frame with dt/N
function simStep(sp, sdt) {
  P.x += sp * sdt;
  meters = P.x * M_PER_U;
  P.buffer = Math.max(0, P.buffer - sdt);
  P.coyote = Math.max(0, P.coyote - sdt);

  updateObstacles();
  updateMovers(sdt);

  // buffered jump
  if (P.buffer > 0) {
    if (P.grounded || P.coyote > 0) doJump(false);
    else if (P.airJumps > 0) { P.airJumps--; doJump(true); }
  }

  // vertical physics
  if (P.grounded) {
    const t = supportAt();
    if (t === null) { // walked off an edge
      P.grounded = false;
      P.coyote = 0.09;
      P.vy = 0;
    } else {
      P.y = t;
    }
  }
  if (!P.grounded) {
    const prevBottom = P.y;
    P.vy += GRAV * sdt;
    P.y += P.vy * sdt;
    if (P.vy >= 0) {
      const t = landAt(prevBottom);
      if (t !== null) land(t);
    }
  } else {
    runDustT -= sdt;
    if (runDustT <= 0) { runDustT = 0.18; dust(P.x - PW / 2, P.y, 1); }
  }

  // fell into a pit
  if (P.y > GROUND + 4.5) { die(false); return; }

  // collisions & near-miss tracking
  const box = { l: P.x - PW / 2 + 1.4, r: P.x + PW / 2 - 1.4, t: P.y - PH + 0.9, b: P.y - 0.4 };
  const pcx = P.x, pcy = P.y - PH / 2;

  for (const o of obstacles) {
    if (o.x > P.x + Wu) break;

    // pass detection + bonus (no CLOSE bonus for tops you safely rode)
    if (!o.passed && P.x - PW / 2 > o.x + o.w) {
      o.passed = true;
      if (o.type !== 'pit') {
        bonusPts += 10;
        if (!o.ridden && o.minClear >= 0 && o.minClear < 2.4) {
          bonusPts += 25;
          popup(playerScreenX(), P.y - PH - 6, 'CLOSE! +25', '#ffd23e', false);
          burst(P.x, P.y - PH / 2, '#ffd23e', 8, 34);
          scorePop();
          sfx.close();
        }
      }
      continue;
    }
    if (o.passed) continue;

    const xOverlap = box.r > o.x && box.l < o.x + o.w;

    if (o.type === 'spike') {
      if (xOverlap) {
        o.minClear = Math.min(o.minClear, (GROUND - o.h) - P.y);
        const cl = o.x + o.w * 0.3, cr = o.x + o.w * 0.7, ct = GROUND - o.h * 0.72;
        if (box.r > cl && box.l < cr && box.b > ct) { die(true); return; }
      }
    } else if (o.type === 'block') {
      const top = GROUND - o.h;
      if (xOverlap) {
        if (P.y <= top + 0.5) o.minClear = Math.min(o.minClear, top - P.y);
        if (P.grounded && Math.abs(P.y - top) < 0.6) o.ridden = true;
        if (box.r > o.x + 0.6 && box.l < o.x + o.w - 0.6 && box.b > top + 1.6 && box.t < GROUND) {
          die(true); return;
        }
      }
    } else if (o.type === 'saw') {
      const cy = o.cy + Math.sin(time * 3 + o.phase) * o.bob;
      const scx = o.x + o.r;
      if (xOverlap) {
        if (o.high) o.minClear = Math.min(o.minClear, (P.y - PH) - (cy + o.r));
        else o.minClear = Math.min(o.minClear, (cy - o.r) - P.y);
        const dx = pcx - scx, dy = pcy - cy;
        const rr2 = o.r * 0.8 + PW * 0.38;
        if (dx * dx + dy * dy < rr2 * rr2) { die(true); return; }
      }
    } else if (o.type === 'walker') {
      if (box.r > o.wx + 0.8 && box.l < o.wx + o.bw - 0.8) {
        o.minClear = Math.min(o.minClear, (GROUND - o.bh) - P.y);
        if (box.b > GROUND - o.bh + 0.7) { die(true); return; }
      }
    } else if (o.type === 'bird') {
      const cy = o.cyB - o.amp * Math.sin(time * o.freq + o.phase);
      const bcx = o.x + o.w / 2;
      if (xOverlap) {
        o.minClear = Math.min(o.minClear, (cy - 2) - P.y);
        const dx = pcx - bcx, dy = pcy - cy;
        const rr2 = 2 * 0.9 + PW * 0.38;
        if (dx * dx + dy * dy < rr2 * rr2) { die(true); return; }
      }
    } else if (o.type === 'slider') {
      const top = GROUND - o.bh;
      if (box.r > o.wx + 0.6 && box.l < o.wx + o.bw - 0.6) {
        if (P.y <= top + 0.5) o.minClear = Math.min(o.minClear, top - P.y);
        if (P.grounded && Math.abs(P.y - top) < 0.6) o.ridden = true;
        if (box.b > top + 1.6 && box.t < GROUND) { die(true); return; }
      }
    }
    // pits kill via the fall check above
  }
}

// ---------- update ----------
function update(dt) {
  time += dt;

  // particles & popups run in every state
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.vy += p.grav * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i];
    p.life -= dt * 1.1;
    p.y -= dt * 9;
    if (p.life <= 0) popups.splice(i, 1);
  }
  shake = Math.max(0, shake - dt * 2.2);
  flash = Math.max(0, flash - dt * 2.4);

  if (state === 'menu') {
    menuCam += dt * 10;
    P.blinkT -= dt;
    if (P.blinkT < -0.12) P.blinkT = rnd(1.5, 4);
    return;
  }

  if (state === 'dying') {
    deathT += dt;
    P.vy += GRAV * dt * 0.9;
    P.y += P.vy * dt;
    P.rot += dt * 9;
    if (deathT > 0.85 || P.y > 160) showGameOver();
    return;
  }

  if (state !== 'play') return;

  // ---- simulation, sub-stepped so high speed can never tunnel a
  // frame boundary across a kill window (narrowest is ~5.5u) ----
  const sp = curSpeed();
  const steps = Math.max(1, Math.ceil(sp * dt / 4));
  const sdt = dt / steps;
  for (let i = 0; i < steps; i++) {
    simStep(sp, sdt);
    if (state !== 'play') return;
  }

  // ---- per-frame cosmetics ----
  P.landT = Math.max(0, P.landT - dt);
  P.spinT = Math.max(0, P.spinT - dt);
  P.blinkT -= dt;
  if (P.blinkT < -0.12) P.blinkT = rnd(1.5, 4);

  const lean = clamp(P.vy * 0.0045, -0.42, 0.5);
  const spin = P.spinT > 0 ? (1 - P.spinT / 0.5) * Math.PI * 2 : 0;
  P.rot = (P.grounded ? Math.sin(time * 14) * 0.03 : lean) + spin;

  P.trail.push({ x: P.x, y: P.y, rot: P.rot, t: 1 });
  if (P.trail.length > 14) P.trail.shift();
  for (const tr of P.trail) tr.t -= dt * 3.2;

  // ---- milestones, levels & best flag ----
  if (meters >= nextLevelAt) {
    const lv = Math.floor(nextLevelAt / 250) + 1;
    popup(playerScreenX(), GROUND - 30, 'LEVEL ' + lv + '!', '#ffd23e', true);
    burst(P.x, P.y - PH, '#ffd23e', 14, 40);
    sfx.best();
    nextLevelAt += 250;
  } else if (meters >= nextMilestone) {
    popup(playerScreenX(), GROUND - 26, nextMilestone + 'm', '#ffffff', true);
    sfx.mile();
  }
  if (meters >= nextMilestone) nextMilestone += 100;
  if (!gotBest && best > 20 && meters > best) {
    gotBest = true;
    popup(playerScreenX(), GROUND - 30, 'NEW BEST!', COL.flag, true);
    confetti(P.x, P.y - PH);
    scorePop();
    sfx.best();
  }

  speedLineT += dt;
  setScoreHUD();
}

// ---------- state transitions ----------
function startGame() {
  obstacles = [];
  particles = [];
  popups = [];
  P.x = 0; P.y = GROUND; P.vy = 0;
  P.grounded = true; P.airJumps = 1; P.coyote = 0; P.buffer = 0;
  P.spinT = 0; P.landT = 0; P.rot = 0; P.trail = [];
  meters = 0; bonusPts = 0; score = 0; gotBest = false;
  nextMilestone = 100; nextLevelAt = 250;
  clusterN = 0;
  themeSeq = THEME_RGB.slice(); // every run starts on the classic skies
  usedHues = [];
  nextX = playerScreenX() + Wu * 1.05;
  lastScoreStr = '';
  setScoreHUD();
  state = 'play';
  menuEl.classList.add('hidden');
  overEl.classList.add('hidden');
  sfx.start();
}

function showGameOver() {
  state = 'over';
  overAt = time;
  const finalScore = Math.floor(meters) + bonusPts;
  const run = { score: finalScore, meters: Math.floor(meters) };
  const isBest = run.meters > best;
  if (isBest) { best = run.meters; store.set('novaJumpBest', String(best)); }
  scoreEl.textContent = String(finalScore);
  finalScoreEl.textContent = String(finalScore);
  overBestEl.textContent = 'BEST ' + best + 'm';
  bestChip.textContent = 'BEST ' + best + 'm';
  newBestEl.classList.toggle('hidden', !isBest);
  // record the run right away (first-ever death gets a random handle);
  // the AVATAR button on this screen edits name & shape — the name is
  // applied to this run's entry, the shape is used next round
  NS.ensureProfile();
  NS.submitRun(run);
  overEl.classList.remove('hidden');
}

// ---------- input ----------
const profilePanelEl = el('profilePanel'), scoresPanelEl = el('scores');
const modalOpen = () =>
  !profilePanelEl.classList.contains('hidden') || !scoresPanelEl.classList.contains('hidden');

let activePtr = null;      // the pointer currently driving gameplay
let resumeSwallow = false; // the tap that unpauses must not jump-cut

function pressAction() {
  initAudio();
  if (modalOpen()) return; // panels own the screen — no starts/jumps behind them
  if (paused) {
    paused = false;
    resumeSwallow = true;
    pausedEl.classList.add('hidden');
    return;
  }
  if (state === 'menu') startGame();
  else if (state === 'play') P.buffer = 0.14;
  else if (state === 'over' && time - overAt > 0.45) startGame();
}

function releaseAction() {
  if (resumeSwallow) { resumeSwallow = false; return; }
  if (state === 'play' && !P.cutUsed && P.vy < -35) {
    P.vy *= 0.45; // short hop
    P.cutUsed = true;
  }
}

window.addEventListener('pointerdown', e => {
  // taps on UI panels/buttons never drive the game
  if (e.target.closest && e.target.closest('#muteBtn, .ui, button, input')) return;
  e.preventDefault();
  activePtr = e.pointerId;
  pressAction();
}, { passive: false });
// only the release of the pointer that pressed can cut the jump —
// a second finger, a UI tap, or a stray cancel never shortens a held jump
const ptrRelease = e => {
  if (activePtr === null || e.pointerId !== activePtr) return;
  activePtr = null;
  releaseAction();
};
window.addEventListener('pointerup', ptrRelease);
window.addEventListener('pointercancel', ptrRelease);
window.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') { e.preventDefault(); pressAction(); }
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') releaseAction();
});
document.addEventListener('touchmove', e => {
  if (e.target.closest && e.target.closest('.scroll-ok')) return; // leaderboard scrolls
  e.preventDefault();
}, { passive: false });
document.addEventListener('contextmenu', e => e.preventDefault());

// menu / game-over buttons
el('menuScores').addEventListener('click', () => { initAudio(); NS.openScores(); });
el('overScores').addEventListener('click', () => { initAudio(); NS.openScores(); });
el('menuProfile').addEventListener('click', () => { initAudio(); NS.openProfile(null, false); });
el('overProfile').addEventListener('click', () => { initAudio(); NS.openProfile(null, true); });

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'play') {
    paused = true;
    pausedEl.classList.remove('hidden');
  }
});

// ---------- rendering ----------
const ridge1 = x => Math.sin(x * 0.055) * 7 + Math.sin(x * 0.023 + 2.1) * 10 + Math.sin(x * 0.11 + 0.7) * 2.5;
const ridge2 = x => Math.sin(x * 0.07 + 1.3) * 5 + Math.sin(x * 0.031 + 4.0) * 8 + Math.sin(x * 0.19) * 1.6;

function render() {
  const T = themeNow(meters);
  const cam = camX();

  ctx.setTransform(DPR * U, 0, 0, DPR * U, 0, 0);
  if (shake > 0) ctx.translate(rnd(-1, 1) * shake * 1.3, rnd(-1, 1) * shake * 1.3);

  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, 100);
  sky.addColorStop(0, T.skyT);
  sky.addColorStop(1, T.skyB);
  ctx.fillStyle = sky;
  ctx.fillRect(-4, -4, Wu + 8, 108);

  // sun with rotating rays
  const sunX = Wu * 0.8, sunY = 20;
  ctx.save();
  ctx.translate(sunX, sunY);
  ctx.rotate(time * 0.2);
  ctx.fillStyle = T.sun;
  ctx.globalAlpha = 0.55;
  for (let i = 0; i < 10; i++) {
    ctx.rotate(Math.PI / 5);
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(2.1, -14.5);
    ctx.lineTo(-2.1, -14.5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(0, 0, 7.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // clouds
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  for (const c of clouds) {
    const sx = mod(c.x - cam * c.p, Wu + 40) - 20;
    ctx.beginPath();
    ctx.arc(sx, c.y, c.s, 0, Math.PI * 2);
    ctx.arc(sx + c.s * 0.95, c.y + c.s * 0.25, c.s * 0.75, 0, Math.PI * 2);
    ctx.arc(sx - c.s * 0.9, c.y + c.s * 0.3, c.s * 0.65, 0, Math.PI * 2);
    ctx.fill();
  }

  // mountains (two parallax layers, generated from sines — infinite)
  ctx.fillStyle = T.far;
  ctx.beginPath();
  ctx.moveTo(-2, 80);
  for (let sx = -2; sx <= Wu + 4; sx += 2.5) ctx.lineTo(sx, 56 + ridge1(sx + cam * 0.25));
  ctx.lineTo(Wu + 4, 80);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = T.near;
  ctx.beginPath();
  ctx.moveTo(-2, 80);
  for (let sx = -2; sx <= Wu + 4; sx += 2.5) ctx.lineTo(sx, 67 + ridge2(sx + cam * 0.55) * 0.7);
  ctx.lineTo(Wu + 4, 80);
  ctx.closePath();
  ctx.fill();

  // speed lines at high velocity
  const mult = speedMult();
  if (state === 'play' && mult > 1.3) {
    ctx.fillStyle = 'rgba(255,255,255,' + Math.min(0.22, (mult - 1.3) * 0.35) + ')';
    for (let i = 0; i < 5; i++) {
      const y = mod(i * 17.3 + speedLineT * 9, 70) + 4;
      const lx = mod(i * 61.7 - cam * 2.2, Wu + 30) - 15;
      ctx.fillRect(lx, y, 9 + i * 2, 0.55);
    }
  }

  // ground
  ctx.fillStyle = T.gBody;
  ctx.fillRect(-4, GROUND, Wu + 8, 104 - GROUND);
  ctx.fillStyle = T.gTop;
  ctx.fillRect(-4, GROUND, Wu + 8, 1.8);
  // scrolling slanted stripes
  ctx.fillStyle = 'rgba(255,255,255,0.09)';
  const period = 13;
  const off = mod(-cam, period);
  for (let sx = off - period * 2; sx < Wu + period; sx += period) {
    ctx.beginPath();
    ctx.moveTo(sx, GROUND + 2.5);
    ctx.lineTo(sx + 5, GROUND + 2.5);
    ctx.lineTo(sx + 1.5, 100);
    ctx.lineTo(sx - 3.5, 100);
    ctx.closePath();
    ctx.fill();
  }

  // pits (carved out of the ground)
  for (const o of obstacles) {
    if (o.type !== 'pit') continue;
    const sx = o.x - cam;
    if (sx > Wu + 4 || sx + o.w < -4) continue;
    const g = ctx.createLinearGradient(0, GROUND, 0, 100);
    g.addColorStop(0, '#1a1030');
    g.addColorStop(0.75, '#33104a');
    g.addColorStop(1, '#ff4d2e');
    ctx.fillStyle = g;
    ctx.fillRect(sx, GROUND, o.w, 100 - GROUND + 4);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(sx - 0.7, GROUND, 0.7, 2.6);
    ctx.fillRect(sx + o.w, GROUND, 0.7, 2.6);
  }

  // best-distance flag
  if ((state === 'play' || state === 'dying') && best > 20) {
    const fx = best / M_PER_U - cam;
    if (fx > -6 && fx < Wu + 6) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(fx, GROUND);
      ctx.lineTo(fx, GROUND - 16);
      ctx.stroke();
      ctx.fillStyle = COL.flag;
      const wave = Math.sin(time * 6) * 1.1;
      ctx.beginPath();
      ctx.moveTo(fx, GROUND - 16);
      ctx.lineTo(fx + 8, GROUND - 14 + wave * 0.4);
      ctx.lineTo(fx, GROUND - 11.5);
      ctx.closePath();
      ctx.fill();
    }
  }

  // obstacles
  for (const o of obstacles) {
    const sx = o.x - cam;
    if (sx > Wu + 6 || sx + o.w < -6) continue;

    if (o.type === 'spike') {
      ctx.fillStyle = COL.spike;
      ctx.strokeStyle = COL.spikeDark;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(sx + 0.2, GROUND);
      ctx.lineTo(sx + o.w / 2, GROUND - o.h);
      ctx.lineTo(sx + o.w - 0.2, GROUND);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 0.45;
      ctx.beginPath();
      ctx.moveTo(sx + o.w * 0.32, GROUND - o.h * 0.28);
      ctx.lineTo(sx + o.w * 0.46, GROUND - o.h * 0.72);
      ctx.stroke();
    } else if (o.type === 'block') {
      const top = GROUND - o.h;
      ctx.fillStyle = COL.block;
      rr(sx, top, o.w, o.h, 1);
      ctx.fill();
      ctx.strokeStyle = COL.blockDark;
      ctx.lineWidth = 0.8;
      rr(sx + 0.4, top + 0.4, o.w - 0.8, o.h - 0.8, 0.8);
      ctx.stroke();
      // grumpy little face
      ctx.fillStyle = COL.blockDark;
      const ey = top + Math.min(o.h * 0.32, 3.2);
      ctx.beginPath();
      ctx.arc(sx + o.w * 0.32, ey, 0.55, 0, Math.PI * 2);
      ctx.arc(sx + o.w * 0.68, ey, 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = COL.blockDark;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(sx + o.w * 0.5, ey + 2.6, 1, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    } else if (o.type === 'saw') {
      const cy = o.cy + Math.sin(time * 3 + o.phase) * o.bob;
      const cx = sx + o.r;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(time * (o.high ? 6 : 8));
      ctx.fillStyle = COL.sawBody;
      ctx.beginPath();
      const teeth = 10;
      for (let i = 0; i < teeth; i++) {
        const a0 = (i / teeth) * Math.PI * 2;
        const a1 = ((i + 0.5) / teeth) * Math.PI * 2;
        const a2 = ((i + 1) / teeth) * Math.PI * 2;
        ctx.lineTo(Math.cos(a0) * o.r, Math.sin(a0) * o.r);
        ctx.lineTo(Math.cos(a1) * o.r * 0.62, Math.sin(a1) * o.r * 0.62);
        ctx.lineTo(Math.cos(a2) * o.r, Math.sin(a2) * o.r);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = COL.sawEdge;
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.fillStyle = COL.sawCore;
      ctx.beginPath();
      ctx.arc(0, 0, o.r * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(0, 0, o.r * 0.14, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (o.type === 'walker') {
      const wx = o.wx - cam, top = GROUND - o.bh;
      const step = Math.sin(time * 11 + o.x0);
      // feet
      ctx.fillStyle = COL.walkerDark;
      ctx.fillRect(wx + 0.5, GROUND - 1.2 + Math.max(0, step) * -0.7, 1.3, 1.6);
      ctx.fillRect(wx + o.bw - 1.8, GROUND - 1.2 + Math.max(0, -step) * -0.7, 1.3, 1.6);
      // body
      ctx.fillStyle = COL.walker;
      rr(wx, top - 1.2 + Math.abs(step) * 0.4, o.bw, o.bh, 1);
      ctx.fill();
      ctx.strokeStyle = COL.walkerDark;
      ctx.lineWidth = 0.6;
      rr(wx + 0.3, top - 0.9 + Math.abs(step) * 0.4, o.bw - 0.6, o.bh - 0.6, 0.8);
      ctx.stroke();
      // angry eyes facing walk direction
      const look = o.dir * 0.5;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(wx + o.bw * 0.32 + look, top + 0.9, 0.72, 0, Math.PI * 2);
      ctx.arc(wx + o.bw * 0.68 + look, top + 0.9, 0.72, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COL.walkerDark;
      ctx.beginPath();
      ctx.arc(wx + o.bw * 0.32 + look * 1.5, top + 1, 0.36, 0, Math.PI * 2);
      ctx.arc(wx + o.bw * 0.68 + look * 1.5, top + 1, 0.36, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = COL.walkerDark;
      ctx.lineWidth = 0.45;
      ctx.beginPath(); // angry brows
      ctx.moveTo(wx + o.bw * 0.18, top + 0.1); ctx.lineTo(wx + o.bw * 0.42, top + 0.55);
      ctx.moveTo(wx + o.bw * 0.82, top + 0.1); ctx.lineTo(wx + o.bw * 0.58, top + 0.55);
      ctx.stroke();
    } else if (o.type === 'bird') {
      const cy = o.cyB - o.amp * Math.sin(time * o.freq + o.phase);
      const bcx = sx + o.w / 2;
      const flap = Math.sin(time * 11 + o.phase);
      ctx.fillStyle = COL.bird;
      ctx.strokeStyle = COL.birdDark;
      ctx.lineWidth = 0.5;
      // wings
      ctx.beginPath();
      ctx.moveTo(bcx - 0.4, cy - 0.4);
      ctx.lineTo(bcx - 3.4, cy - 1.6 - flap * 1.8);
      ctx.lineTo(bcx - 1.4, cy + 0.6);
      ctx.closePath();
      ctx.moveTo(bcx + 0.4, cy - 0.4);
      ctx.lineTo(bcx + 3.4, cy - 1.6 - flap * 1.8);
      ctx.lineTo(bcx + 1.4, cy + 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // body
      ctx.beginPath();
      ctx.arc(bcx, cy, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // beak (faces the incoming player)
      ctx.fillStyle = '#ffd23e';
      ctx.beginPath();
      ctx.moveTo(bcx - 1.9, cy + 0.1);
      ctx.lineTo(bcx - 3.1, cy + 0.55);
      ctx.lineTo(bcx - 1.7, cy + 1);
      ctx.closePath();
      ctx.fill();
      // eye
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(bcx - 0.8, cy - 0.4, 0.62, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COL.birdDark;
      ctx.beginPath();
      ctx.arc(bcx - 1, cy - 0.35, 0.3, 0, Math.PI * 2);
      ctx.fill();
    } else if (o.type === 'slider') {
      const wx = o.wx - cam, top = GROUND - o.bh;
      ctx.fillStyle = COL.block;
      rr(wx, top, o.bw, o.bh, 1);
      ctx.fill();
      ctx.strokeStyle = COL.blockDark;
      ctx.lineWidth = 0.8;
      rr(wx + 0.4, top + 0.4, o.bw - 0.8, o.bh - 0.8, 0.8);
      ctx.stroke();
      // motion chevrons
      ctx.strokeStyle = COL.blockDark;
      ctx.lineWidth = 0.55;
      const my = top + o.bh * 0.55;
      ctx.beginPath();
      ctx.moveTo(wx + o.bw * 0.38, my - 1); ctx.lineTo(wx + o.bw * 0.22, my); ctx.lineTo(wx + o.bw * 0.38, my + 1);
      ctx.moveTo(wx + o.bw * 0.62, my - 1); ctx.lineTo(wx + o.bw * 0.78, my); ctx.lineTo(wx + o.bw * 0.62, my + 1);
      ctx.stroke();
      // eyes
      ctx.fillStyle = COL.blockDark;
      ctx.beginPath();
      ctx.arc(wx + o.bw * 0.34, top + 1.6, 0.55, 0, Math.PI * 2);
      ctx.arc(wx + o.bw * 0.66, top + 1.6, 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // particles (behind player)
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - cam - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;

  // player trail
  if (state === 'play' || state === 'dying') {
    const trailCol = avatar().color;
    for (const tr of P.trail) {
      if (tr.t <= 0) continue;
      ctx.globalAlpha = tr.t * 0.22;
      ctx.fillStyle = trailCol;
      const s = PW * (0.5 + tr.t * 0.4);
      ctx.save();
      ctx.translate(tr.x - cam, tr.y - PH / 2);
      ctx.rotate(tr.rot);
      rr(-s / 2, -s / 2, s, s, 1.6);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // player
  drawPlayer(cam);

  // popups (canvas text scales with the transform — stays crisp)
  for (const p of popups) {
    ctx.globalAlpha = clamp(p.life, 0, 1);
    ctx.fillStyle = p.color;
    ctx.font = '900 ' + (p.big ? 5.2 : 3.6) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.6;
    // keep the whole text on-screen at any aspect ratio
    const hw = ctx.measureText(p.text).width / 2;
    const tx = clamp(p.x, hw + 1, Wu - hw - 1);
    ctx.strokeText(p.text, tx, p.y);
    ctx.fillText(p.text, tx, p.y);
  }
  ctx.globalAlpha = 1;

  // death flash + vignette drawn in raw pixel space
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (flash > 0) {
    ctx.fillStyle = 'rgba(255,255,255,' + flash * 0.8 + ')';
    ctx.fillRect(0, 0, W, H);
  }
  if (!vignette) {
    vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.44, W / 2, H / 2, Math.max(W, H) * 0.78);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(10,5,35,0.34)');
  }
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);
}

function drawPlayer(cam) {
  const px = state === 'menu' ? Wu * 0.14 : P.x - cam;
  let py = state === 'menu' ? GROUND : P.y;
  if (state === 'menu') py += Math.sin(time * 3) * 0.6;

  // squash & stretch
  let sxScale = 1, syScale = 1;
  if (P.landT > 0) {
    const e = Math.sin((P.landT / 0.18) * Math.PI);
    sxScale = 1 + 0.28 * e;
    syScale = 1 - 0.3 * e;
  } else if (!P.grounded && state === 'play') {
    syScale = 1 + Math.min(0.25, Math.abs(P.vy) / 380);
    sxScale = 1 / syScale;
  }

  const av = avatar();
  ctx.save();
  ctx.translate(px, py - (PH * syScale) / 2);
  ctx.rotate(state === 'menu' ? 0 : P.rot);
  ctx.scale(sxScale, syScale);

  // glow
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = av.color;
  rr(-PW * 0.68, -PH * 0.68, PW * 1.36, PH * 1.36, 2.6);
  ctx.fill();
  ctx.globalAlpha = 1;

  NS.drawAvatar(ctx, av, 0, 0, PW, {
    lookY: state === 'play' ? clamp(P.vy / 220, -0.9, 0.9) : 0,
    blink: P.blinkT < 0,
  });

  ctx.restore();
}

// ---------- main loop ----------
let last = performance.now(), sizePollT = 0;
function frame(now) {
  let dt = Math.min((now - last) / 1000, 1 / 30);
  last = now;
  // safety net: some environments (rotation mid-animation, URL bar
  // show/hide, emulated viewports) miss or misreport resize events
  sizePollT += dt;
  if (sizePollT > 0.25) {
    sizePollT = 0;
    if (window.innerWidth !== W || window.innerHeight !== H) resize();
  }
  if (hitStop > 0) { hitStop -= dt; dt = 0; }
  if (!paused) update(dt);
  render();
  requestAnimationFrame(frame);
}

// ---------- boot ----------
resize();
bestChip.textContent = 'BEST ' + best + 'm';
requestAnimationFrame(frame);

// hidden inspection hook (open the page with #debug)
if (location.hash === '#debug') {
  window.__NJ = {
    get s() {
      return {
        state, meters: meters.toFixed(1), bonusPts, px: P.x.toFixed(1), py: P.y.toFixed(2),
        vy: P.vy.toFixed(1), grounded: P.grounded, airJumps: P.airJumps,
        speed: curSpeed().toFixed(1), Wu: Wu.toFixed(1), obs: obstacles.length, nextX: nextX.toFixed(0),
        types: obstacles.map(o => o.type).join(','),
        widths: obstacles.map(o => o.type + ':' + o.w.toFixed(1) + (o.h ? '/h' + o.h.toFixed(1) : '')).join(' '),
        jd: (curSpeed() * AIR_T).toFixed(1),
      };
    },
    warp(m) { // jump to a distance to preview late-game difficulty
      if (state !== 'play') return 'not playing';
      P.x = m / M_PER_U;
      P.y = GROUND; P.vy = 0; P.grounded = true;
      meters = m;
      nextMilestone = Math.ceil(m / 100) * 100 + 100;
      nextLevelAt = Math.ceil(m / 250) * 250 + 250;
      gotBest = meters > best;
      obstacles = [];
      nextX = camX() + Wu + 10;
      return 'warped to ' + m + 'm';
    },
  };
}

})();
