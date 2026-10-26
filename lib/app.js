'use strict';
// Logic ứng dụng, độc lập nơi chạy (Vercel hay server local) và nơi lưu (Supabase hay file).
const crypto = require('crypto');
const { run, layoutCourts, PER_COURT, MAX_PER_COURT } = require('../scheduler');

const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_PER_WEEK = 3;
// Thứ Hai đầu tiên của CLB (CLB bắt đầu từ tháng 11/2026). Muốn chạy thử các tuần trước đó, đặt biến môi trường CLUB_START=YYYY-MM-DD (phải là thứ Hai).
const CLUB_START = /^\d{4}-\d{2}-\d{2}$/.test(process.env.CLUB_START || '') && new Date(process.env.CLUB_START + 'T12:00').getDay() === 1 ? process.env.CLUB_START : '2026-11-02';
const viDate = k => k.slice(8) + '/' + k.slice(5, 7) + '/' + k.slice(0, 4);
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

// Đổi tên người chơi trong một lịch đã phân (danh sách người ở từng ngày + thống kê theo người)
function renameInSchedule(sc, from, to) {
  let changed = false;
  const f = n => (n === from ? (changed = true, to) : n);
  for (const sess of Object.values(sc.sessions || {})) {
    sess.players = sess.players.map(f);
    sess.courts = sess.courts.map(c => c.map(f));
  }
  if (sc.perMember && from in sc.perMember) { sc.perMember[to] = sc.perMember[from]; delete sc.perMember[from]; changed = true; }
  return changed;
}

// Mốc thời gian đăng ký theo TỪNG NGÀY: ngày đã có từ trước giữ mốc cũ, ngày mới thêm lấy mốc hiện tại.
// "at" (dùng để xét ưu tiên) = mốc muộn nhất trong các ngày đang đăng ký, tức lúc bộ ngày này được hoàn tất;
// lưu lại y nguyên các ngày không đổi thì không bị mất ưu tiên.
function stampDays(old, days, now) {
  const prev = old ? (old.dayTimes || Object.fromEntries((old.days || []).map(d => [d, old.at]))) : {};
  const dayTimes = {};
  for (const d of days) dayTimes[d] = prev[d] || now;
  return { dayTimes, at: Object.values(dayTimes).sort().at(-1) };
}

// Thành viên chỉ thấy lịch cuối cùng: ẩn dấu "đã chỉnh tay" và các cảnh báo nội bộ của quản trị viên
function publicSchedule(sc) {
  if (!sc) return sc;
  const { edited, warnings, ...rest } = sc;
  return rest;
}

function createApp(store) {
  // Lịch sân mặc định ít đổi -> nhớ 30 giây trong bộ nhớ để đỡ hỏi DB mỗi request
  let dcache = null, dcacheAt = 0;
  async function defaultCourts() {
    if (!dcache || Date.now() - dcacheAt > 30000) { dcache = normCourts((await store.getDefaultCourts()) || DEFAULT_COURTS); dcacheAt = Date.now(); }
    return dcache;
  }
  const settings = async () => ({ perCourt: PER_COURT, maxPerCourt: MAX_PER_COURT, maxPerWeek: MAX_PER_WEEK, clubStart: CLUB_START, defaultCourts: await defaultCourts() });

  async function weekOf(key, w) {
    if (w === undefined) w = await store.getWeek(key);
    return { courts: normCourts(w?.courts || await defaultCourts()), schedule: w?.schedule || null };
  }

  async function history(beforeKey) {
    const tot = {}, cnt = {};
    for (const w of await store.listScheduledWeeks()) {
      if (w.key >= beforeKey) continue;
      for (const [n, ds] of Object.entries(w.schedule.perMember || {})) { tot[n] = (tot[n] || 0) + ds.length; cnt[n] = (cnt[n] || 0) + 1; }
    }
    return Object.fromEntries(Object.keys(tot).map(n => [n, tot[n] / cnt[n]]));
  }

  // Thống kê chung: mọi tuần có đăng ký hoặc lịch; tần suất của TẤT CẢ thành viên (kể cả người chưa đăng ký lần nào)
  async function stats() {
    const regs = await store.listAllRegs(), users = await store.listUsers();
    const scheduled = Object.fromEntries((await store.listScheduledWeeks()).map(w => [w.key, w.schedule]));
    const keys = [...new Set([...Object.keys(scheduled), ...regs.map(r => r.week)])].sort();
    const weeks = [], members = {}, days = Array.from({ length: 7 }, () => ({ weeks: 0, used: 0, cap: 0, reg: 0 }));
    const mem = n => (members[n] ||= { name: n, weeks: 0, sessions: 0, registeredDays: 0, metMin: 0 });
    for (const u of users) mem(u.name);
    for (const key of keys) {
      const sc = scheduled[key], wr = regs.filter(r => r.week === key);
      let used = 0, cap = 0, emptySeats = 0, courtsAvail = 0, courtsOpen = 0;
      const reg = wr.reduce((a, r) => a + r.days.length, 0);
      for (let d = 0; d < 7; d++) days[d].reg += wr.filter(r => r.days.includes(d)).length;
      if (sc) {
        for (const [d, x] of Object.entries(sc.sessions)) {
          used += x.players.length; cap += x.capacity; emptySeats += Math.max(0, x.capacity - x.players.length);
          courtsAvail += x.courtsAvailable; courtsOpen += x.courts.filter(c => c.length).length;
          const t = days[d]; t.weeks++; t.used += x.players.length; t.cap += x.capacity;
        }
        const names = new Set([...wr.map(r => r.name), ...Object.keys(sc.perMember || {})]);
        for (const n of names) {
          const r = wr.find(x => x.name === n), got = (sc.perMember[n] || []).length;
          if (!r && !got) continue;
          const m = mem(n);
          m.weeks++; m.sessions += got; m.registeredDays += r ? r.days.length : 0; m.metMin += r && got >= (r.minSessions || 2) ? 1 : 0;
        }
      }
      weeks.push({ week: key, scheduled: !!sc, people: wr.length, reg, used, cap, emptySeats, emptySeatRate: cap ? emptySeats / cap : 0,
        courtsAvail, courtsOpen, emptyCourtRate: courtsAvail ? 1 - courtsOpen / courtsAvail : 0, response: reg && sc ? Math.min(1, used / reg) : null });
    }
    const sw = weeks.filter(w => w.scheduled);
    const sum = f => sw.reduce((a, w) => a + w[f], 0);
    return {
      members: Object.values(members).map(m => ({ ...m, avgPerWeek: m.weeks ? m.sessions / m.weeks : 0, attendRate: m.registeredDays ? m.sessions / m.registeredDays : 0 }))
        .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name, 'vi')),
      weeks, days: days.map(x => ({ ...x, fill: x.cap ? x.used / x.cap : null })),
      overall: { weeks: sw.length, reg: sum('reg'), used: sum('used'), cap: sum('cap'),
        response: sum('reg') ? Math.min(1, sum('used') / sum('reg')) : 0,
        emptySeatRate: sum('cap') ? sum('emptySeats') / sum('cap') : 0, emptyCourtRate: sum('courtsAvail') ? 1 - sum('courtsOpen') / sum('courtsAvail') : 0 },
    };
  }

  // Chi tiết MỘT tuần: nhu cầu (đăng ký) và mức đáp ứng (tham gia) theo buổi, theo tổng sân, và theo từng thành viên
  async function statsWeek(key) {
    const w = await weekOf(key), regs = await store.listRegs(key), users = await store.listUsers(), sc = w.schedule;
    const perDay = [];
    for (let d = 0; d < 7; d++) {
      const sess = sc && sc.sessions[d];
      const courts = sess ? sess.courtsAvailable : w.courts[d].length;
      const reg = regs.filter(r => r.days.includes(d)).length, part = sess ? sess.players.length : null;
      if (!courts && !reg && !part) continue;
      const cap = courts * PER_COURT;
      perDay.push({ day: d, courts, cap, reg, part, regPerCourt: courts ? reg / courts : null, partPerCourt: courts && part !== null ? part / courts : null,
        response: reg && part !== null ? Math.min(1, part / reg) : null, free: part !== null ? Math.max(0, cap - part) : null, short: part !== null ? Math.max(0, reg - part) : null,
        times: [...new Set(w.courts[d].map(c => c.time).filter(Boolean))] });
    }
    const reg = perDay.reduce((a, x) => a + x.reg, 0), part = sc ? perDay.reduce((a, x) => a + (x.part || 0), 0) : null;
    const courts = perDay.reduce((a, x) => a + x.courts, 0), cap = courts * PER_COURT;
    const names = new Set([...users.map(u => u.name), ...regs.map(r => r.name), ...Object.keys(sc ? sc.perMember : {})]);
    const gotDays = n => sc ? Object.entries(sc.sessions).filter(([, x]) => x.players.includes(n)).map(([k]) => Number(k)).sort((a, b) => a - b) : null;
    const members = [...names].map(n => {
      const r = regs.find(x => x.name === n), rd = r ? [...r.days].sort((a, b) => a - b) : [], gd = gotDays(n);
      return { name: n, regDays: rd, gotDays: gd, response: gd && rd.length ? Math.min(1, gd.length / rd.length) : null };
    }).sort((a, b) => ((b.gotDays || []).length - (a.gotDays || []).length) || (b.regDays.length - a.regDays.length) || a.name.localeCompare(b.name, 'vi'));
    return { week: key, scheduled: !!sc, perDay, members,
      totals: { people: regs.length, participants: sc ? members.filter(m => m.gotDays.length).length : null, reg, part, courts, cap,
        response: reg && part !== null ? Math.min(1, part / reg) : null, demandVsCap: cap ? reg / cap : null, usage: cap && part !== null ? part / cap : null,
        regPerCourt: courts ? reg / courts : null, partPerCourt: courts && part !== null ? part / courts : null,
        regPerSession: perDay.filter(x => x.courts).length ? reg / perDay.filter(x => x.courts).length : null,
        partPerSession: part !== null && perDay.filter(x => x.courts).length ? part / perDay.filter(x => x.courts).length : null } };
  }

  async function assign(key) {
    const w = await weekOf(key);
    const regs = await store.listRegs(key);
    const res = run({ courts: w.courts, members: regs.map(r => ({ name: r.name, days: r.days, minSessions: r.minSessions, at: r.at })),
      maxPerWeek: MAX_PER_WEEK, perCourt: PER_COURT, maxPerCourt: MAX_PER_COURT, history: await history(key) });
    const schedule = { ...res, createdAt: new Date().toISOString() };
    await store.saveWeek(key, { courts: w.courts, schedule });
    return schedule;
  }

  // Cookie đăng nhập = {tên, hạn}.chữ ký HMAC. Chữ ký gắn với mật khẩu đã mã hóa của người dùng
  // nên đổi/đặt lại mật khẩu hoặc xóa tài khoản là các cookie cũ mất hiệu lực. Mỗi request chỉ tốn 1 truy vấn DB.
  const SECRET = process.env.SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'badminton-local-dev';
  const sign = (p, user) => crypto.createHmac('sha256', SECRET).update(p + '|' + user.hash.slice(0, 16)).digest('base64url');
  async function editSchedule(b, op) {
    const w = await weekOf(b.week);
    if (!w.schedule) throw new Error('Tuần này chưa có lịch phân sân');
    const d = Number(b.day), sess = w.schedule.sessions[d];
    if (!sess) throw new Error('Ngày này không có buổi trong lịch');
    const name = cleanName(b.name);
    if (!name) throw new Error('Thiếu tên');
    if (op === 'add') {
      if (sess.players.includes(name)) throw new Error('Người này đã có trong ngày đó');
      sess.players.push(name);
    } else {
      if (!sess.players.includes(name)) throw new Error('Người này không có trong ngày đó');
      sess.players = sess.players.filter(n => n !== name);
    }
    sess.courts = layoutCourts(sess.players, sess.courtsAvailable, PER_COURT);
    sess.overflow = sess.players.length > sess.capacity;
    const days = Object.entries(w.schedule.sessions).filter(([, x]) => x.players.includes(name)).map(([k]) => Number(k)).sort((a, c) => a - c);
    w.schedule.perMember[name] = days;
    w.schedule.edited = { at: new Date().toISOString() };
    await store.saveWeek(b.week, { courts: w.courts, schedule: w.schedule });
    return { ok: true, schedule: w.schedule };
  }

  function startSession(ctx, user) {
    const p = Buffer.from(JSON.stringify({ u: user.username, e: Date.now() + SESSION_MS })).toString('base64url');
    ctx.cookie = { value: p + '.' + sign(p, user), maxAge: SESSION_MS / 1000 };
  }
  async function userFromToken(token) {
    const [p, sig] = String(token).split('.');
    if (!p || !sig) return null;
    let d; try { d = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
    if (!d.u || !(d.e > Date.now())) return null;
    const x = await store.getUser(d.u);
    if (!x || x.status === 'pending') return null;
    const a = Buffer.from(sign(p, x)), c = Buffer.from(sig);
    return a.length === c.length && crypto.timingSafeEqual(a, c) ? x : null;
  }
  const adminCount = async () => (await store.listUsers()).filter(u => u.role === 'admin').length;

  // auth: 'none' | 'user' | 'admin'
  const routes = {
    'GET /api/me': { auth: 'none', fn: async (q, b, u) => ({ user: publicUser(u), firstUser: (await store.countUsers()) === 0, clubStart: CLUB_START }) },

    // Không mở đăng ký: tài khoản do quản trị viên cấp. Chỉ khi hệ thống chưa có ai thì cho tạo quản trị viên đầu tiên.
    'POST /api/signup': { auth: 'none', fn: async (q, b, u, ctx) => {
      if ((await store.countUsers()) > 0) throw new HttpError(403, 'Không mở đăng ký. Tài khoản do quản trị viên cấp.');
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
      startSession(ctx, user);
      return { user: publicUser(user), clubStart: CLUB_START };
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
      await store.delFail(key); startSession(ctx, x);
      return { user: publicUser(x), clubStart: CLUB_START };
    } },

    'POST /api/logout': { auth: 'none', fn: async (q, b, u, ctx) => {
      ctx.cookie = { value: '', maxAge: 0 }; return { ok: true };
    } },

    'POST /api/password': { auth: 'user', fn: async (q, b, u, ctx) => {
      if (hashPw(String(b.old || ''), u.salt) !== u.hash) throw new Error('Mật khẩu cũ không đúng');
      if (String(b.password || '').length < 6) throw new Error('Mật khẩu mới tối thiểu 6 ký tự');
      if (String(b.password) === u.username) throw new Error('Không dùng tên đăng nhập làm mật khẩu');
      const salt = crypto.randomBytes(16).toString('hex');
      const nu = { ...u, salt, hash: hashPw(String(b.password), salt) };
      await store.putUser(nu); startSession(ctx, nu); return { ok: true };
    } },

    // pre: bắt đầu tải dữ liệu NGAY, song song với bước kiểm tra đăng nhập
    // Tự đổi tên đăng nhập (phải nhập đúng mật khẩu hiện tại). Cookie đăng nhập được cấp lại theo tên mới.
    'POST /api/username': { auth: 'user', fn: async (q, b, u, ctx) => {
      if (hashPw(String(b.password || ''), u.salt) !== u.hash) throw new Error('Mật khẩu hiện tại không đúng');
      const nu = String(b.username || '').trim().toLowerCase();
      if (!/^[a-z0-9_.-]{3,30}$/.test(nu)) throw new Error('Tên đăng nhập 3–30 ký tự: chữ thường không dấu, số, . _ -');
      if (nu === u.username) throw new Error('Đây là tên đăng nhập hiện tại của bạn');
      if (await store.getUser(nu)) throw new Error('Tên đăng nhập đã có người dùng');
      await store.renameUser(u.username, nu);
      startSession(ctx, { ...u, username: nu });
      return { ok: true, user: publicUser({ ...u, username: nu }) };
    } },

    'GET /api/state': { auth: 'user',
      pre: q => Promise.all([store.getWeek(q.week), store.listRegs(q.week), defaultCourts(), store.listUsers()]),
      fn: async (q, b, u, ctx, pre) => {
        const [wk, all, , users] = await pre;
        const w = await weekOf(q.week, wk);
        const counts = Array.from({ length: 7 }, (_, d) => all.filter(r => r.days.includes(d)).length);
        const vis = u.role === 'admin' ? all : all.filter(r => r.name === u.name);
        return { settings: await settings(), key: q.week, counts,
          pending: u.role === 'admin' ? users.filter(x => x.status === 'pending').length : 0,
          registered: all.map(r => ({ name: r.name, days: r.days, at: r.at })).sort((a, b) => String(a.at).localeCompare(String(b.at))),
          week: { courts: w.courts, schedule: u.role === 'admin' ? w.schedule : publicSchedule(w.schedule), registrations: Object.fromEntries(vis.map(r => [r.name, r])) } };
      } },

    // Đăng ký 1 tuần, hoặc kèm "weeks": áp dụng cùng các ngày đó cho nhiều tuần khác (mỗi tuần là ngày Thứ Hai)
    'PUT /api/register': { auth: 'user', fn: async (q, b, u) => {
      const admin = u.role === 'admin';
      const name = admin ? cleanName(b.name) : u.name;
      if (!name) throw new Error('Thiếu tên');
      const days = [...new Set((b.days || []).map(Number).filter(d => d >= 0 && d < 7))];
      if (!days.length) throw new Error('Chọn ít nhất 1 ngày');
      const weeks = [...new Set([b.week, ...(Array.isArray(b.weeks) ? b.weeks : [])])];
      if (weeks.length > 30) throw new Error('Chỉ đăng ký tối đa 30 tuần một lần');
      for (const w of weeks) {
        if (!validKey(w) || new Date(w + 'T12:00').getDay() !== 1) throw new Error('Tuần không hợp lệ: ' + w);
        if (!admin && w < CLUB_START) throw new Error('CLB bắt đầu từ tuần ' + viDate(CLUB_START) + ', chưa nhận đăng ký các tuần trước đó.');
      }
      await Promise.all(weeks.map(async w => {
        const old = await store.getReg(w, name);
        if (!admin && old && old.username && old.username !== u.username) throw new HttpError(403, 'Không có quyền');
        const minSessions = admin ? (b.minSessions === 1 ? 1 : 2) : (old ? old.minSessions : 2);
        const username = admin ? (name === u.name ? u.username : old?.username) : u.username;
        const { dayTimes, at } = stampDays(old, days, new Date().toISOString());
        await store.putReg(w, { name, days, minSessions, username: username || null, at, dayTimes });
      }));
      return { ok: true, weeks: weeks.length };
    } },

    // Các tuần người này đã đăng ký (để hiện trạng thái khi chọn nhiều tuần)
    'GET /api/my-weeks': { auth: 'user', fn: async (q, b, u) => {
      const name = u.role === 'admin' && q.name ? cleanName(q.name) : u.name;
      const out = {};
      for (const r of await store.listAllRegs()) if (r.name === name) out[r.week] = r.days;
      return out;
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
      if (b.setDefault) { await store.setDefaultCourts(c); dcache = c; dcacheAt = Date.now(); }
      return { ok: true };
    } },
    // Xóa toàn bộ đăng ký và lịch đã phân của MỘT tuần (dùng khi chạy thử). Cấu hình sân của tuần được giữ nguyên.
    'DELETE /api/week': { auth: 'admin', fn: async (q, b) => {
      await store.clearWeek(b.week); return { ok: true };
    } },
    // Quản trị viên chỉnh tay lịch đã phân: thêm / bớt một người ở một ngày
    'POST /api/schedule/add': { auth: 'admin', fn: async (q, b) => editSchedule(b, 'add') },
    'POST /api/schedule/remove': { auth: 'admin', fn: async (q, b) => editSchedule(b, 'remove') },
    'POST /api/assign': { auth: 'admin', fn: (q, b) => assign(b.week) },
    'GET /api/stats': { auth: 'admin', fn: () => stats() },
    'GET /api/stats/week': { auth: 'admin', fn: (q) => statsWeek(q.week) },

    'GET /api/users': { auth: 'admin', fn: async () => (await store.listUsers()).map(x => ({ username: x.username, name: x.name, role: x.role, status: x.status || 'active', createdAt: x.createdAt })) },
    // Quản trị viên tạo tài khoản (1 hoặc nhiều), đã duyệt sẵn. Mật khẩu để trống = giống tên đăng nhập.
    'POST /api/users': { auth: 'admin', fn: async (q, b) => {
      const list = Array.isArray(b.users) ? b.users : [b];
      if (!list.length || list.length > 200) throw new Error('Danh sách phải từ 1 đến 200 tài khoản');
      const users = await store.listUsers();
      const taken = new Set(users.map(x => x.username)), names = new Set(users.map(x => x.name.toLowerCase()));
      const created = [], errors = [];
      for (const it of list) {
        const username = String(it.username || '').trim().toLowerCase();
        const name = cleanName(it.name), pw = String(it.password || '') || username;
        try {
          if (!/^[a-z0-9_.-]{3,30}$/.test(username)) throw new Error('tên đăng nhập 3–30 ký tự: chữ thường không dấu, số, . _ -');
          if (!name) throw new Error('thiếu họ tên');
          if (pw.length < 6) throw new Error('mật khẩu tối thiểu 6 ký tự');
          if (taken.has(username)) throw new Error('tên đăng nhập đã tồn tại');
          if (names.has(name.toLowerCase())) throw new Error('họ tên đã có người dùng');
          const salt = crypto.randomBytes(16).toString('hex');
          await store.putUser({ username, name, salt, hash: hashPw(pw, salt), role: it.role === 'admin' ? 'admin' : 'member', status: 'active', createdAt: new Date().toISOString() });
          taken.add(username); names.add(name.toLowerCase()); created.push(username);
        } catch (e) { errors.push({ username: username || '(trống)', name, error: e.message }); }
      }
      return { created, errors };
    } },
    // Quản trị viên sửa họ tên hiển thị: cập nhật luôn các đăng ký và lịch đã phân đang dùng tên cũ
    'PUT /api/users/name': { auth: 'admin', fn: async (q, b) => {
      const x = await store.getUser(b.username); if (!x) throw new Error('Không tìm thấy');
      const nn = cleanName(b.name);
      if (!nn) throw new Error('Nhập họ tên');
      if (nn === x.name) throw new Error('Họ tên không thay đổi');
      const users = await store.listUsers();
      if (users.some(o => o.username !== x.username && o.name.toLowerCase() === nn.toLowerCase())) throw new Error('Họ tên này đã có người dùng');
      if ((await store.listAllRegs()).some(r => r.name === nn)) throw new Error('Họ tên này đã có trong dữ liệu đăng ký của người khác');
      await store.renameRegistrations(x.name, nn);
      await store.putUser({ ...x, name: nn });
      let weeks = 0;
      for (const w of await store.listScheduledWeeks()) {
        if (!renameInSchedule(w.schedule, x.name, nn)) continue;
        const cur = await store.getWeek(w.key);
        await store.saveWeek(w.key, { courts: cur.courts, schedule: w.schedule });
        weeks++;
      }
      return { ok: true, name: nn, weeksUpdated: weeks };
    } },
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
      return { ok: true };
    } },
    'DELETE /api/users': { auth: 'admin', fn: async (q, b) => {
      const x = await store.getUser(b.username); if (!x) throw new Error('Không tìm thấy');
      if (x.role === 'admin' && (await adminCount()) <= 1) throw new Error('Phải còn ít nhất 1 quản trị viên');
      await store.delUser(x.username); return { ok: true };
    } },
  };

  // req: {method, path, query, body, token, ip, contentType}
  async function handle(req) {
    const r = routes[`${req.method} ${req.path}`];
    if (!r) return { status: 404, json: { error: 'Not found' } };
    if (req.method !== 'GET' && !/json/.test(req.contentType || '')) return { status: 415, json: { error: 'Content-Type phải là JSON' } };
    const ctx = { ip: req.ip, token: req.token };
    try {
      const q = req.query || {}, b = req.body || {};
      if ((q.week || b.week) !== undefined && !validKey(q.week || b.week)) throw new Error('Tuần không hợp lệ');
      const userP = req.token ? userFromToken(req.token) : Promise.resolve(null);
      const pre = r.pre ? r.pre(q, b) : null;
      if (pre) pre.catch(() => {}); // nếu bị từ chối quyền thì bỏ kết quả, tránh lỗi treo
      const user = await userP;
      if (r.auth !== 'none' && !user) return { status: 401, json: { error: 'Cần đăng nhập' } };
      if (r.auth === 'admin' && user.role !== 'admin') return { status: 403, json: { error: 'Chỉ quản trị viên' } };
      const json = await r.fn(q, b, user, ctx, pre);
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
const tokenFrom = cookie => (/(?:^|;\s*)sid=([A-Za-z0-9_.-]+)/.exec(cookie || '') || [])[1];
module.exports = { createApp, cookieHeader, tokenFrom };
