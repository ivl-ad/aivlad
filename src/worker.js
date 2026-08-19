/* ===========================================================================
   SEEDWORLD — multiplayer relay
   ---------------------------------------------------------------------------
   One Durable Object per world seed. It does not simulate anything: clients
   own their own movement, the room takes deltas, clamps the obvious nonsense,
   and fans them out to whoever is close enough to care.

   The 600 ms synchronisation does NOT happen here. Clients derive their tick
   number from wall clock (Date.now() + offset), and this Worker's only role in
   that is echoing timestamps for the offset estimate. That is deliberate — a
   server-side tick loop would keep the Durable Object awake permanently and
   an empty world would cost money.
   =========================================================================== */

import { DurableObject } from 'cloudflare:workers';

const VIEW = 48;      // interest radius in tiles; render radius is ~7 chunks
const RATE = 25;      // client messages per second before we start dropping
const MAXMSG = 512;   // bytes

const encoder = new TextEncoder();
const toHex = b => [...new Uint8Array(b)].map(v => v.toString(16).padStart(2, '0')).join('');
const sha256 = async s => toHex(await crypto.subtle.digest('SHA-256', encoder.encode(s)));

/* =========================== THE ROOM ==================================== */

export class World extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.players = new Map();   // pid -> record
    this.pending = new Map();   // dedupe key -> message
    this.timer = null;

    // With the hibernation API this object can be evicted between messages and
    // rebuilt. Per-connection state therefore lives on the socket, not here.
    for (const ws of ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a) this.players.set(a.pid, { ws, ...a, seen: new Set(), n: 0, t0: 0 });
    }
  }

  async fetch(req) {
    const u = new URL(req.url);
    const pid = u.searchParams.get('pid');
    const name = u.searchParams.get('name') || 'Adventurer';
    if (!pid) return new Response('no pid', { status: 400 });

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);          // NOT server.accept() — that kills hibernation

    const rec = { pid, name, x: 0, z: 0, face: 0, flags: 0, eq: [] };
    server.serializeAttachment(rec);
    this.players.set(pid, { ws: server, ...rec, seen: new Set(), n: 0, t0: 0 });

    server.send(JSON.stringify([[0, pid, Date.now()]]));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment();
    if (!att) return;
    const me = this.players.get(att.pid);
    if (!me || typeof raw !== 'string' || raw.length > MAXMSG) return;

    const now = Date.now();
    if (now - me.t0 > 1000) { me.t0 = now; me.n = 0; }
    if (++me.n > RATE) return;

    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(m)) return;

    switch (m[0]) {

      case 1: {                                  // move
        const [, tick, x, z, face, flags] = m;
        if (!Number.isInteger(x) || !Number.isInteger(z)) return;
        if (Math.abs(x) > 1e6 || Math.abs(z) > 1e6) return;
        me.x = x; me.z = z;
        me.face = (face | 0) & 15;
        me.flags = (flags | 0) & 3;
        this.queue('1:' + me.pid, [1, [[me.pid, tick | 0, x, z, me.face, me.flags]]]);
        break;
      }

      case 2:                                    // action animation
        this.queue('2:' + me.pid, [2, me.pid, (m[2] | 0) & 255]);
        break;

      case 3:                                    // equipment
        me.eq = Array.isArray(m[1])
          ? m[1].slice(0, 5).map(v => (v == null ? null : String(v).slice(0, 32)))
          : [];
        this.queue('3:' + me.pid, [3, me.pid, me.eq]);
        break;

      case 4: {                                  // chat
        const text = String(m[1] ?? '').slice(0, 120);
        if (text) this.queue('4:' + me.pid + ':' + now, [4, me.pid, text]);
        break;
      }

      case 8: {                                  // save blob
        let blob;
        try { blob = JSON.stringify(m[1]); } catch { return; }
        if (!blob || blob.length > 8192) return;
        try {
          await this.env.DB.prepare('UPDATE players SET save=?, updated=? WHERE pid=?')
            .bind(blob, now, me.pid).run();
        } catch (e) { console.log('save failed', me.pid, String(e)); }
        return;                                  // no attachment change
      }

      case 9:                                    // clock ping
        ws.send(JSON.stringify([[9, m[1], Date.now()]]));
        return;

      default:
        return;
    }

    ws.serializeAttachment({
      pid: me.pid, name: me.name, x: me.x, z: me.z,
      face: me.face, flags: me.flags, eq: me.eq
    });
  }

  /* One-shot timer only, never a repeating alarm. A repeating alarm keeps the
     object awake forever and blocks hibernation, which is where the bill is. */
  queue(key, msg) {
    this.pending.set(key, msg);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 40);
  }

  flush() {
    this.timer = null;
    const msgs = [...this.pending.values()];
    this.pending.clear();

    for (const p of this.players.values()) {
      const out = [];

      // interest management: emit enter/leave as people cross the view radius
      for (const q of this.players.values()) {
        if (q.pid === p.pid) continue;
        const near = Math.abs(q.x - p.x) <= VIEW && Math.abs(q.z - p.z) <= VIEW;
        if (near && !p.seen.has(q.pid)) {
          p.seen.add(q.pid);
          out.push([6, q.pid, q.name, q.x, q.z, q.eq]);
        } else if (!near && p.seen.has(q.pid)) {
          p.seen.delete(q.pid);
          out.push([5, q.pid]);
        }
      }

      for (const m of msgs) {
        const owner = m[0] === 1 ? m[1][0][0] : m[1];
        if (owner !== p.pid && p.seen.has(owner)) out.push(m);
      }

      if (out.length) { try { p.ws.send(JSON.stringify(out)); } catch {} }
    }
  }

  webSocketClose(ws) { this.drop(ws); }
  webSocketError(ws) { this.drop(ws); }

  drop(ws) {
    const a = ws.deserializeAttachment();
    if (!a) return;
    this.players.delete(a.pid);
    for (const p of this.players.values()) {
      if (p.seen.delete(a.pid)) {
        try { p.ws.send(JSON.stringify([[5, a.pid]])); } catch {}
      }
    }
  }
}

/* ============================ THE WORKER ================================= */

function cors(origin) {
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type'
  };
}

const json = (body, status, origin) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...cors(origin) }
});

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const list = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const originOk = list.length === 0 || list.includes(origin);

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: cors(originOk ? origin : 'null') });
    }

    /* ---------------- /ws : the only hot path ---------------- */
    if (u.pathname === '/ws') {
      // WebSocket upgrades skip CORS preflight entirely, so check this yourself
      if (!originOk) return new Response('forbidden origin', { status: 403 });
      // case-insensitive: some proxies send "WebSocket"
      if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }

      const auth = u.searchParams.get('auth') || '';
      const seed = (u.searchParams.get('seed') || 'lumbridge').slice(0, 32);
      if (!/^[0-9a-f]{64}$/.test(auth)) return new Response('bad auth', { status: 400 });

      let row;
      try {
        row = await env.DB.prepare('SELECT pid, name FROM players WHERE auth_hash=?')
          .bind(await sha256('v1|' + auth)).first();
      } catch (e) {
        console.log('db error on /ws', String(e));
        return new Response('db error', { status: 500 });
      }
      if (!row) return new Response('unknown key', { status: 401 });

      const target = new URL(req.url);
      target.searchParams.set('pid', row.pid);
      target.searchParams.set('name', row.name || 'Adventurer');

      const stub = env.WORLD.get(env.WORLD.idFromName('world:' + seed));
      return stub.fetch(new Request(target, req));
    }

    /* ---------------- /register ---------------- */
    if (u.pathname === '/register' && req.method === 'POST') {
      if (!originOk) return json({ e: 'origin' }, 403, 'null');

      let b;
      try { b = await req.json(); } catch { return json({ e: 'bad json' }, 400, origin); }
      const { auth, pid, name } = b || {};

      if (!/^[0-9a-f]{64}$/.test(auth || '')) return json({ e: 'bad auth' }, 400, origin);
      if (!/^[0-9a-f]{12}$/.test(pid || '')) return json({ e: 'bad pid' }, 400, origin);
      if (!/^[A-Za-z0-9 ]{2,12}$/.test(name || '')) return json({ e: 'bad name' }, 400, origin);

      const ipHash = await sha256('ip|' + (req.headers.get('cf-connecting-ip') || ''));
      const hourAgo = Date.now() - 3600e3;

      try {
        const c = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM players WHERE ip_hash=? AND created>?'
        ).bind(ipHash, hourAgo).first();
        if ((c?.n ?? 0) >= 5) return json({ e: 'too many accounts, try later' }, 429, origin);

        await env.DB.prepare(
          'INSERT INTO players (pid, auth_hash, name, ip_hash, created, updated) VALUES (?,?,?,?,?,?)'
        ).bind(pid, await sha256('v1|' + auth), name, ipHash, Date.now(), Date.now()).run();
      } catch (e) {
        const msg = String(e);
        if (msg.includes('UNIQUE')) return json({ e: 'name taken or key already used' }, 409, origin);
        console.log('register failed', msg);
        return json({ e: 'db error' }, 500, origin);
      }

      return json({ ok: 1, pid, name }, 200, origin);
    }

    /* ---------------- /save ---------------- */
    if (u.pathname === '/save' && req.method === 'GET') {
      if (!originOk) return json({ e: 'origin' }, 403, 'null');
      const auth = u.searchParams.get('auth') || '';
      if (!/^[0-9a-f]{64}$/.test(auth)) return json({ e: 'bad auth' }, 400, origin);

      let row;
      try {
        row = await env.DB.prepare('SELECT pid, name, seed, save FROM players WHERE auth_hash=?')
          .bind(await sha256('v1|' + auth)).first();
      } catch { return json({ e: 'db error' }, 500, origin); }
      if (!row) return json({ e: 'unknown key' }, 401, origin);

      let save = {};
      try { save = JSON.parse(row.save || '{}'); } catch {}
      return json({ pid: row.pid, name: row.name, seed: row.seed, save }, 200, origin);
    }

    /* ---------------- /health ---------------- */
    if (u.pathname === '/health') {
      try {
        await env.DB.prepare('SELECT 1').first();
        return json({ ok: 1, db: 'up', now: Date.now() }, 200, origin);
      } catch (e) {
        return json({ ok: 0, db: 'down', err: String(e) }, 500, origin);
      }
    }

    /* ---------------- /play : friendly alias for the game ---------------- */
    if (u.pathname === '/play' || u.pathname === '/play/') {
      return env.ASSETS.fetch(new Request(new URL('/seedworld.html', u), req));
    }

    /* ---------------- everything else: static files ----------------
       Your own index.html at the repo root is served at / untouched. */
    return env.ASSETS.fetch(req);
  }
};
