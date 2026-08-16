/* ============================================================
   NOVA JUMP — profiles, avatars & the scoreboard.

   Storage today is localStorage. Every read/write goes through
   the async `backend` object, whose API matches the Cloudflare
   Worker in cloudflare-worker.example.js — deploy that Worker,
   put its URL in SCORE_API.url below, and the board goes global
   with zero other changes. Local storage keeps working as the
   offline cache/fallback either way.
   ============================================================ */
(() => {
'use strict';

if (window.NovaScores) return;

// ---------- Cloudflare hookup point ----------
const SCORE_API = {
  url: '',            // e.g. 'https://nova-jump-scores.yourname.workers.dev'
  timeoutMs: 4000,
};

const LS_PROFILE = 'novaJumpProfile';
const LS_BOARD = 'novaJumpBoard';
const BOARD_CAP = 100;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

// ---------- avatar catalog (all vector, all code) ----------
const AVATARS = [
  { id: 'boxy', label: 'BOXY', color: '#2bffc6', dark: '#0d3b4f' },
  { id: 'pip',  label: 'PIP',  color: '#ffd23e', dark: '#5a3d00' },
  { id: 'trig', label: 'TRIG', color: '#ff5d8f', dark: '#5c0a26' },
  { id: 'gem',  label: 'GEM',  color: '#7c8cff', dark: '#1d2366' },
  { id: 'star', label: 'STAR', color: '#ff9e44', dark: '#6b3300' },
  { id: 'hexa', label: 'HEXA', color: '#b980ff', dark: '#3c1266' },
];
const avatarById = id => AVATARS.find(a => a.id === id) || AVATARS[0];

/* Draw an avatar centered at (cx, cy), body fitting an s x s box.
   face: {lookY: -1..1, blink: bool} — callers apply their own
   rotation/squash via the canvas transform first. */
function drawAvatar(ctx, av, cx, cy, s, face) {
  face = face || {};
  const h = s / 2;
  ctx.save();
  ctx.translate(cx, cy);

  ctx.fillStyle = av.color;
  ctx.strokeStyle = av.dark;
  ctx.lineWidth = s * 0.11;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (av.id) {
    case 'pip':
      ctx.arc(0, 0, h * 0.96, 0, Math.PI * 2);
      break;
    case 'trig':
      ctx.moveTo(0, -h);
      ctx.lineTo(h * 1.02, h * 0.82);
      ctx.lineTo(-h * 1.02, h * 0.82);
      ctx.closePath();
      break;
    case 'gem':
      ctx.moveTo(0, -h * 1.05);
      ctx.lineTo(h * 0.92, 0);
      ctx.lineTo(0, h * 1.05);
      ctx.lineTo(-h * 0.92, 0);
      ctx.closePath();
      break;
    case 'star': {
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? h * 1.12 : h * 0.5;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      break;
    }
    case 'hexa': {
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 3;
        ctx.lineTo(Math.cos(a) * h, Math.sin(a) * h);
      }
      ctx.closePath();
      break;
    }
    default: { // boxy
      const r = s * 0.26;
      ctx.moveTo(-h + r, -h);
      ctx.arcTo(h, -h, h, h, r);
      ctx.arcTo(h, h, -h, h, r);
      ctx.arcTo(-h, h, -h, -h, r);
      ctx.arcTo(-h, -h, h, -h, r);
      ctx.closePath();
    }
  }
  ctx.fill();
  ctx.stroke();

  // face — nudged down for the pointy-top shapes
  const fy = (av.id === 'trig' || av.id === 'gem' || av.id === 'star') ? s * 0.08 : -s * 0.08;
  const exL = s * 0.1, exR = s * 0.32;
  const lookY = (face.lookY || 0) * s * 0.09;
  if (face.blink) {
    ctx.strokeStyle = av.dark;
    ctx.lineWidth = s * 0.07;
    ctx.beginPath();
    ctx.moveTo(exL - s * 0.11, fy); ctx.lineTo(exL + s * 0.11, fy);
    ctx.moveTo(exR - s * 0.11, fy); ctx.lineTo(exR + s * 0.11, fy);
    ctx.stroke();
  } else {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(exL, fy, s * 0.17, 0, Math.PI * 2);
    ctx.arc(exR, fy, s * 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = av.dark;
    ctx.beginPath();
    ctx.arc(exL + s * 0.05, fy + lookY, s * 0.08, 0, Math.PI * 2);
    ctx.arc(exR + s * 0.05, fy + lookY, s * 0.08, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = av.dark;
  ctx.lineWidth = s * 0.07;
  ctx.beginPath();
  ctx.arc(s * 0.18, fy + s * 0.24, s * 0.13, Math.PI * 0.12, Math.PI * 0.88);
  ctx.stroke();

  ctx.restore();
}

// ---------- profile ----------
let profile = null;
try { profile = JSON.parse(store.get(LS_PROFILE) || 'null'); } catch (e) { profile = null; }
if (profile && !profile.id) profile = null;

function newId() {
  try { return crypto.randomUUID(); } catch (e) {
    return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
}

const NAME_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function randName() {
  let s = '';
  for (let i = 0; i < 8; i++) s += NAME_CHARS[Math.floor(Math.random() * NAME_CHARS.length)];
  return s;
}

function cleanName(raw) {
  const n = String(raw || '').replace(/[<>&"'`]/g, '').trim().toUpperCase().slice(0, 12);
  return n || randName();
}

let lastEntry = null; // most recently submitted run, so a rename can reach it

function saveProfile(name, avatarId) {
  profile = {
    id: (profile && profile.id) || newId(),
    name: cleanName(name),
    avatar: avatarById(avatarId).id,
  };
  store.set(LS_PROFILE, JSON.stringify(profile));
  // the new name/shape also applies to the run that was just recorded
  if (lastEntry && lastEntry.id === profile.id) {
    lastEntry.name = profile.name;
    lastEntry.avatar = profile.avatar;
    localBackend.list(BOARD_CAP).then(board => {
      const i = board.findIndex(e => e.id === lastEntry.id && e.t === lastEntry.t);
      if (i >= 0) { board[i] = { ...lastEntry }; store.set(LS_BOARD, JSON.stringify(board)); }
    });
  }
  return profile;
}

function ensureProfile() {
  if (!profile) saveProfile('', pickedAvatar); // '' -> random 8-char handle
  return profile;
}

// ---------- backends ----------
// The local board keeps every run — it's this device's personal history,
// so your top-10 runs is the interesting view. The Cloudflare Worker
// instead keeps only each player's best, so no one floods the global top.
const localBackend = {
  label: 'LOCAL BOARD',
  async list(limit) {
    let board;
    try { board = JSON.parse(store.get(LS_BOARD) || '[]'); } catch (e) { board = []; }
    if (!Array.isArray(board)) board = [];
    return board.slice(0, limit);
  },
  async submit(entry) {
    const board = await this.list(BOARD_CAP);
    board.push(entry);
    board.sort((a, b) => b.score - a.score);
    store.set(LS_BOARD, JSON.stringify(board.slice(0, BOARD_CAP)));
  },
};

const apiBase = () => SCORE_API.url.replace(/\/+$/, ''); // tolerate a pasted trailing slash

const remoteBackend = {
  label: 'GLOBAL BOARD',
  async list(limit) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), SCORE_API.timeoutMs);
    try {
      const res = await fetch(apiBase() + '/scores?limit=' + limit, { signal: ctl.signal });
      if (!res.ok) throw new Error('bad status ' + res.status);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } finally { clearTimeout(t); }
  },
  async submit(entry) {
    await fetch(apiBase() + '/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
  },
};

const remoteEnabled = () => !!SCORE_API.url;

async function listScores(limit) {
  if (remoteEnabled()) {
    try {
      return { label: remoteBackend.label, rows: await remoteBackend.list(limit) };
    } catch (e) { /* fall through to local */ }
  }
  return { label: localBackend.label, rows: await localBackend.list(limit) };
}

function submitRun(run) {
  if (!profile || !run || run.score <= 0) return;
  const entry = {
    id: profile.id,
    name: profile.name,
    avatar: profile.avatar,
    score: Math.floor(run.score),
    meters: Math.floor(run.meters),
    t: Date.now(),
  };
  lastEntry = entry;
  localBackend.submit(entry);
  if (remoteEnabled()) remoteBackend.submit(entry).catch(() => {});
}

// ---------- panels (DOM) ----------
const el = id => document.getElementById(id);
const profilePanel = el('profilePanel'), scoresPanel = el('scores');
const avatarGrid = el('avatarGrid'), nameInput = el('nameInput');
const boardList = el('boardList'), boardScope = el('boardScope');
const expandBtn = el('expandBoard');

let pickedAvatar = (profile && profile.avatar) || 'boxy';
let onProfileDone = null, onScoresClose = null, expanded = false;

function avatarCanvas(avId, px) {
  const c = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  c.width = px * dpr; c.height = px * dpr;
  c.style.width = px + 'px'; c.style.height = px + 'px';
  const cc = c.getContext('2d');
  cc.scale(dpr, dpr);
  drawAvatar(cc, avatarById(avId), px / 2, px / 2, px * 0.62, {});
  return c;
}

function buildAvatarGrid() {
  avatarGrid.innerHTML = '';
  for (const av of AVATARS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'avatarOpt' + (av.id === pickedAvatar ? ' picked' : '');
    b.appendChild(avatarCanvas(av.id, 56));
    const lab = document.createElement('span');
    lab.textContent = av.label;
    b.appendChild(lab);
    b.addEventListener('click', () => {
      pickedAvatar = av.id;
      for (const o of avatarGrid.children) o.classList.remove('picked');
      b.classList.add('picked');
    });
    avatarGrid.appendChild(b);
  }
}

function openProfile(onDone, afterRun) {
  onProfileDone = onDone || null;
  pickedAvatar = (profile && profile.avatar) || pickedAvatar;
  el('profileTitle').textContent = afterRun ? 'NICE RUN! WHO ARE YOU?' : 'YOUR HERO';
  // previously entered name is remembered; otherwise offer a random handle
  nameInput.value = (profile && profile.name) || randName();
  buildAvatarGrid();
  profilePanel.classList.remove('hidden');
}

el('saveProfile').addEventListener('click', () => {
  saveProfile(nameInput.value, pickedAvatar);
  nameInput.blur();
  profilePanel.classList.add('hidden');
  const cb = onProfileDone; onProfileDone = null;
  if (cb) cb(profile);
});
nameInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') el('saveProfile').click();
});

function rowFor(entry, rank, mine) {
  const row = document.createElement('div');
  row.className = 'boardRow' + (mine ? ' mine' : '');
  const rk = document.createElement('span');
  rk.className = 'rank';
  rk.textContent = rank;
  const av = avatarCanvas(entry.avatar, 30);
  av.className = 'rowAv';
  const info = document.createElement('span');
  info.className = 'rowInfo';
  const nm = document.createElement('b');
  nm.textContent = entry.name || 'ANON';
  const mt = document.createElement('i');
  mt.textContent = (entry.meters || 0) + 'm';
  info.appendChild(nm); info.appendChild(mt);
  const sc = document.createElement('span');
  sc.className = 'rowScore';
  sc.textContent = entry.score;
  row.appendChild(rk); row.appendChild(av); row.appendChild(info); row.appendChild(sc);
  return row;
}

let renderSeq = 0;
async function renderBoard() {
  const seq = ++renderSeq;
  boardList.innerHTML = '<p class="boardEmpty">LOADING…</p>';
  const limit = expanded ? BOARD_CAP : 10;
  const { label, rows } = await listScores(limit);
  if (seq !== renderSeq) return; // a newer render superseded this fetch
  boardScope.textContent = label + (expanded ? ' — TOP 100' : ' — TOP 10');
  boardList.innerHTML = '';
  if (!rows.length) {
    boardList.innerHTML = '<p class="boardEmpty">NO SCORES YET — GO SET ONE!</p>';
    return;
  }
  rows.forEach((r, i) => boardList.appendChild(rowFor(r, i + 1, profile && r.id === profile.id)));
}

function openScores(onClose) {
  onScoresClose = onClose || null;
  expanded = false;
  expandBtn.textContent = 'TOP 100';
  scoresPanel.classList.remove('hidden');
  renderBoard();
}

expandBtn.addEventListener('click', () => {
  expanded = !expanded;
  expandBtn.textContent = expanded ? 'TOP 10' : 'TOP 100';
  renderBoard();
});

el('closeScores').addEventListener('click', () => {
  scoresPanel.classList.add('hidden');
  const cb = onScoresClose; onScoresClose = null;
  if (cb) cb();
});

// ---------- public API ----------
window.NovaScores = {
  AVATARS,
  avatarById,
  drawAvatar,
  hasProfile: () => !!profile,
  ensureProfile,
  current: () => avatarById(profile ? profile.avatar : 'boxy'),
  profileName: () => (profile ? profile.name : 'ANON'),
  openProfile,
  openScores,
  submitRun,
  remoteEnabled,
};

})();
