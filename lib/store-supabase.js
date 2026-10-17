'use strict';
// Lưu trong Supabase (Postgres). Chỉ gọi từ server bằng service-role key.
const { createClient } = require('@supabase/supabase-js');

module.exports = function supabaseStore(url, key) {
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const ok = ({ data, error }) => { if (error) { const e = new Error('Lỗi cơ sở dữ liệu: ' + error.message); e.isInternal = true; throw e; } return data; };
  const user = r => r && { username: r.username, name: r.name, salt: r.salt, hash: r.hash, role: r.role, status: r.status, createdAt: r.created_at };
  const reg = r => r && { name: r.name, days: r.days, minSessions: r.min_sessions, username: r.username, at: r.at };
  return {
    async getDefaultCourts() { return ok(await sb.from('settings').select('default_courts').eq('id', 1).maybeSingle())?.default_courts || null; },
    async setDefaultCourts(c) { ok(await sb.from('settings').upsert({ id: 1, default_courts: c })); },
    async getWeek(k) { return ok(await sb.from('weeks').select('courts,schedule').eq('key', k).maybeSingle()); },
    async saveWeek(k, { courts, schedule }) { ok(await sb.from('weeks').upsert({ key: k, courts, schedule })); },
    async listScheduledWeeks() { return ok(await sb.from('weeks').select('key,schedule').not('schedule', 'is', null)); },
    async listRegs(k) { return ok(await sb.from('registrations').select('*').eq('week_key', k).order('at')).map(reg); },
    async listAllRegs() { return ok(await sb.from('registrations').select('*')).map(r => ({ week: r.week_key, ...reg(r) })); },
    async getReg(k, n) { return reg(ok(await sb.from('registrations').select('*').eq('week_key', k).eq('name', n).maybeSingle())); },
    async putReg(k, r) { ok(await sb.from('registrations').upsert({ week_key: k, name: r.name, username: r.username, days: r.days, min_sessions: r.minSessions, at: r.at })); },
    async delReg(k, n) { ok(await sb.from('registrations').delete().eq('week_key', k).eq('name', n)); },
    async countUsers() { const { count, error } = await sb.from('app_users').select('*', { count: 'exact', head: true }); ok({ error }); return count; },
    async listUsers() { return ok(await sb.from('app_users').select('*')).map(user); },
    async getUser(u) { return user(ok(await sb.from('app_users').select('*').eq('username', u).maybeSingle())); },
    async putUser(x) { ok(await sb.from('app_users').upsert({ username: x.username, name: x.name, salt: x.salt, hash: x.hash, role: x.role, status: x.status, created_at: x.createdAt })); },
    async delUser(u) { ok(await sb.from('app_users').delete().eq('username', u)); },
    async renameRegistrations(oldName, newName) { ok(await sb.from('registrations').update({ name: newName }).eq('name', oldName)); },
    async renameUser(oldName, newName) {
      // Đổi khóa chính tại chỗ (không chèn dòng mới: sẽ vướng ràng buộc duy nhất của họ tên)
      ok(await sb.from('app_users').update({ username: newName }).eq('username', oldName));
      ok(await sb.from('registrations').update({ username: newName }).eq('username', oldName));
    },
    async putSession(h, s) { ok(await sb.from('sessions').insert({ token_hash: h, username: s.username, exp: s.exp })); },
    async getSession(h) { const r = ok(await sb.from('sessions').select('*').eq('token_hash', h).maybeSingle()); return r && { username: r.username, exp: Number(r.exp) }; },
    async delSession(h) { ok(await sb.from('sessions').delete().eq('token_hash', h)); },
    async delSessionsOf(u) { ok(await sb.from('sessions').delete().eq('username', u)); },
    async getFail(k) { const r = ok(await sb.from('login_fails').select('*').eq('key', k).maybeSingle()); return r && { n: r.n, t: Number(r.t) }; },
    async setFail(k, v) { ok(await sb.from('login_fails').upsert({ key: k, n: v.n, t: v.t })); },
    async delFail(k) { ok(await sb.from('login_fails').delete().eq('key', k)); },
  };
};
