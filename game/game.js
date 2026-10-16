// 広島県市町ゲーム: drop municipality pieces into a box; neighbours stick together; join all 30 into Hiroshima.
'use strict';
(() => {
const { Engine, Body, Composite, Events, Vertices, Bounds, Collision, Bodies } = Matter;
const D = window.PREF_DATA;
const N = D.munis.length;

// ===================================================================================================
// Tuning
// ===================================================================================================
const BW = 300, BH = 420;               // inner box size in world units
const MARGIN = 10, TOP = 150;           // side margin; drop zone above the rim
const W = BW + MARGIN * 2, H = TOP + BH + 12;
const BOX_L = MARGIN, BOX_R = MARGIN + BW, RIM_Y = TOP, FLOOR_Y = TOP + BH;
const LINE_Y = RIM_Y + 36;              // red dashed warning line; the rim itself is the limit
const WALL_T = 200;

const SIZE_REF_SIDE = 0.08925;          // the smallest piece (府中町) gets this square-equivalent side, in box widths
const SIZE_EXP = 0.27;                  // side ~ area^0.27 (庄原 is 120x 府中町 in area, ~3.6x in side)
const MERGED_MAX = 0.9;                 // a group never gets wider or taller than this share of the box width

const STEP_MS = 1000 / 120;             // fixed physics step (two per 60 fps frame)
const GRAVITY = 1.3;
const MAX_SPEED = 16, MAX_SPIN = 0.3;
const DROP_WAIT = 600;                  // ms before the next piece can be dropped
const FRESH_MS = 1500;                  // a dropped piece is exempt from the overflow check this long
const OVER_MS = 1000;                   // something must stay above the rim this long to end the game
const TIME_LIMIT_MS = 20000;            // after the last piece is dropped: finish Hiroshima within this
const FINALE_MS = 3200;
const SHAKE_MS = 1100, SHAKE_GRACE = SHAKE_MS + 1750;
const SHAKE_AMP = 0.04 * BW, SHAKE_CYCLES = 3;
const KICK_MIN = 4.4, KICK_MAX = 8.6, KICK_SIDE = 2.75, KICK_SPIN = 0.085; // upward kick (units per step), heavy .. light
const KICKS = [[0, 1], [420, 0.65]];                                       // [ms after the shake starts, power]
const FLOAT_MS = 500, FLOAT_GRAVITY = 0.75;                                // gravity is eased this long so pieces can rearrange
const PLACE_R = 0.15 * BW, PLACE_STEP = 3, PLACE_TOL = 1;
const START_POOL = 4;                   // a round starts with one of the N smallest pieces
const PICK_POOL = 3;                    // each next piece: one of the N smallest pieces bordering what was dropped
const RANDOM_PICK = 0.2;                // ... except this often, when it is any piece still to come
const LABEL_MIN_PX = 9.5;

const PTS_MERGE = 10, PTS_REGION = 100, PTS_CITY = 200, PTS_DONE = 1000;
const HASHTAG = '広島県市町ゲーム';

const COLORS = { hiro: '#f3c9c1', west: '#f2deaa', kure: '#bfe0d6', chuo: '#d6cdee', bisan: '#f5d3ae', fuku: '#c8dcf0', bihoku: '#d3e7bd' };
const C_INK = '#22343c', C_BOX = '#5f88a0', C_OUTLINE = 'rgba(34,52,60,.55)', C_INNER = 'rgba(34,52,60,.22)';
const C_GOLD = '#f1c54b', C_WARN = '#d0503f';

// ===================================================================================================
// Static data derived from PREF_DATA
// ===================================================================================================
const ADJ = Array.from({ length: N }, () => new Set());
for (const [a, b] of D.adj) { ADJ[a].add(b); ADJ[b].add(a); }
const A_MIN = Math.min(...D.munis.map(m => m.area));
const CITY = D.munis.map((m, i) => i).filter(i => /区$/.test(D.munis[i].name)); // the eight wards of Hiroshima city
const SETS = [{ name: '広島市', members: CITY, pts: PTS_CITY }].concat(D.regions.map(r => ({ name: r.name, members: r.members, pts: PTS_REGION })));
for (const m of D.munis) {
  m.color = COLORS[D.regions[m.region].key];
  // area-weighted centre of all kept parts, and bounds, in km
  let a = 0, cx = 0, cy = 0;
  for (const p of m.parts) { const c = polyCentroid(p.o); a += p.a; cx += c[0] * p.a; cy += c[1] * p.a; }
  m.cx = cx / a; m.cy = cy / a;
}

function polyCentroid(f) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = f.length; i < n; i += 2) {
    const x1 = f[i], y1 = f[i + 1], x2 = f[(i + 2) % n], y2 = f[(i + 3) % n];
    const c = x1 * y2 - x2 * y1; a += c; cx += (x1 + x2) * c; cy += (y1 + y2) * c;
  }
  return [cx / (3 * a), cy / (3 * a)];
}

// A group of municipalities drawn and simulated as one rigid piece, in true geographic layout.
function makeGroup(members) {
  members = members.slice().sort((a, b) => a - b);
  let A = 0, cx = 0, cy = 0, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const i of members) {
    const m = D.munis[i]; A += m.area; cx += m.cx * m.area; cy += m.cy * m.area;
    for (const p of m.parts) for (let j = 0; j < p.o.length; j += 2) {
      x0 = Math.min(x0, p.o[j]); x1 = Math.max(x1, p.o[j]); y0 = Math.min(y0, p.o[j + 1]); y1 = Math.max(y1, p.o[j + 1]);
    }
  }
  cx /= A; cy /= A;
  const side = SIZE_REF_SIDE * BW * Math.pow(A / A_MIN, SIZE_EXP);
  let k = side / Math.sqrt(A);
  k = Math.min(k, MERGED_MAX * BW / Math.max(x1 - x0, y1 - y0));
  return { members, A, cx, cy, k };
}

const OPTS = { friction: 0.35, frictionStatic: 0.6, restitution: 0.02, density: 0.001, frictionAir: 0.005, slop: 0.03 };

// Builds the matter body at angle 0 with the group's centre at the local origin; com0 remembers where the
// centre of mass ended up so drawing can map local geometry onto the body.
function makeBody(g) {
  const parts = [];
  for (const i of g.members) for (const p of D.munis[i].parts) for (const c of p.c) {
    const v = [];
    for (let j = 0; j < c.length; j += 2) v.push({ x: (c[j] - g.cx) * g.k, y: (c[j + 1] - g.cy) * g.k });
    const part = Body.create(Object.assign({ position: Vertices.centre(v), vertices: v }, OPTS));
    part.plugin = { m: i };
    parts.push(part);
  }
  const body = parts.length === 1 ? parts[0] : Body.create(Object.assign({ parts }, OPTS));
  body.plugin = Object.assign(body.plugin || {}, { g, com0: { x: body.position.x, y: body.position.y }, piece: true });
  return body;
}

// local (group) coordinates -> world
function toWorld(body, lx, ly) {
  const c = Math.cos(body.angle), s = Math.sin(body.angle), o = body.plugin.com0;
  const dx = lx - o.x, dy = ly - o.y;
  return { x: body.position.x + c * dx - s * dy, y: body.position.y + s * dx + c * dy };
}

// ===================================================================================================
// Engine and world
// ===================================================================================================
const engine = Engine.create({ gravity: { x: 0, y: GRAVITY }, positionIterations: 10, velocityIterations: 8 });
const world = engine.world;
const wallOpts = { isStatic: true, friction: 0.3, restitution: 0 };
const walls = [
  Bodies.rectangle(BOX_L - WALL_T / 2, FLOOR_Y - 2000 / 2 + WALL_T / 2, WALL_T, 2000 + WALL_T, wallOpts),
  Bodies.rectangle(BOX_R + WALL_T / 2, FLOOR_Y - 2000 / 2 + WALL_T / 2, WALL_T, 2000 + WALL_T, wallOpts),
  Bodies.rectangle(W / 2, FLOOR_Y + WALL_T / 2, BW + WALL_T * 2, WALL_T, wallOpts),
];
Composite.add(world, walls);

const pieces = () => Composite.allBodies(world).filter(b => b.plugin && b.plugin.piece);

// ===================================================================================================
// Game state
// ===================================================================================================
const S = {
  phase: 'title',        // title | play | finale | over
  score: 0, best: 0, round: 1,
  bag: [], dropped: 0,
  current: null, next: null, hoverX: W / 2, readyAt: 0,
  lastDropAt: 0, overSince: 0, shakeAt: -1e9, graceUntil: 0,
  finaleAt: 0, finaleBody: null, awarded: new Set(), droppedSet: new Set(), paused: false,
  toasts: [], now: 0, overReason: '', kickIdx: KICKS.length,
};
try { S.best = +localStorage.getItem('hiroshima-pack-best') || 0; } catch (e) {}

// Order for one round: start small, then always a piece bordering one already given, smaller ones first,
// so the map grows outward from a small seed and the big rural pieces come late.
function makeOrder() {
  const area = i => D.munis[i].area;
  const bySize = [...Array(N).keys()].sort((a, b) => area(a) - area(b));
  const order = [bySize[Math.floor(Math.random() * START_POOL)]];
  const given = new Set(order);
  while (order.length < N) {
    const frontier = new Set();
    for (const i of given) for (const j of ADJ[i]) if (!given.has(j)) frontier.add(j);
    const rest = bySize.filter(i => !given.has(i));
    let pick;
    if (!frontier.size || Math.random() < RANDOM_PICK) pick = rest[Math.floor(Math.random() * rest.length)];
    else {
      const cand = [...frontier].sort((a, b) => area(a) - area(b));
      pick = cand[Math.floor(Math.random() * Math.random() * Math.min(PICK_POOL, cand.length))]; // leans to the smallest
    }
    order.push(pick); given.add(pick);
  }
  return order;
}
function drawFromBag() { return S.bag.length ? S.bag.shift() : null; }

function startRound() {
  S.bag = makeOrder();
  S.dropped = 0; S.lastDropAt = 0; S.awarded = new Set(); S.droppedSet = new Set();
  S.current = drawFromBag(); S.next = drawFromBag();
  S.readyAt = S.now + (S.round > 1 ? 900 : 0);
  if (S.round > 1) toast(`${S.round} 周目`, '');
}

function startGame() {
  for (const b of pieces()) Composite.remove(world, b);
  S.score = 0; S.round = 1; S.overSince = 0; S.toasts = []; S.finaleBody = null;
  S.shakeAt = -1e9; S.graceUntil = 0; S.kickIdx = KICKS.length;
  S.phase = 'play';
  startRound();
  ui.update();
}

function toast(text, sub) { S.toasts.push({ text, sub, at: S.now }); if (S.toasts.length > 3) S.toasts.shift(); }

// --- dropping ---
function hoverGroupCache() {
  if (S.current == null) return null;
  if (!S._hover || S._hover.members[0] !== S.current) S._hover = makeGroup([S.current]);
  return S._hover;
}
function hoverHalfWidth() {
  const g = hoverGroupCache(); if (!g) return 0;
  let x0 = 1e9, x1 = -1e9;
  for (const p of D.munis[S.current].parts) for (let j = 0; j < p.o.length; j += 2) { x0 = Math.min(x0, (p.o[j] - g.cx) * g.k); x1 = Math.max(x1, (p.o[j] - g.cx) * g.k); }
  return { l: -x0, r: x1 };
}
function clampHover(x) {
  const h = hoverHalfWidth(); if (!h) return x;
  return Math.max(BOX_L + h.l + 1, Math.min(BOX_R - h.r - 1, x));
}
function drop() {
  if (S.phase !== 'play' || S.current == null || S.now < S.readyAt) return;
  const g = makeGroup([S.current]);
  const body = makeBody(g);
  const x = clampHover(S.hoverX);
  // place so the group's centre (local origin) sits at the hover point
  Body.setPosition(body, { x: x + body.plugin.com0.x, y: hoverY() + body.plugin.com0.y });
  body.plugin.dropAt = S.now;
  Composite.add(world, body);
  S.dropped++; S.droppedSet.add(S.current);
  S.current = S.next; S.next = drawFromBag(); S._hover = null;
  S.readyAt = S.now + DROP_WAIT;
  if (S.current == null) S.lastDropAt = S.now;
  ui.update();
}
function hoverY() { return RIM_Y - 52; }

// --- merging ---
const pending = [];
function onCollide(e) {
  if (S.phase !== 'play') return;
  for (const pair of e.pairs) {
    const a = pair.bodyA, b = pair.bodyB;
    if (!a.plugin || !b.plugin || a.plugin.m == null || b.plugin.m == null) continue;
    const pa = a.parent, pb = b.parent;
    if (pa === pb || !pa.plugin.piece || !pb.plugin.piece) continue;
    if (ADJ[a.plugin.m].has(b.plugin.m)) pending.push([pa, pb]);
  }
}
Events.on(engine, 'collisionStart', onCollide);
Events.on(engine, 'collisionActive', onCollide);

function processMerges() {
  const gone = new Set();
  while (pending.length) {
    const [a, b] = pending.shift();
    if (gone.has(a) || gone.has(b)) continue;
    const merged = merge(a, b);
    gone.add(a); gone.add(b);
    if (merged && merged.plugin.g.members.length === N) { startFinale(merged); break; }
  }
  pending.length = 0;
}

function merge(a, b) {
  const big = a.plugin.g.A >= b.plugin.g.A ? a : b;
  const bg = big.plugin.g;
  const g = makeGroup(a.plugin.g.members.concat(b.plugin.g.members));
  const body = makeBody(g);
  // keep the bigger piece's geography where it was: its centre stays put and the group takes its angle
  const anchor = toWorld(big, 0, 0);
  const lx = (bg.cx - g.cx) * g.k - body.plugin.com0.x, ly = (bg.cy - g.cy) * g.k - body.plugin.com0.y;
  let angle = big.angle;
  const c = Math.cos(angle), s = Math.sin(angle);
  Composite.remove(world, a); Composite.remove(world, b);
  Body.setPosition(body, { x: anchor.x - (c * lx - s * ly), y: anchor.y - (s * lx + c * ly) });
  Body.setAngle(body, angle);
  if (body.bounds.max.x - body.bounds.min.x > BW - 2) Body.setAngle(body, 0);
  place(body);
  Body.setVelocity(body, { x: big.velocity.x * 0.3, y: Math.min(0, big.velocity.y) * 0.3 });
  body.plugin.dropAt = Math.max(a.plugin.dropAt || 0, b.plugin.dropAt || 0, S.now - FRESH_MS + 400);
  body.plugin.flashAt = S.now;
  Composite.add(world, body);

  const n = g.members.length;
  S.score += PTS_MERGE * n;
  const done = [];
  let pts = 0;
  for (const set of SETS) {
    if (S.awarded.has(set.name)) continue;
    if (set.members.every(i => g.members.includes(i))) { S.awarded.add(set.name); pts += set.pts; done.push(set.name); }
  }
  S.score += pts;
  S.finaleExtra = pts;
  // the finale has its own banner; otherwise one toast for everything this merge completed
  if (done.length && n < N) toast(done.length > 2 ? `${done.slice(0, 2).join('・')} ほか 完成` : `${done.join('・')} 完成`, `+${pts}`);
  ui.update();
  return body;
}

// overlap depth of a body against everything else in the world (walls included)
function maxDepth(body) {
  const own = body.parts.length > 1 ? body.parts.slice(1) : [body];
  let max = 0;
  for (const o of Composite.allBodies(world)) {
    if (o === body || !Bounds.overlaps(o.bounds, body.bounds)) continue;
    const other = o.parts.length > 1 ? o.parts.slice(1) : [o];
    for (const p of own) for (const q of other) {
      if (!Bounds.overlaps(p.bounds, q.bounds)) continue;
      const col = Collision.collides(p, q);
      if (col && col.collided && col.depth > max) max = col.depth;
    }
  }
  return max;
}
function keepInside(body) {
  const b = body.bounds;
  if (b.min.x < BOX_L) Body.translate(body, { x: BOX_L - b.min.x + 0.5, y: 0 });
  else if (b.max.x > BOX_R) Body.translate(body, { x: BOX_R - b.max.x - 0.5, y: 0 });
  if (body.bounds.max.y > FLOOR_Y) Body.translate(body, { x: 0, y: FLOOR_Y - body.bounds.max.y - 0.5 });
}
// Find room for a freshly merged piece: around its spot first, then straight up.
function place(body) {
  keepInside(body);
  const others = Composite.allBodies(world);
  void others;
  if (maxDepth(body) <= PLACE_TOL) return;
  const start = { x: body.position.x, y: body.position.y };
  for (let r = PLACE_STEP; r <= PLACE_R; r += PLACE_STEP) {
    const n = Math.max(8, Math.round(2 * Math.PI * r / PLACE_STEP / 2));
    for (let i = 0; i < n; i++) {
      const t = -Math.PI / 2 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 2 * Math.PI / n; // upward directions first
      Body.setPosition(body, { x: start.x + Math.cos(t) * r, y: start.y + Math.sin(t) * r });
      keepInside(body);
      if (maxDepth(body) <= PLACE_TOL) return;
    }
  }
  Body.setPosition(body, start); keepInside(body);
  for (let i = 0; i < 400 && maxDepth(body) > PLACE_TOL; i++) Body.translate(body, { x: 0, y: -PLACE_STEP });
}

// --- shuffle ---
function shake() {
  if (S.phase !== 'play' || S.paused || S.now - S.shakeAt < SHAKE_MS) return;
  S.shakeAt = S.now; S.graceUntil = S.now + SHAKE_GRACE; S.kickIdx = 0;
  runKicks();
  ui.update();
}
function runKicks() {
  while (S.kickIdx < KICKS.length && S.now - S.shakeAt >= KICKS[S.kickIdx][0]) kick(KICKS[S.kickIdx++][1]);
}
function kick(power) {
  const all = pieces(); if (!all.length) return;
  const masses = all.map(b => b.mass), mMin = Math.min(...masses), mMax = Math.max(...masses);
  for (const b of all) {
    const t = mMax > mMin ? (b.mass - mMin) / (mMax - mMin) : 0.5;
    const up = (KICK_MAX - (KICK_MAX - KICK_MIN) * t) * power;
    Body.setVelocity(b, { x: b.velocity.x + (Math.random() * 2 - 1) * KICK_SIDE * power, y: -up });
    Body.setAngularVelocity(b, b.angularVelocity + (Math.random() * 2 - 1) * KICK_SPIN * power);
  }
}

// --- finale / game over ---
function startFinale(body) {
  S.phase = 'finale'; S.finaleAt = S.now; S.finaleBody = body;
  Body.setStatic(body, true);
  const bonus = PTS_DONE * S.round;
  S.score += bonus;
  S.toasts = [];
  toast('広島県 完成！', `+${bonus + (S.finaleExtra || 0)}`);
  ui.update();
}
function endFinale() {
  for (const b of pieces()) Composite.remove(world, b);
  S.finaleBody = null; S.round++; S.phase = 'play';
  startRound(); ui.update();
}
function gameOver(reason) {
  S.phase = 'over'; S.overReason = reason;
  if (S.score > S.best) { S.best = S.score; try { localStorage.setItem('hiroshima-pack-best', String(S.best)); } catch (e) {} }
  ui.showOver();
}

function biggestGroup() {
  let best = null;
  for (const b of pieces()) if (!best || b.plugin.g.members.length > best.members.length || (b.plugin.g.members.length === best.members.length && b.plugin.g.A > best.A)) best = b.plugin.g;
  return best;
}
function groupName(g) {
  if (!g) return '-';
  if (g.members.length === N) return '広島県';
  if (CITY.every(i => g.members.includes(i)) && g.members.length === CITY.length) return '広島市';
  const top = g.members.slice().sort((a, b) => D.munis[b].area - D.munis[a].area)[0];
  return g.members.length === 1 ? D.munis[top].name : `${D.munis[top].name}ほか`;
}

// ===================================================================================================
// Loop
// ===================================================================================================
let acc = 0, last = 0;
function frame(t) {
  const dt = Math.min(100, last ? t - last : 16.7); last = t;
  tick(dt);
  render();
  requestAnimationFrame(frame);
}
function tick(dt) {
  if (S.paused) { acc = 0; return; }
  if (S.phase === 'play' || S.phase === 'finale') {
    acc = Math.min(acc + dt, STEP_MS * 8);
    const phase = S.phase;
    while (acc >= STEP_MS) {
      S.now += STEP_MS; acc -= STEP_MS;
      if (S.phase === 'play') runKicks();
      engine.gravity.y = GRAVITY * (S.now - S.shakeAt < FLOAT_MS ? FLOAT_GRAVITY : 1);
      Engine.update(engine, STEP_MS);
      clampSpeeds();
      processMerges();
      if (S.phase !== phase) { acc = 0; break; }
    }
    if (S.phase === 'play') checkRules();
    if (S.phase === 'finale' && S.now - S.finaleAt > FINALE_MS) endFinale();
  } else { S.now += dt; acc = 0; }
}
function clampSpeeds() {
  for (const b of pieces()) {
    const v = b.velocity, sp = Math.hypot(v.x, v.y);
    if (sp > MAX_SPEED) Body.setVelocity(b, { x: v.x / sp * MAX_SPEED, y: v.y / sp * MAX_SPEED });
    if (Math.abs(b.angularVelocity) > MAX_SPIN) Body.setAngularVelocity(b, Math.sign(b.angularVelocity) * MAX_SPIN);
  }
}
function checkRules() {
  // overflow: a settled piece reaching above the rim for OVER_MS
  let over = false;
  if (S.now > S.graceUntil) for (const b of pieces()) {
    if (S.now - (b.plugin.dropAt || 0) < FRESH_MS) continue;
    if (b.bounds.min.y < RIM_Y) { over = true; break; }
  }
  if (over) { if (!S.overSince) S.overSince = S.now; else if (S.now - S.overSince > OVER_MS) return gameOver('あふれました'); }
  else S.overSince = 0;
  // time limit after the last piece
  if (S.current == null && S.lastDropAt && S.now - S.lastDropAt > TIME_LIMIT_MS) gameOver('時間切れ');
}

// ===================================================================================================
// Rendering
// ===================================================================================================
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
let scale = 1;
function resize() {
  const stage = document.getElementById('stage');
  const r = stage.getBoundingClientRect();
  scale = Math.min(r.width / W, r.height / H);
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = W * scale + 'px'; cv.style.height = H * scale + 'px';
  cv.width = Math.round(W * scale * dpr); cv.height = Math.round(H * scale * dpr);
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
}
window.addEventListener('resize', resize);

function tracePart(o, g, tf) {
  ctx.beginPath();
  for (let j = 0; j < o.length; j += 2) {
    const p = tf((o[j] - g.cx) * g.k, (o[j + 1] - g.cy) * g.k);
    if (j) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
  }
  ctx.closePath();
}
function drawGroup(g, tf, opt = {}) {
  ctx.lineJoin = 'round';
  // fills first, then inner borders, then the outline on top, so seams between members stay thin
  for (const i of g.members) for (const p of D.munis[i].parts) {
    tracePart(p.o, g, tf);
    ctx.fillStyle = opt.gold ? mix(D.munis[i].color, C_GOLD, opt.gold) : D.munis[i].color; ctx.fill();
  }
  ctx.strokeStyle = g.members.length > 1 ? C_INNER : C_OUTLINE; ctx.lineWidth = 0.8;
  for (const i of g.members) for (const p of D.munis[i].parts) { tracePart(p.o, g, tf); ctx.stroke(); }
  if (opt.flash) { ctx.strokeStyle = `rgba(255,255,255,${opt.flash})`; ctx.lineWidth = 3; for (const i of g.members) for (const p of D.munis[i].parts) { tracePart(p.o, g, tf); ctx.stroke(); } }
  // labels
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const i of g.members) {
    const m = D.munis[i];
    const want = Math.min(12, Math.sqrt(m.mainArea) * g.k * 0.2), min = LABEL_MIN_PX / scale;
    // inside a merged piece, names too small to read are left out instead of being blown up over their neighbours
    if (want < min && g.members.length > 1) continue;
    const size = Math.max(min, want);
    const p = tf((m.label[0] - g.cx) * g.k, (m.label[1] - g.cy) * g.k);
    ctx.font = `700 ${size}px "Zen Kaku Gothic New", "Hiragino Sans", "Yu Gothic", sans-serif`;
    ctx.lineWidth = 2.4; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.strokeText(m.name, p.x, p.y);
    ctx.fillStyle = C_INK; ctx.fillText(m.name, p.x, p.y);
  }
}
function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = s => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

function render() {
  ctx.clearRect(0, 0, W, H);
  // shake offset (visual)
  let sx = 0;
  const st = S.now - S.shakeAt;
  if (st < SHAKE_MS) sx = Math.sin(st / SHAKE_MS * SHAKE_CYCLES * 2 * Math.PI) * SHAKE_AMP * (1 - st / SHAKE_MS);
  ctx.save(); ctx.translate(sx, 0);
  // box
  ctx.fillStyle = '#fbfcfb'; ctx.fillRect(BOX_L, RIM_Y, BW, BH);
  ctx.setLineDash([4, 3]); ctx.strokeStyle = 'rgba(208,80,63,.6)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(BOX_L, LINE_Y); ctx.lineTo(BOX_R, LINE_Y); ctx.stroke(); ctx.setLineDash([]);
  // drop guide
  if (S.phase === 'play' && S.current != null) {
    const x = clampHover(S.hoverX);
    ctx.strokeStyle = 'rgba(34,52,60,.15)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, RIM_Y); ctx.lineTo(x, FLOOR_Y); ctx.stroke();
  }
  // pieces
  for (const b of pieces()) {
    const g = b.plugin.g;
    const fl = b.plugin.flashAt ? Math.max(0, 1 - (S.now - b.plugin.flashAt) / 400) : 0;
    let gold = 0;
    if (b === S.finaleBody) gold = Math.min(1, (S.now - S.finaleAt) / 1200) * 0.55;
    drawGroup(g, (x, y) => toWorld(b, x, y), { flash: fl, gold });
  }
  // walls
  ctx.strokeStyle = C_BOX; ctx.lineWidth = 6; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(BOX_L - 3, RIM_Y - 3); ctx.lineTo(BOX_L - 3, FLOOR_Y + 3); ctx.lineTo(BOX_R + 3, FLOOR_Y + 3); ctx.lineTo(BOX_R + 3, RIM_Y - 3); ctx.stroke();
  if (S.overSince) { ctx.fillStyle = `rgba(208,80,63,${0.12 + 0.1 * Math.sin(S.now / 80)})`; ctx.fillRect(BOX_L, RIM_Y - 40, BW, 40); }
  ctx.restore();

  // hovering piece
  if (S.phase === 'play' && S.current != null) {
    const g = hoverGroupCache();
    const x = clampHover(S.hoverX), y = hoverY();
    ctx.globalAlpha = S.now < S.readyAt ? 0.45 : 1;
    drawGroup(g, (lx, ly) => ({ x: x + lx, y: y + ly }));
    ctx.globalAlpha = 1;
  }
  drawHud();
  drawToasts();
}

function drawHud() {
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = C_INK;
  ctx.font = '700 22px "Zen Maru Gothic", "Hiragino Maru Gothic ProN", sans-serif';
  ctx.fillText(String(S.score), 12, 30);
  const w = ctx.measureText(String(S.score)).width;
  ctx.font = '700 11px "Zen Kaku Gothic New", sans-serif'; ctx.fillText('点', 14 + w, 30);
  const inBox = pieces().reduce((s, b) => s + b.plugin.g.members.length, 0);
  ctx.font = '700 12px "Zen Kaku Gothic New", sans-serif';
  ctx.fillText(`${inBox} / ${N} 市区町` + (S.round > 1 ? `　${S.round} 周目` : ''), 12, 47);
  const big = biggestGroup();
  ctx.font = '400 11px "Zen Kaku Gothic New", sans-serif'; ctx.fillStyle = '#5f7179';
  ctx.fillText(`最大: ${big ? `${groupName(big)}（${big.members.length}）` : '-'}`, 12, 62);
  // next
  ctx.textAlign = 'center'; ctx.fillStyle = C_INK; ctx.font = '700 10px "Zen Kaku Gothic New", sans-serif';
  ctx.fillText('つぎ', W - 34, 16);
  if (S.next != null) {
    const g = makeGroupCached(S.next);
    const k = Math.min(1, 34 / (Math.sqrt(g.A) * g.k));
    ctx.save(); ctx.translate(W - 34, 44); ctx.scale(k, k);
    drawGroupBare(g);
    ctx.restore();
  } else if (S.phase === 'play' && S.lastDropAt) {
    const left = Math.max(0, TIME_LIMIT_MS - (S.now - S.lastDropAt));
    ctx.fillStyle = left < 5000 ? C_WARN : C_INK; ctx.font = '700 18px "Zen Maru Gothic", sans-serif';
    ctx.fillText((left / 1000).toFixed(1), W - 34, 46);
    ctx.font = '400 9px "Zen Kaku Gothic New", sans-serif'; ctx.fillText('のこり秒', W - 34, 60);
  }
}
const groupCache = new Map();
function makeGroupCached(i) { if (!groupCache.has(i)) groupCache.set(i, makeGroup([i])); return groupCache.get(i); }
function drawGroupBare(g) {
  for (const i of g.members) for (const p of D.munis[i].parts) {
    tracePart(p.o, g, (x, y) => ({ x, y }));
    ctx.fillStyle = D.munis[i].color; ctx.fill(); ctx.strokeStyle = C_OUTLINE; ctx.lineWidth = 0.8; ctx.stroke();
  }
}
function drawToasts() {
  S.toasts = S.toasts.filter(t => S.now - t.at < 1800);
  S.toasts.forEach((t, k) => {
    const age = (S.now - t.at) / 1800;
    const y = RIM_Y + 90 + k * 46 - age * 20;
    ctx.globalAlpha = age < 0.75 ? 1 : (1 - age) * 4;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 22px "Zen Maru Gothic", "Hiragino Maru Gothic ProN", sans-serif';
    ctx.lineWidth = 5; ctx.strokeStyle = '#fff'; ctx.strokeText(t.text, W / 2, y); ctx.fillStyle = C_INK; ctx.fillText(t.text, W / 2, y);
    if (t.sub) { ctx.font = '700 13px "Zen Kaku Gothic New", sans-serif'; ctx.strokeText(t.sub, W / 2, y + 20); ctx.fillStyle = '#2f6f8f'; ctx.fillText(t.sub, W / 2, y + 20); }
    ctx.globalAlpha = 1;
  });
}

// ===================================================================================================
// Input and UI
// ===================================================================================================
function worldX(e) { const r = cv.getBoundingClientRect(); return (e.clientX - r.left) / scale; }
let pointerDown = false;
cv.addEventListener('pointerdown', e => { if (S.phase !== 'play') return; pointerDown = true; S.hoverX = worldX(e); cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', e => { if (S.phase !== 'play') return; if (e.pointerType === 'mouse' || pointerDown) S.hoverX = worldX(e); });
cv.addEventListener('pointerup', e => { if (!pointerDown) return; pointerDown = false; S.hoverX = worldX(e); drop(); });
cv.addEventListener('pointercancel', () => { pointerDown = false; });
window.addEventListener('keydown', e => {
  if (S.phase !== 'play') return;
  if (e.key === 'ArrowLeft') S.hoverX = clampHover(S.hoverX) - 6;
  else if (e.key === 'ArrowRight') S.hoverX = clampHover(S.hoverX) + 6;
  else if (e.key === ' ' || e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); drop(); }
  else if (e.key === 's' || e.key === 'S') shake();
});
window.addEventListener('keydown', e => {
  if (e.key === 'm' || e.key === 'M') { $('map').hidden ? openMap() : closeMap(); }
  else if (e.key === 'Escape' && !$('map').hidden) closeMap();
});

// ===================================================================================================
// Whole-prefecture map (for players who do not know where things are). Pauses the game while open.
// ===================================================================================================
const SEA_BG = '#dfe9ec', C_NOW = '#2f6f8f';
const INSET = ['中区', '東区', '南区', '西区', '府中町', '海田町', '坂町'].map(n => D.munis.findIndex(m => m.name === n));
function boundsOf(ids, pad) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const i of ids) for (const p of D.munis[i].parts) for (let j = 0; j < p.o.length; j += 2) {
    x0 = Math.min(x0, p.o[j]); x1 = Math.max(x1, p.o[j]); y0 = Math.min(y0, p.o[j + 1]); y1 = Math.max(y1, p.o[j + 1]);
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}
const MAP_ALL = boundsOf([...Array(N).keys()], 2);
const MAP_INSET = (() => { // widen the close-up to a short strip so the whole card fits on a phone
  const b = boundsOf(INSET, 1), w = b.x1 - b.x0, h = b.y1 - b.y0, want = h / 0.6;
  if (w < want) { b.x0 -= (want - w) / 2; b.x1 += (want - w) / 2; }
  return b;
})();

function drawMapTo(canvas, bb, frame) {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = cw * (bb.y1 - bb.y0) / (bb.x1 - bb.x0);
  canvas.style.height = ch + 'px';
  canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const f = cw / (bb.x1 - bb.x0);
  const P = (x, y) => [(x - bb.x0) * f, (y - bb.y0) * f];
  c.fillStyle = SEA_BG; c.fillRect(0, 0, cw, ch);
  const status = i => i === S.current ? 'now' : i === S.next ? 'next' : S.droppedSet.has(i) ? 'done' : 'todo';
  const playing = S.phase === 'play' || S.phase === 'finale';
  c.lineJoin = 'round';
  for (let i = 0; i < N; i++) {
    const m = D.munis[i], st = playing ? status(i) : 'done';
    for (const p of m.parts) {
      c.beginPath();
      for (let j = 0; j < p.o.length; j += 2) { const [x, y] = P(p.o[j], p.o[j + 1]); j ? c.lineTo(x, y) : c.moveTo(x, y); }
      c.closePath();
      c.fillStyle = st === 'now' ? C_NOW : st === 'todo' ? mix(m.color, '#ffffff', 0.6) : m.color;
      c.fill(); c.strokeStyle = C_OUTLINE; c.lineWidth = 0.8; c.setLineDash([]); c.stroke();
      if (st === 'next') { c.strokeStyle = C_INK; c.lineWidth = 2; c.setLineDash([4, 3]); c.stroke(); c.setLineDash([]); }
    }
  }
  if (frame) { // where the close-up sits
    const [x0, y0] = P(frame.x0, frame.y0), [x1, y1] = P(frame.x1, frame.y1);
    c.strokeStyle = C_INK; c.lineWidth = 1.2; c.setLineDash([3, 2]); c.strokeRect(x0, y0, x1 - x0, y1 - y0); c.setLineDash([]);
  }
  c.textAlign = 'center'; c.textBaseline = 'middle';
  for (let i = 0; i < N; i++) {
    const m = D.munis[i];
    let [x, y] = P(m.label[0], m.label[1]);
    if (x < 0 || y < 0 || x > cw || y > ch) continue;
    const want = Math.min(13, Math.sqrt(m.mainArea) * f * 0.24), size = Math.max(8, want);
    if (frame) { // small names around the close-up are left to the close-up
      const lx = m.label[0], ly = m.label[1], pad = 8;
      const near = lx > frame.x0 - pad && lx < frame.x1 + pad && ly > frame.y0 - pad && ly < frame.y1 + pad;
      if (INSET.includes(i) || (near && want < 8)) continue;
    }
    const st = playing ? status(i) : 'done';
    c.font = `700 ${size}px "Zen Kaku Gothic New", "Hiragino Sans", "Yu Gothic", sans-serif`;
    const tw = c.measureText(m.name).width / 2 + 2; // keep names that sit near an edge fully on the map
    x = Math.max(tw, Math.min(cw - tw, x)); y = Math.max(size / 2 + 2, Math.min(ch - size / 2 - 2, y));
    c.lineWidth = 2.6; c.strokeStyle = st === 'now' ? C_NOW : 'rgba(255,255,255,.9)'; c.strokeText(m.name, x, y);
    c.fillStyle = st === 'now' ? '#fff' : C_INK; c.fillText(m.name, x, y);
  }
}
function openMap() {
  if (S.phase === 'play') S.paused = true;
  $('map').hidden = false;
  const playing = S.phase === 'play' || S.phase === 'finale';
  $('mapNow').textContent = playing && S.current != null ? D.munis[S.current].name : '-';
  $('mapNext').textContent = playing && S.next != null ? D.munis[S.next].name : '-';
  $('mapStatus').hidden = !playing;
  drawMapTo($('mapMain'), MAP_ALL, MAP_INSET);
  drawMapTo($('mapInset'), MAP_INSET, null);
  $('mapClose').focus();
}
function closeMap() { $('map').hidden = true; S.paused = false; }

const $ = id => document.getElementById(id);
const ui = {
  update() {
    $('shake').disabled = S.phase !== 'play' || S.paused || S.now - S.shakeAt < SHAKE_MS || !pieces().length;
    $('reset').disabled = S.phase === 'title';
  },
  showOver() {
    const big = biggestGroup();
    $('overReason').textContent = S.overReason;
    $('overScore').textContent = S.score;
    $('overBest').textContent = S.best;
    $('overBig').textContent = big ? `${groupName(big)}（${big.members.length} 市区町）` : '-';
    $('overRound').textContent = S.round;
    const text = `${HASHTAG} で ${S.score} 点！（${S.round} 周目・最大 ${big ? groupName(big) + ' ' + big.members.length + ' 市区町' : '-'}）`;
    $('share').href = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(location.href.split('#')[0]) + '&hashtags=' + encodeURIComponent(HASHTAG);
    $('over').hidden = false;
    ui.update();
  },
};
setInterval(() => ui.update(), 200);
$('start').addEventListener('click', () => { $('title').hidden = true; startGame(); });
$('again').addEventListener('click', () => { $('over').hidden = true; startGame(); });
$('reset').addEventListener('click', () => { $('over').hidden = true; $('title').hidden = true; closeMap(); startGame(); });
$('shake').addEventListener('click', shake);
$('mapBtn').addEventListener('click', openMap);
$('mapClose').addEventListener('click', closeMap);
$('map').addEventListener('click', e => { if (e.target === $('map')) closeMap(); });

// title illustration: a few recognisable pieces
(function drawTitleArt() {
  const c = $('titleArt'), x = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
  const cw = c.clientWidth || 240, ch = c.clientHeight || 90;
  c.width = cw * dpr; c.height = ch * dpr; x.setTransform(dpr, 0, 0, dpr, 0, 0);
  const names = ['廿日市市', '中区', '尾道市', '庄原市'];
  const ids = names.map(n => D.munis.findIndex(m => m.name === n));
  const gs = ids.map(i => {
    const g = makeGroup([i]);
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const p of D.munis[i].parts) for (let j = 0; j < p.o.length; j += 2) {
      const X = (p.o[j] - g.cx) * g.k, Y = (p.o[j + 1] - g.cy) * g.k;
      x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
    }
    return Object.assign(g, { x0, x1, y0, y1 });
  });
  const gap = 8, labelH = 14;
  const tot = gs.reduce((s, g) => s + g.x1 - g.x0, 0);
  const f = Math.min((cw - gap * (gs.length + 1)) / tot, (ch - labelH) / Math.max(...gs.map(g => g.y1 - g.y0)));
  let px = gap + (cw - gap * (gs.length + 1) - tot * f) / 2;
  gs.forEach((g, n) => {
    const wv = (g.x1 - g.x0) * f;
    x.save(); x.translate(px - g.x0 * f, (ch - labelH) / 2 - (g.y0 + g.y1) / 2 * f); x.scale(f, f);
    for (const i of g.members) for (const p of D.munis[i].parts) {
      x.beginPath();
      for (let j = 0; j < p.o.length; j += 2) { const X = (p.o[j] - g.cx) * g.k, Y = (p.o[j + 1] - g.cy) * g.k; j ? x.lineTo(X, Y) : x.moveTo(X, Y); }
      x.closePath(); x.fillStyle = D.munis[i].color; x.fill(); x.strokeStyle = C_OUTLINE; x.lineWidth = 0.8 / f * 1.4; x.stroke();
    }
    x.restore();
    x.font = '700 10px "Zen Kaku Gothic New", sans-serif'; x.fillStyle = C_INK; x.textAlign = 'center';
    x.fillText(names[n], px + wv / 2, ch - 4);
    px += wv + 8;
  });
})();

resize();
ui.update();
requestAnimationFrame(frame);
// debug handle for development
window.__game = { S, engine, pieces, makeGroup, makeBody, D, tick, render, drop, shake, biggestGroup, groupName };
})();
