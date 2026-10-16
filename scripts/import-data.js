'use strict';
// Chuyển tài khoản + dữ liệu đăng ký/lịch từ data.json (bản chạy local) lên Supabase.
// Chạy: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-data.js
const fs = require('fs'), path = require('path');
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('Thiếu SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const store = require('../lib/store-supabase')(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const src = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
(async () => {
  if (src.settings?.defaultCourts) await store.setDefaultCourts(src.settings.defaultCourts);
  for (const [k, w] of Object.entries(src.weeks || {})) {
    await store.saveWeek(k, { courts: w.courts, schedule: w.schedule || null });
    for (const r of Object.values(w.registrations || {})) await store.putReg(k, { username: null, minSessions: 2, ...r });
    console.log('tuần', k, Object.keys(w.registrations || {}).length, 'đăng ký');
  }
  for (const u of Object.values(src.users || {})) {
    await store.putUser({ status: 'active', ...u });
    console.log('tài khoản', u.username, '(' + u.role + ')');
  }
  console.log('Xong.');
})().catch(e => { console.error(e.message); process.exit(1); });
