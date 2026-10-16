'use strict';
const path = require('path');
const { createApp } = require('./app');
// Có SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY -> dùng Supabase; không có -> file JSON (chỉ chạy thử local).
// Trên Vercel mà thiếu biến thì báo lỗi rõ ràng, tránh âm thầm chạy bằng bộ nhớ tạm rồi mất dữ liệu.
function build() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATA_FILE, VERCEL } = process.env;
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) return createApp(require('./store-supabase')(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY));
  if (VERCEL) {
    return { handle: async () => ({ status: 500, json: { error: 'Chưa cấu hình SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY trên Vercel' } }) };
  }
  return createApp(require('./store-file')(DATA_FILE || path.join(__dirname, '..', 'data.json')));
}
module.exports = { app: build() };
