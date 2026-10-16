'use strict';
// Server chạy thử ở máy cá nhân: node server.js  (không cần Supabase/Vercel)
const http = require('http'), fs = require('fs'), path = require('path');
const { app } = require('./lib');
const { cookieHeader, tokenFrom } = require('./lib/app');
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    let raw = ''; req.on('data', c => { raw += c; if (raw.length > 1e5) req.destroy(); });
    return req.on('end', async () => {
      let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {}
      const out = await app.handle({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body,
        token: tokenFrom(req.headers.cookie), ip: req.socket.remoteAddress, contentType: req.headers['content-type'] });
      const h = { 'Content-Type': 'application/json' };
      if (out.cookie) h['Set-Cookie'] = cookieHeader(out.cookie, false);
      res.writeHead(out.status, h); res.end(JSON.stringify(out.json));
    });
  }
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
    res.writeHead(e ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(e ? 'err' : d);
  });
}).listen(PORT, () => console.log(`Badminton scheduler: http://localhost:${PORT}`));
