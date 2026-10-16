'use strict';
// Logic ứng dụng, độc lập nơi chạy (Vercel hay server local) và nơi lưu (Supabase hay file).
const crypto = require('crypto');
const { run, PER_COURT, MAX_PER_COURT } = require('../scheduler');

const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_PER_WEEK = 3;
const DEFAULT_COURTS = [['17:00-19:00'], ['17:00-19:00', '17:00-18:30'], [], ['17:00-19:00', '17:00-18:30'], ['17:00-18:30'], [], []];

const normCourt = x => typeof x === 'object' && x
  ? { name: String(x.name || '').trim().slice(0, 30), time: String(x.time || '').trim().slice(0, 30) }
  : { name: '', time: String(x ?? '').trim().slice(0, 30) };
const normCourts = c => Array.from({ length: 7 }, (_, d) => Array.isArray(c?.[d]) ? c[d].map(normCourt)
  : Array.from({ length: Math.max(0, Math.min(20, parseInt(c?.[d]) || 0)) }, () => normCourt('')));

const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const cleanName = x => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 60);
const publicUser = u => u && { username: u.username, name: u.name, role: u.role };
const validKey = k => /^\d{4}-\d{2}-\d{2}$/.test(k || '');
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function createApp(store) {
  const settings = async () => ({ perCourt: PER_COURT, maxPerCourt: MAX_PER_COURT, maxPerWeek: MAX_PER_WEEK,
    defaultCourts: normCourts((await store.getDefaultCourts()) || DEFAULT_COURTS) });

  async function weekOf(key) {
    const w = await store.getWeek(key);
    return { courts: normCourts(w?.courts || (await settings()).defaultCourts), schedule: w?.schedule || null };
  }

  async function history(beforeKey) {
    const tot = {}, cnt = {};
    for (const w of await store.listScheduledWeeks()) {
      if (w.key >= beforeKey) continue;
      for (const [n, ds] of Object.entries(w.schedule.perMember || {})) { tot[n] = (tot[n] || 0) + ds.length; cnt[n] = (cnt[n] || 0) + 1; }
    }
    return Object.fromEntries(Object.keys(tot).map(n => [n, tot[n] / cnt[n]]));
  }

  async function stats() {
    const weeks = [], members = {}, days = Array.from({ length: 7 }, () => ({ weeks: 0, used: 0, cap: 0 }));
    const regs = await store.listAllRegs();
    for (const w of (await store.listScheduledWeeks()).sort((a, b) => a.key.localeCompare(b.key))) {
      let used = 0, cap = 0, emptySeats = 0, courtsAvail = 0, courtsOpen = 0;
      for (const [d, s] of Object.entries(w.schedule.sessions)) {
        used += s.players.length; cap += s.capacity; emptySeats += Math.max(0, s.capacity - s.players.length);
        courtsAvail += s.courtsAvailable; courtsOpen += s.courts.filter(c => c.length).length;
        const x = days[d]; x.weeks++; x.used += s.players.length; x.cap += s.capacity;
      }
      weeks.push({ week: w.key, used, cap, emptySeats, emptySeatRate: cap ? emptySeats / cap : 0, courtsAvail, courtsOpen, emptyCourtRate: courtsAvail ? 1 - courtsOpen / courtsAvail : 0 });
      for (const r of regs.filter(r => r.week === w.key)) {
        const m = (members[r.name] ||= { name: r.name, weeks: 0, sessions: 0, registeredDays: 0, metMin: 0 });
        const got = (w.schedule.perMember[r.name] || []).length;
        m.weeks++; m.sessions += got; m.registeredDays += r.days.length; m.metMin += got >= (r.minSessions || 2) ? 1 : 0;
      }
    }
    const sum = f => weeks.reduce((a, w) => a + w[f], 0);
    return {
      members: Object.values(members).map(m => ({ ...m, avgPerWeek: m.sessions / m.weeks, attendRate: m.registeredDays ? m.sessions / m.registeredDays : 0 })).sort((a, b) => b.sessions - a.sessions),
      weeks, days: days.map(x => ({ ...x, fill: x.cap ? x.used / x.cap : null })),
      overall: { weeks: weeks.length, emptySeatRate: sum('cap') ? sum('emptySeats') / sum('cap') : 0, emptyCourtRate: sum('courtsAvail') ? 1 - sum('courtsOpen') / sum('courtsAvail') : 0 },
    };
  }

  async function assign(key) {
    const w = await weekOf(key);
    const regs = await store.listRegs(key);
    const res = run({ courts: w.courts, members: regs.map(r => ({ name: r.name, days: r.days, minSessions: r.minSessions })),
      maxPerWeek: MAX_PER_WEEK, perCourt: PER_COURT, maxPerCourt: MAX_PER_COURT, history: await history(key) });
    const schedule = { ...res, createdAt: new Date().toISOString() };
    await store.saveWeek(key, { courts: w.courts, schedule });
    return schedule;
  }

  async function startSession(ctx, username) {
    const token = crypto.randomBytes(32).toString('hex');
    await store.putSession(sha(token), { username, exp: Date.now() + SESSION_MS });
    ctx.cookie = { value: token, maxAge: SESSION_MS / 1000 };
  }
  const adminCount = async () => (await store.listUsers()).filter(u => u.role === 'admin').length;
  async function dropSessions(username) { await store.delSessionsOf(username); }

  // auth: 'none' | 'user' | 'admin'
  const routes = {
    'GET /api/me': { auth: 'none', fn: async (q, b, u) => ({ user: publicUser(u), firstUser: (await store.countUsers()) === 0 }) },

    'POST /api/signup': { auth: 'none', fn: async (q, b, u, ctx) => {
      const username = String(b.username || '').trim().toLowerCase();
      const name = cleanName(b.name), pw = String(b.password || '');
      if (!/^[a-z0-9_.-]{3,30}$/.test(username)) throw new Error('Tên đăng nhập 3–30 ký tự: chữ thường không dấu, số, . _ -');
      if (!name) throw new Error('Nhập họ tên hiển thị');
      if (pw.length < 6) throw new Error('Mật khẩu tối thiểu 6 ký tự');
      const users = await store.listUsers();
      if (users.some(x => x.username === username)) throw new Error('Tên đăng nhập đã tồn tại');
      if (users.some(x => x.name.toLowerCase() === name.toLowerCase())) throw new Error('Họ tên này đã có người dùng, hãy thêm chi tiết để phân biệt');
      const first = users.length === 0, salt = crypto.randomBytes(16).toString('hex');
      const user = { username, name, salt, hash: hashPw(pw, salt), role: first ? 'admin' : 'member', status: first ? 'active' : 'pending', createdAt: new Date().toISOString() };
      await store.putUser(user);
      if (!first) return { pending: true };
      await startSession(ctx, username);
      return { user: publicUser(user) };
    } },

    'POST /api/login': { auth: 'none', fn: async (q, b, u, ctx) => {
      const username = String(b.username || '').trim().toLowerCase();
      const key = ctx.ip + '|' + username;
      const f = await store.getFail(key);
      if (f && f.n >= 8 && Date.now() - f.t < 10 * 60 * 1000) throw new Error('Sai quá nhiều lần, thử lại sau 10 phút');
      const x = await store.getUser(username);
      const ok = x && crypto.timingSafeEqual(Buffer.from(hashPw(String(b.password || ''), x.salt), 'hex'), Buffer.from(x.hash, 'hex'));
      if (!ok) { await store.setFail(key, { n: (f && Date.now() - f.t < 10 * 60 * 1000 ? f.n : 0) + 1, t: Date.now() }); throw new Error('Sai tên đăng nhập hoặc mật khẩu'); }
      if (x.status === 'pending') throw new Error('Tài khoản đang chờ quản trị viên duyệt');
      await store.delFail(key); await startSession(ctx, username);
      return { user: publicUser(x) };
    } },

    'POST /api/logout': { auth: 'none', fn: async (q, b, u, ctx) => {
      if (ctx.token) await store.delSession(sha(ctx.token));
      ctx.cookie = { value: '', maxAge: 0 }; return { ok: true };
    } },

    'POST /api/password': { auth: 'user', fn: async (q, b, u) => {
      if (hashPw(String(b.old || ''), u.salt) !== u.hash) throw new Error('Mật khẩu cũ không đúng');
      if (String(b.password || '').length < 6) throw new Error('Mật khẩu mới tối thiểu 6 ký tự');
      const salt = crypto.randomBytes(16).toString('hex');
      await store.putUser({ ...u, salt, hash: hashPw(String(b.password), salt) }); return { ok: true };
    } },

    'GET /api/state': { auth: 'user', fn: async (q, b, u) => {
      const w = await weekOf(q.week), all = await store.listRegs(q.week);
      const counts = Array.from({ length: 7 }, (_, d) => all.filter(r => r.days.includes(d)).length);
      const vis = u.role === 'admin' ? all : all.filter(r => r.name === u.name);
      return { settings: await settings(), key: q.week, counts,
        week: { courts: w.courts, schedule: w.schedule, registrations: Object.fromEntries(vis.map(r => [r.name, r])) } };
    } },

    'PUT /api/register': { auth: 'user', fn: async (q, b, u) => {
      const admin = u.role === 'admin';
      const name = admin ? cleanName(b.name) : u.name;
      if (!name) throw new Error('Thiếu tên');
      const days = [...new Set((b.days || []).map(Number).filter(d => d >= 0 && d < 7))];
      if (!days.length) throw new Error('Chọn ít nhất 1 ngày');
      const old = await store.getReg(b.week, name);
      if (!admin && old && old.username && old.username !== u.username) throw new HttpError(403, 'Không có quyền');
      const minSessions = admin ? (b.minSessions === 1 ? 1 : 2) : (old ? old.minSessions : 2);
      const username = admin ? (name === u.name ? u.username : old?.username) : u.username;
      await store.putReg(b.week, { name, days, minSessions, username: username || null, at: new Date().toISOString() });
      return { ok: true };
    } },

    'DELETE /api/register': { auth: 'user', fn: async (q, b, u) => {
      const r = await store.getReg(b.week, b.name);
      if (u.role !== 'admin' && !(r && r.name === u.name)) throw new HttpError(403, 'Không có quyền');
      await store.delReg(b.week, b.name); return { ok: true };
    } },

    'PUT /api/courts': { auth: 'admin', fn: async (q, b) => {
      if (!Array.isArray(b.courts) || b.courts.length !== 7) throw new Error('Cần 7 ngày');
      const c = normCourts(b.courts), w = await weekOf(b.week);
      await store.saveWeek(b.week, { courts: c, schedule: w.schedule });
      if (b.setDefault) await store.setDefaultCourts(c);
      return { ok: true };
    } },
    'POST /api/assign': { auth: 'admin', fn: (q, b) => assign(b.week) },
    'GET /api/stats': { auth: 'admin', fn: () => stats() },

    'GET /api/users': { auth: 'admin', fn: async () => (await store.listUsers()).map(x => ({ username: x.username, name: x.name, role: x.role, status: x.status || 'active', createdAt: x.createdAt })) },
    'PUT /api/users/approve': { auth: 'admin', fn: async (q, b) => {
      const x = await store.getUser(b.username); if (!x) throw new Error('Không tìm thấy');
      await store.putUser({ ...x, status: 'active' }); return { ok: true };
    } },
    'PUT /api/users/role': { auth: 'admin', fn: async (q, b) => {
      const x = await store.getUser(b.username); if (!x) throw new Error('Không tìm thấy');
      if (!['admin', 'member'].includes(b.role)) throw new Error('Quyền không hợp lệ');
      if (x.role === 'admin' && b.role !== 'admin' && (await adminCount()) <= 1) throw new Error('Phải còn ít nhất 1 quản trị viên');
      await store.putUser({ ...x, role: b.role }); return { ok: true };
    } },
    'PUT /api/users/password': { auth: 'admin', fn: async (q, b) => {
      const x = await store.getUser(b.username); if (!x) throw new Error('Không tìm thấy');
      if (String(b.password || '').length < 6) throw new Error('Mật khẩu tối thiểu 6 ký tự');
      const salt = crypto.randomBytes(16).toString('hex');
      await store.putUser({ ...x, salt, hash: hashPw(String(b.password), salt) });
      await dropSessions(x.username); return { ok: true };
    } },
    'DELETE /api/users': { auth: 'admin', fn: async (q, b) => {
      const x = await store.getUser(b.username); if (!x) throw new Error('Không tìm thấy');
      if (x.role === 'admin' && (await adminCount()) <= 1) throw new Error('Phải còn ít nhất 1 quản trị viên');
      await dropSessions(x.username); await store.delUser(x.username); return { ok: true };
    } },
  };

  // req: {method, path, query, body, token, ip, contentType}
  async function handle(req) {
    const r = routes[`${req.method} ${req.path}`];
    if (!r) return { status: 404, json: { error: 'Not found' } };
    if (req.method !== 'GET' && !/json/.test(req.contentType || '')) return { status: 415, json: { error: 'Content-Type phải là JSON' } };
    const ctx = { ip: req.ip, token: req.token };
    try {
      let user = null;
      if (req.token) {
        const s = await store.getSession(sha(req.token));
        if (s && s.exp > Date.now()) { const x = await store.getUser(s.username); if (x && x.status !== 'pending') user = x; }
      }
      if (r.auth !== 'none' && !user) return { status: 401, json: { error: 'Cần đăng nhập' } };
      if (r.auth === 'admin' && user.role !== 'admin') return { status: 403, json: { error: 'Chỉ quản trị viên' } };
      const q = req.query || {}, b = req.body || {};
      if ((q.week || b.week) !== undefined && !validKey(q.week || b.week)) throw new Error('Tuần không hợp lệ');
      const json = await r.fn(q, b, user, ctx);
      return { status: 200, json, cookie: ctx.cookie };
    } catch (e) {
      if (e instanceof HttpError) return { status: e.code, json: { error: e.message } };
      if (!(e instanceof Error) || e.isInternal) console.error(e);
      return { status: 400, json: { error: e.message } };
    }
  }
  return { handle, normCourts, DEFAULT_COURTS };
}

const cookieHeader = (c, secure) => c && `sid=${c.value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${c.maxAge}${secure ? '; Secure' : ''}`;
const tokenFrom = cookie => (/(?:^|;\s*)sid=([0-9a-f]{64})/.exec(cookie || '') || [])[1];
module.exports = { createApp, cookieHeader, tokenFrom };
