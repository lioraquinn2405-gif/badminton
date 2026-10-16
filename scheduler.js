'use strict';
// Thuật toán phân lịch cầu lông (thuần, không phụ thuộc IO).
// Ý tưởng: người đăng ký ít ngày (ít lựa chọn) xếp trước -> người đăng ký nhiều ngày
// xếp chèn vào các ngày còn trống; luôn chọn ngày đang vắng nhất để dàn đều số người.

const PER_COURT = 8;      // mức ưu tiên: 8 người/sân
const MAX_PER_COURT = 10; // chỉ dùng khi quá khó xếp

function run({ courts, members, maxPerWeek = 3, history = {}, perCourt = PER_COURT, maxPerCourt = MAX_PER_COURT }) {
  const D = 7;
  const labels = courts.map(c => Array.isArray(c) ? c : Array(c || 0).fill(''));
  courts = labels.map(l => l.length);
  const cap = courts.map(c => (c || 0) * perCourt);          // sức chứa ưu tiên
  const hard = courts.map(c => (c || 0) * maxPerCourt);      // sức chứa tối đa
  const load = Array(D).fill(0);
  const ratio = d => (cap[d] ? load[d] / cap[d] : Infinity);
  const warnings = [];

  const ms = members.map(m => ({
    name: m.name,
    min: Math.max(1, m.minSessions || 2),
    days: [...new Set(m.days)].filter(d => cap[d] > 0).sort((a, b) => a - b),
    reqDays: [...new Set(m.days)].length,
    got: [],
  }));
  const byName = Object.fromEntries(ms.map(m => [m.name, m]));
  const hist = n => history[n] || 0;

  const has = (m, d) => m.got.includes(d);
  const adj = (m, d) => m.got.some(x => Math.abs(x - d) === 1) ? 1 : 0;
  const add = (m, d) => { m.got.push(d); load[d]++; };

  // Pha 1: đảm bảo số buổi tối thiểu, người ít lựa chọn trước
  const order = [...ms].sort((a, b) =>
    a.days.length - b.days.length || hist(a.name) - hist(b.name) || a.name.localeCompare(b.name));
  for (const m of order) {
    const need = Math.min(m.min, m.days.length);
    if (m.days.length < m.min) {
      warnings.push(`${m.name}: chỉ đăng ký ${m.days.length} ngày hợp lệ, tối thiểu ${m.min} buổi.`);
    }
    for (let i = 0; i < need; i++) {
      const open = m.days.filter(d => !has(m, d));
      let cand = open.filter(d => load[d] < cap[d]);
      if (!cand.length) cand = open.filter(d => load[d] < hard[d]); // hết chỗ ưu tiên -> nới lên 10/sân
      if (!cand.length) { warnings.push(`${m.name}: các ngày đăng ký đã hết chỗ.`); break; }
      cand.sort((a, b) => (ratio(a) + 0.15 * adj(m, a)) - (ratio(b) + 0.15 * adj(m, b)) || a - b);
      add(m, cand[0]);
    }
  }

  // Cải thiện cục bộ: chuyển buổi từ ngày đông sang ngày vắng nếu làm đều hơn
  for (let pass = 0; pass < 30; pass++) {
    let moved = false;
    for (const m of order) {
      for (const a of [...m.got]) {
        for (const b of m.days) {
          if (has(m, b) || load[b] >= hard[b]) continue;
          const before = ratio(a) ** 2 + ratio(b) ** 2;
          const after = ((load[a] - 1) / cap[a]) ** 2 + ((load[b] + 1) / cap[b]) ** 2;
          if (after < before - 1e-9) {
            m.got = m.got.filter(x => x !== a); load[a]--; add(m, b); moved = true; break;
          }
        }
      }
    }
    if (!moved) break;
  }

  // Pha 2: lấp chỗ trống bằng buổi thêm (tới maxPerWeek), ưu tiên ngày vắng nhất,
  // người nhiều buổi ít nhất / đăng ký ít ngày hơn được xét trước
  for (;;) {
    const days = [...Array(D).keys()].filter(d => cap[d] && load[d] < cap[d]).sort((a, b) => ratio(a) - ratio(b) || a - b);
    let done = false;
    for (const d of days) {
      const c = ms.filter(m => m.days.includes(d) && !has(m, d) && m.got.length < maxPerWeek);
      if (!c.length) continue;
      c.sort((a, b) => a.got.length - b.got.length || a.days.length - b.days.length || hist(a.name) - hist(b.name) || a.name.localeCompare(b.name));
      add(c[0], d); done = true; break;
    }
    if (!done) break;
  }

  // Ngày bị nới quá 8/sân: ai đã đủ số buổi tối thiểu ở các ngày khác thì chỉ giữ các ngày đó
  for (let d = 0; d < D; d++) {
    if (load[d] <= cap[d]) continue;
    const out = ms.filter(m => has(m, d) && m.got.length - 1 >= m.min).sort((a, b) => b.got.length - a.got.length);
    for (const m of out) {
      if (load[d] <= cap[d]) break;
      m.got = m.got.filter(x => x !== d); load[d]--;
    }
  }

  // Chia sân: lấp đầy từng sân tới 8 người rồi mới sang sân kế; chỉ khi vượt 8/sân mới dàn đều (tối đa 10)
  const sessions = {};
  for (let d = 0; d < D; d++) {
    if (!cap[d]) continue;
    const names = ms.filter(m => has(m, d)).map(m => m.name);
    const over = names.length > courts[d] * perCourt;
    const layout = Array.from({ length: courts[d] }, () => []);
    if (over) names.forEach((n, i) => layout[i % courts[d]].push(n));
    else names.forEach((n, i) => layout[Math.floor(i / perCourt)].push(n));
    while (layout.length && !layout[layout.length - 1].length) layout.pop();
    sessions[d] = { courtsAvailable: courts[d], capacity: cap[d], hardCapacity: hard[d], overflow: over,
      players: names, courts: layout, courtLabels: labels[d] };
  }
  const perMember = Object.fromEntries(ms.map(m => [m.name, m.got.sort((a, b) => a - b)]));
  return { sessions, perMember, warnings };
}

module.exports = { run, PER_COURT, MAX_PER_COURT };
