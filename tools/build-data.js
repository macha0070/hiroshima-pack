// Builds game/data.js from the MLIT administrative boundaries (N03, via smartnews-smri/japan-topography, s0010).
// Output: municipality outlines in km (equirectangular, y grows south), simplified so that shared borders stay
// shared, plus each outline split into convex pieces for matter.js. Run: node tools/build-data.js
'use strict';
const fs = require('fs');
const path = require('path');
const decomp = require('poly-decomp');

const SRC = path.join(__dirname, '../data/N03-21_34_210101.json');
const OUT = path.join(__dirname, '../game/data.js');

const ISLAND_MIN = 10;   // km2: islands at least this big stay part of their piece (Kurahashi, Innoshima, Miyajima ...)
const TOL = 0.12;        // km: Douglas-Peucker tolerance, applied per shared arc
const CHUNK_MIN = 0.002; // km2: convex slivers smaller than this are dropped from the physics shape (still drawn)

// Seven prefectural areas, used for colours and "area complete" bonuses.
const REGIONS = [
  { key: 'hiro', name: '広島圏域', members: ['中区', '東区', '南区', '西区', '安佐南区', '安佐北区', '安芸区', '佐伯区', '府中町', '海田町', '熊野町', '坂町', '安芸高田市', '安芸太田町', '北広島町'] },
  { key: 'west', name: '広島西圏域', members: ['大竹市', '廿日市市'] },
  { key: 'kure', name: '呉圏域', members: ['呉市', '江田島市'] },
  { key: 'chuo', name: '広島中央圏域', members: ['東広島市', '竹原市', '大崎上島町'] },
  { key: 'bisan', name: '尾三圏域', members: ['三原市', '尾道市', '世羅町'] },
  { key: 'fuku', name: '福山・府中圏域', members: ['福山市', '府中市', '神石高原町'] },
  { key: 'bihoku', name: '備北圏域', members: ['三次市', '庄原市'] },
];
// Pieces with no land border, linked across the sea like Hokkaido-Aomori in the original game.
const SEA = [['江田島市', '呉市'], ['大崎上島町', '竹原市'], ['大崎上島町', '呉市']];

const LON0 = 132.75, LAT_C = 34.6, COS = Math.cos(34.5 * Math.PI / 180), R = 6371;
const proj = ([lon, lat]) => [(lon - LON0) * Math.PI / 180 * R * COS, -(lat - LAT_C) * Math.PI / 180 * R];

function area(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return a / 2; }
function centroid(p) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; const c = x1 * y2 - x2 * y1; a += c; cx += (x1 + x2) * c; cy += (y1 + y2) * c; }
  return [cx / (3 * a), cy / (3 * a)];
}
function dp(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const [x1, y1] = pts[0], [x2, y2] = pts[pts.length - 1];
  const dx = x2 - x1, dy = y2 - y1, n = Math.hypot(dx, dy);
  let best = -1, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = n < 1e-9 ? Math.hypot(pts[i][0] - x1, pts[i][1] - y1) : Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / n;
    if (d > best) { best = d; idx = i; }
  }
  if (best <= tol) return [pts[0], pts[pts.length - 1]];
  return dp(pts.slice(0, idx + 1), tol).slice(0, -1).concat(dp(pts.slice(idx), tol));
}

const geo = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const feats = geo.features.map(f => {
  const p = f.properties;
  const name = p.N03_003 === '広島市' ? p.N03_004 : p.N03_004 || p.N03_003;
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  return { name, code: p.N03_007, rings: polys.map(pp => pp[0].slice(0, -1)) };
}).sort((a, b) => a.code.localeCompare(b.code));

// --- topology: which features own each vertex; junctions split rings into shared arcs ---
const owners = new Map();
const K = v => v[0] + ',' + v[1];
for (const f of feats) for (const r of f.rings) for (const v of r) { const k = K(v); (owners.get(k) || owners.set(k, new Set()).get(k)).add(f.name); }
const sig = v => [...owners.get(K(v))].sort().join('|');

const arcCache = new Map();
function simplifyArc(arc) {
  const keys = arc.map(K), fwd = keys.join(';'), rev = keys.slice().reverse().join(';');
  const reversed = rev < fwd, ck = reversed ? rev : fwd;
  if (!arcCache.has(ck)) {
    const pts = (reversed ? arc.slice().reverse() : arc).map(v => ({ v, p: proj(v) }));
    const kept = dp(pts.map(o => o.p), TOL);
    // map kept projected points back to source vertices so neighbours get identical results
    const out = []; let j = 0;
    for (const o of pts) if (j < kept.length && o.p[0] === kept[j][0] && o.p[1] === kept[j][1]) { out.push(o.v); j++; }
    arcCache.set(ck, out);
  }
  const res = arcCache.get(ck);
  return reversed ? res.slice().reverse() : res;
}
function simplifyRing(ring) {
  const n = ring.length;
  const fixed = [];
  for (let i = 0; i < n; i++) {
    const s = sig(ring[i]);
    if (s !== sig(ring[(i + n - 1) % n]) || s !== sig(ring[(i + 1) % n])) fixed.push(i);
  }
  if (fixed.length < 2) { // a free-standing island: split at the first vertex and the farthest one from it
    const p0 = proj(ring[0]); let far = 0, fd = -1;
    for (let i = 1; i < n; i++) { const p = proj(ring[i]); const d = Math.hypot(p[0] - p0[0], p[1] - p0[1]); if (d > fd) { fd = d; far = i; } }
    fixed.length = 0; fixed.push(0, far);
  }
  const out = [];
  for (let a = 0; a < fixed.length; a++) {
    const i0 = fixed[a], i1 = fixed[(a + 1) % fixed.length];
    const arc = [];
    for (let i = i0; ; i = (i + 1) % n) { arc.push(ring[i]); if (i === i1 && arc.length > 1) break; }
    out.push(...simplifyArc(arc).slice(0, -1));
  }
  return out.map(proj);
}

// --- adjacency from the unsimplified shared edges ---
const segOwners = new Map();
for (const f of feats) for (const r of f.rings) for (let i = 0; i < r.length; i++) {
  const a = K(r[i]), b = K(r[(i + 1) % r.length]); const k = a < b ? a + '|' + b : b + '|' + a;
  (segOwners.get(k) || segOwners.set(k, new Set()).get(k)).add(f.name);
}
const idx = new Map(feats.map((f, i) => [f.name, i]));
const adj = new Set();
for (const s of segOwners.values()) {
  const a = [...s].map(n => idx.get(n)).sort((x, y) => x - y);
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) adj.add(a[i] + ',' + a[j]);
}
for (const [a, b] of SEA) { const x = idx.get(a), y = idx.get(b); adj.add(Math.min(x, y) + ',' + Math.max(x, y)); }

// --- pieces ---
const round = v => Math.round(v * 100) / 100;
const report = [];
const munis = feats.map(f => {
  const rings = f.rings.map(simplifyRing).filter(r => r.length >= 3).map(r => ({ r, a: Math.abs(area(r)) })).sort((x, y) => y.a - x.a);
  const kept = rings.filter((o, i) => i === 0 || o.a >= ISLAND_MIN);
  const parts = kept.map(({ r, a }) => {
    const poly = r.map(p => [round(p[0]), round(p[1])]).filter((p, i, arr) => { const q = arr[(i + arr.length - 1) % arr.length]; return p[0] !== q[0] || p[1] !== q[1]; });
    const work = poly.map(p => p.slice());
    decomp.makeCCW(work);
    decomp.removeCollinearPoints(work, 0.001);
    if (!decomp.isSimple(work)) throw new Error(f.name + ': outline self-intersects after simplification');
    const chunks = decomp.quickDecomp(work).filter(c => c.length >= 3 && Math.abs(area(c)) >= CHUNK_MIN);
    const sum = chunks.reduce((s, c) => s + Math.abs(area(c)), 0);
    if (Math.abs(sum - Math.abs(area(work))) / a > 0.02) throw new Error(f.name + ': convex pieces cover ' + (100 * sum / a).toFixed(1) + '%');
    return { o: poly.flat(), c: chunks.map(c => c.flat()), a: round(a) };
  });
  const main = kept[0].r;
  const total = kept.reduce((s, o) => s + o.a, 0);
  const region = REGIONS.findIndex(g => g.members.includes(f.name));
  if (region < 0) throw new Error('no region for ' + f.name);
  report.push(`${f.name}\t${total.toFixed(1)} km2\t${parts.length} part(s)\t${parts.reduce((s, p) => s + p.c.length, 0)} convex\t${parts.reduce((s, p) => s + p.o.length / 2, 0)} pts`);
  return { name: f.name, region, area: round(total), mainArea: round(kept[0].a), label: centroid(main).map(round), parts };
});

const out = {
  munis,
  adj: [...adj].map(s => s.split(',').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
  regions: REGIONS.map(g => ({ key: g.key, name: g.name, members: g.members.map(n => idx.get(n)) })),
  credit: '出典：「国土数値情報（行政区域データ）」（国土交通省）を加工して作成',
};
fs.writeFileSync(OUT, '// Generated by tools/build-data.js from MLIT N03 administrative boundaries. Do not edit by hand.\n' +
  'window.PREF_DATA = ' + JSON.stringify(out) + ';\n');
console.log(report.join('\n'));
console.log(`\n${munis.length} pieces, ${out.adj.length} links, ${fs.statSync(OUT).size} bytes -> ${OUT}`);
