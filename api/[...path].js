'use strict';
const { app } = require('../lib');
const { cookieHeader, tokenFrom } = require('../lib/app');

module.exports = async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https');
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const out = await app.handle({
    method: req.method, path: u.pathname.replace(/\/+$/, ''), query: Object.fromEntries(u.searchParams), body: body || {},
    token: tokenFrom(req.headers.cookie), ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
    contentType: req.headers['content-type'],
  });
  res.statusCode = out.status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (out.cookie) res.setHeader('Set-Cookie', cookieHeader(out.cookie, secure));
  res.end(JSON.stringify(out.json));
};
