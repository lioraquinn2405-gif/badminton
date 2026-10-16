'use strict';
const path = require('path');
const { createApp } = require('./app');
// Có SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY -> dùng Supabase; không có -> file JSON (chạy thử local).
function build() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATA_FILE } = process.env;
  const store = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? require('./store-supabase')(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : require('./store-file')(DATA_FILE || path.join(__dirname, '..', 'data.json'));
  return createApp(store);
}
module.exports = { app: build() };
