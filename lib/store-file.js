'use strict';
// Lưu trong 1 file JSON — dùng để chạy thử ở máy cá nhân (khi chưa cấu hình Supabase).
const fs = require('fs');

module.exports = function fileStore(FILE) {
  let db = { settings: {}, weeks: {}, users: {}, sessions: {}, fails: {} };
  try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
  const save = () => { fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 1)); fs.renameSync(FILE + '.tmp', FILE); };
  const wk = k => (db.weeks[k] ||= { courts: null, registrations: {}, schedule: null });
  return {
    async getDefaultCourts() { return db.settings.defaultCourts || null; },
    async setDefaultCourts(c) { db.settings.defaultCourts = c; save(); },
    async getWeek(k) { const w = db.weeks[k]; return w ? { courts: w.courts, schedule: w.schedule } : null; },
    async saveWeek(k, { courts, schedule }) { const w = wk(k); w.courts = courts; w.schedule = schedule; save(); },
    async listScheduledWeeks() { return Object.entries(db.weeks).filter(([, w]) => w.schedule).map(([key, w]) => ({ key, schedule: w.schedule })); },
    async listRegs(k) { return Object.values(db.weeks[k]?.registrations || {}); },
    async listAllRegs() { return Object.entries(db.weeks).flatMap(([week, w]) => Object.values(w.registrations).map(r => ({ week, ...r }))); },
    async getReg(k, n) { return db.weeks[k]?.registrations[n] || null; },
    async putReg(k, r) { wk(k).registrations[r.name] = r; save(); },
    async delReg(k, n) { if (db.weeks[k]) { delete db.weeks[k].registrations[n]; save(); } },
    async countUsers() { return Object.keys(db.users).length; },
    async listUsers() { return Object.values(db.users); },
    async getUser(u) { return db.users[u] || null; },
    async putUser(x) { db.users[x.username] = x; save(); },
    async delUser(u) { delete db.users[u]; save(); },
    async renameRegistrations(oldName, newName) {
      for (const w of Object.values(db.weeks)) if (w.registrations[oldName]) { w.registrations[newName] = { ...w.registrations[oldName], name: newName }; delete w.registrations[oldName]; }
      save();
    },
    async renameUser(oldName, newName) {
      db.users[newName] = { ...db.users[oldName], username: newName }; delete db.users[oldName];
      for (const w of Object.values(db.weeks)) for (const r of Object.values(w.registrations)) if (r.username === oldName) r.username = newName;
      save();
    },
    async putSession(h, s) { db.sessions[h] = s; save(); },
    async getSession(h) { return db.sessions[h] || null; },
    async delSession(h) { delete db.sessions[h]; save(); },
    async delSessionsOf(u) { for (const [h, s] of Object.entries(db.sessions)) if (s.username === u) delete db.sessions[h]; save(); },
    async getFail(k) { return db.fails[k] || null; },
    async setFail(k, v) { db.fails[k] = v; },
    async delFail(k) { delete db.fails[k]; },
  };
};
