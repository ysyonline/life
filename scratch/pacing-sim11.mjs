// T-P6-12 任务 A：P-1′ 参数终稿预核 —— 封顶 × Lv4 阈值 变体矩阵（N=∞ 口径，权威读数源）
//
// 背景：D0 已拍板选 A（授权修验收 bot）。工程侧探针（02 文档 §8.9）显示修 bot 后
//       P-1′ 终版（封顶24 + 60/150 + 迁入5）的 V1 注入铜钱用例仍红（144.2 < 150 @迁入8；
//       迁入5 口径工程侧实测中）。本脚本预核参数变体，等工程侧新 bot 读数回来后合成终稿。
//
// 变体矩阵：封顶 ∈ {24, 26, 28, 30} × Lv4 阈值 ∈ {130, 135, 140, 145, 150}
//           （Lv3 固定 60，迁入固定 5，其余全部现网值）
// 判定标准（03 文档 §5.1）：L*_human ∈ [519, 683]、等级回落 = 0、无单一来源 > 40%
//
// 运行： node scratch/pacing-sim11.mjs            # 全矩阵（约 20 配置 × 搜索）
//        node scratch/pacing-sim11.mjs 24,150     # 只跑指定 封顶,阈值 组合（可逗号并列：24,150;26,140）
//        node scratch/pacing-sim11.mjs diag       # 对指定配置跑 Lv3→Lv4 段稀缺诊断（DIAG_IDS 环境变量）
//
// 纪律：只读 src/config + 内存覆盖，不改任何 src/ 与 tests/ 文件。基线已复现（12/315/515）。
import { createInitialState } from '../src/core/state.js';
import { tick, housingCapacity, computeLevel } from '../src/core/simulation.js';
import { placeBuilding } from '../src/core/grid.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

const S = RULES.mapSize;
const BASE = {
  thresholds: [...RULES.unlockThresholds], money0: RULES.initialMoney, wood0: RULES.initialResources.wood,
  moveIn: RULES.moveInInterval, tax: RULES.tax.perHouseholdPerTick, idle: RULES.prosperityCoef.idle,
  cost: Object.fromEntries(Object.entries(BUILDINGS).map(([k, v]) => [k, { ...v.cost }])),
  score: Object.fromEntries(Object.entries(BUILDINGS).map(([k, v]) => [k, v.score])),
};
function applyOverrides(ov = {}) {
  RULES.unlockThresholds = ov.thresholds ? [...ov.thresholds] : [...BASE.thresholds];
  RULES.initialResources.wood = ov.wood0 ?? BASE.wood0;
  RULES.moveInInterval = ov.moveIn ?? BASE.moveIn;
  RULES.tax.perHouseholdPerTick = ov.tax ?? BASE.tax;
  RULES.prosperityCoef.idle = ov.idle ?? BASE.idle;
  for (const [k, c] of Object.entries(BASE.cost)) {
    BUILDINGS[k].cost.money = c.money; BUILDINGS[k].cost.wood = c.wood;
  }
  for (const [k, s] of Object.entries(BASE.score)) BUILDINGS[k].score = s;
  return ov.money0 ?? BASE.money0;
}
function restore() {
  RULES.unlockThresholds = [...BASE.thresholds];
  RULES.initialResources.wood = BASE.wood0;
  RULES.moveInInterval = BASE.moveIn;
  RULES.tax.perHouseholdPerTick = BASE.tax;
  RULES.prosperityCoef.idle = BASE.idle;
  for (const [k, c] of Object.entries(BASE.cost)) { BUILDINGS[k].cost.money = c.money; BUILDINGS[k].cost.wood = c.wood; }
  for (const [k, s] of Object.entries(BASE.score)) BUILDINGS[k].score = s;
}

// ---- 放置（fast 游标模式；搜索用 fast，最终复核用 exact，与 sim8 同口径）----
let SPOTS = null;
function buildSpotCache(state) {
  const all1 = [], all2 = [], fert2 = [], wood2 = [];
  const T = (x, y) => state.grid.get(`${x},${y}`).terrain;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) all1.push([x, y]);
  for (let y = 0; y <= S - 2; y++) for (let x = 0; x <= S - 2; x++) {
    all2.push([x, y]);
    if (T(x, y) === 'fertile' && T(x + 1, y) === 'fertile' && T(x, y + 1) === 'fertile' && T(x + 1, y + 1) === 'fertile') fert2.push([x, y]);
    if (T(x, y) === 'woodland' && T(x + 1, y) === 'woodland' && T(x + 1, y + 1) === 'woodland' && T(x + 1, y + 1) === 'woodland') wood2.push([x, y]);
  }
  SPOTS = { all1, all2, fert2, wood2 };
}
const CURSOR = {};
function resetCursor() { for (const k of Object.keys(CURSOR)) delete CURSOR[k]; }
// ---- 同类建筑造价递增（N2 候选①预研）：第 n 座造价 = 基础 × (1 + slope × max(0, n - from))----
// n 为该类型当前数量+1（即将建造的第 n 座）；from 为起算座数（前 from 座按原价，保护前期节奏）
let COSTSCALE = null;
function scaledCost(type, state) {
  const base = BASE.cost[type];
  if (!COSTSCALE) return { money: base.money, wood: base.wood };
  const n = countType(state, type) + 1;
  const f = 1 + COSTSCALE.slope * Math.max(0, n - COSTSCALE.from);
  return { money: Math.round(base.money * f), wood: Math.round(base.wood * f) };
}
function withScaledCost(state, type, attempt) {
  const base = BASE.cost[type];
  const sc = scaledCost(type, state);
  BUILDINGS[type].cost.money = sc.money; BUILDINGS[type].cost.wood = sc.wood;
  const ok = attempt();
  BUILDINGS[type].cost.money = base.money; BUILDINGS[type].cost.wood = base.wood;
  return ok;
}
function tryPlaceFast(state, type) {
  const def = BUILDINGS[type];
  const [w, h] = def.size;
  const sc = scaledCost(type, state);
  if (state.money < sc.money || state.resources.wood < sc.wood) return false;
  let list;
  if (def.terrain === 'fertile') list = SPOTS.fert2;
  else if (def.terrain === 'woodland') list = SPOTS.wood2;
  else list = w === 2 || h === 2 ? SPOTS.all2 : SPOTS.all1;
  const n = list.length; let start = CURSOR[type] ?? 0; if (start >= n) start = 0;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n; const [x, y] = list[i];
    let ok = false;
    if (COSTSCALE) ok = withScaledCost(state, type, () => placeBuilding(state, type, x, y).ok);
    else ok = placeBuilding(state, type, x, y).ok;
    if (ok) { CURSOR[type] = i + 1; return true; }
  }
  return false;
}
function tryPlaceExact(state, type) {
  const def = BUILDINGS[type];
  const [w, h] = def.size;
  const sc = scaledCost(type, state);
  if (state.money < sc.money || state.resources.wood < sc.wood) return false;
  for (let y = 0; y <= S - h; y++)
    for (let x = 0; x <= S - w; x++) {
      let ok = false;
      if (COSTSCALE) ok = withScaledCost(state, type, () => placeBuilding(state, type, x, y).ok);
      else ok = placeBuilding(state, type, x, y).ok;
      if (ok) return true;
    }
  return false;
}
let PLACER = tryPlaceFast;
const tryPlace = (s, t) => PLACER(s, t);
const countType = (state, t) => state.buildings.filter((b) => b.type === t).length;

// ---- 验收 bot（与 progression.test.js 逐字一致，仅用于基线复现门槛）----
function verificationBot(state) {
  const lvl = state.level, cap = housingCapacity(state), pop = state.population.count, c = countType;
  const wants = [];
  if (cap - pop < 2) wants.push(lvl >= 3 && state.money > 120 ? 'house' : 'hut');
  if (state.resources.food < 20 && c(state, 'mill') < 6) wants.push('mill');
  if (state.resources.grain < 20 && c(state, 'farm') < 6) wants.push('farm');
  if (state.resources.wood < 20 && c(state, 'forest') < 12) wants.push('forest');
  if (c(state, 'farm') < 2) wants.push('farm');
  if (c(state, 'forest') < 2) wants.push('forest');
  if (c(state, 'mill') < 2) wants.push('mill');
  if (lvl >= 2 && c(state, 'eatery') < 3) wants.push('eatery');
  if (lvl >= 2 && c(state, 'granary') < 1) wants.push('granary');
  if (lvl >= 3 && c(state, 'carpenter') < 2) wants.push('carpenter');
  if (lvl >= 4 && c(state, 'grocer') < 4) wants.push('grocer');
  if (c(state, 'farm') < 4) wants.push('farm');
  if (c(state, 'mill') < 3) wants.push('mill');
  if (c(state, 'forest') < 6) wants.push('forest');
  if (lvl >= 2 && c(state, 'eatery') < 6) wants.push('eatery');
  if (lvl >= 3 && c(state, 'carpenter') < 6) wants.push('carpenter');
  if (lvl >= 4 && c(state, 'grocer') < 8) wants.push('grocer');
  if (cap - pop < 4) wants.push(lvl >= 3 ? 'house' : 'hut');
  for (const t of wants) if (tryPlace(state, t)) return t;
  return null;
}

// ---- 策略 bot（与 sim8 同款：无硬上限，上限由搜索决定，N=∞）----
function makePolicyBot(policy) {
  return function (state) {
    if (state.money < (policy.spendFloor ?? 0)) return null;
    const lvl = state.level, cap = housingCapacity(state), pop = state.population.count;
    const wants = [];
    if (state.resources.wood < 10 && countType(state, 'forest') < (policy.forestCap ?? 12)) wants.push('forest');
    for (const rule of policy.rules) {
      if (rule.type === 'hut') {
        if (cap - pop <= policy.hutBuffer && state.money > (policy.hutGate ?? 0))
          wants.push(lvl >= 3 && policy.useHouse && state.money > policy.houseMoney ? 'house' : 'hut');
      } else if (rule.type === 'house') {
        if (cap - pop <= policy.hutBuffer && lvl >= 3 && countType(state, 'house') < rule.cap) wants.push('house');
      } else if (rule.type === 'farm') { if (countType(state, 'farm') < rule.cap) wants.push('farm'); }
      else if (rule.type === 'forest') { if (countType(state, 'forest') < rule.cap) wants.push('forest'); }
      else if (rule.type === 'mill') { if (countType(state, 'mill') < rule.cap && countType(state, 'mill') <= countType(state, 'farm')) wants.push('mill'); }
      else if (rule.type === 'eatery') { if (lvl >= 2 && countType(state, 'eatery') < rule.cap && state.resources.food > 12) wants.push('eatery'); }
      else if (rule.type === 'granary') { if (lvl >= 2 && countType(state, 'granary') < rule.cap) wants.push('granary'); }
      else if (rule.type === 'carpenter') { if (lvl >= 3 && countType(state, 'carpenter') < rule.cap) wants.push('carpenter'); }
      else if (rule.type === 'grocer') { if (lvl >= 4 && countType(state, 'grocer') < rule.cap) wants.push('grocer'); }
    }
    for (const t of wants) if (tryPlace(state, t)) return t;
    return null;
  };
}

// 恒计分封顶公式（与 sim8 capConstant 逐字同款：农田+林场+粮仓 合计封顶 capN）
function capConstant(capN) {
  return (state) => {
    let working = 0, housingScore = 0, housingCap = 0, constant = 0;
    for (const b of state.buildings) {
      const def = BUILDINGS[b.type];
      if (def.capacity > 0) { housingScore += def.score; housingCap += def.capacity; continue; }
      working += def.score * (b.idle ? RULES.prosperityCoef.idle : RULES.prosperityCoef.active);
      if (['farm', 'forest', 'granary'].includes(b.type)) constant += def.score;
    }
    const occ = housingCap > 0 ? Math.min(1, state.population.count / housingCap) : 0;
    return working - Math.max(0, constant - capN) + housingScore * occ;
  };
}

function playthrough(state, bot, { maxTicks = 6000, N = 1, scoreFormula = null, trace = false } = {}) {
  const levelAt = { 2: null, 3: null, 4: null };
  let moneySpent = 0, buildCount = 0, downgrades = 0, maxLevel = 1;
  const tr = [];
  for (let i = 0; i < maxTicks; i++) {
    const before = state.money;
    let built = 0;
    while (built < N) {
      if (!bot(state)) break;
      built++;
      if (built > 500) break;
    }
    buildCount += built;
    moneySpent += Math.max(0, before - state.money);
    tick(state);
    if (scoreFormula) { state.prosperity = scoreFormula(state); state.level = computeLevel(state.prosperity); }
    for (const lv of [2, 3, 4]) if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level < maxLevel) downgrades++;
    maxLevel = Math.max(maxLevel, state.level);
    if (trace) {
      const cap = housingCapacity(state);
      const idleLabor = state.buildings.filter((b) => b.idle && b.idleReason === 'labor').length;
      const idleMat = state.buildings.filter((b) => b.idle && b.idleReason === 'material').length;
      let dem = 0; for (const b of state.buildings) dem += (BUILDINGS[b.type].workers ?? 0);
      tr.push({ t: state.tick, lv: state.level, pop: state.population.count, cap, vacant: cap - state.population.count,
        dem, idleLabor, idleMat, food: state.resources.food, money: state.money, wood: state.resources.wood });
    }
    if (state.level >= 4) break;
  }
  return {
    levelAt, moneySpent, buildCount, downgrades, trace: tr,
    final: { tick: state.tick, money: +state.money.toFixed(0), pop: state.population.count, cap: housingCapacity(state),
      buildings: state.buildings.length,
      breakdown: Object.fromEntries(Object.keys(BUILDINGS).map((k) => [k, countType(state, k)]).filter(([, v]) => v > 0)),
      prosperity: +state.prosperity.toFixed(1) },
  };
}

function freshState(ov) {
  const m0 = applyOverrides(ov);
  const st = createInitialState();
  if (!SPOTS) buildSpotCache(st);
  st.money = m0;
  return st;
}

// ---- 爬山搜索（与 sim8 同款 RNG 种子与预算：restarts=10 / iters=70，跨配置可比）----
const TYPES = ['farm', 'forest', 'mill', 'eatery', 'granary', 'carpenter', 'grocer', 'house'];
const CAPRANGE = { farm: [2, 40], forest: [2, 30], mill: [2, 40], eatery: [2, 20], granary: [0, 8], carpenter: [0, 14], grocer: [0, 4], house: [0, 12] };
const SEED = { hutBuffer: 0, useHouse: false, houseMoney: 160, forestCap: 5, hutGate: 0, spendFloor: 0,
  rules: [{ type: 'eatery', cap: 3 }, { type: 'mill', cap: 11 }, { type: 'hut', cap: 999 },
    { type: 'granary', cap: 1 }, { type: 'house', cap: 0 }, { type: 'carpenter', cap: 4 },
    { type: 'forest', cap: 8 }, { type: 'grocer', cap: 3 }, { type: 'farm', cap: 13 }] };
function search(ov, { restarts = 10, iters = 70, N = Infinity, maxTicks = 2000, seedPolicy = SEED, scoreFormula = null } = {}) {
  const rnd = (() => { let s = 20261017 + (process.env.SEED_OFF ? +process.env.SEED_OFF : 0); return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const randomPolicy = () => {
    const order = []; const pool = [...TYPES];
    while (pool.length) order.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    const rules = order.map((t) => ({ type: t, cap: ri(...CAPRANGE[t]) }));
    rules.splice(Math.floor(rnd() * (rules.length + 1)), 0, { type: 'hut', cap: 999 });
    return { hutBuffer: ri(0, 3), useHouse: rnd() < 0.5, houseMoney: pick([80, 100, 120, 160]), forestCap: ri(4, 20), hutGate: pick([0, 0, 30, 50, 70]), spendFloor: pick([0, 0, 20, 40, 60, 80]), rules };
  };
  const mutate = (p) => {
    const q = JSON.parse(JSON.stringify(p)); const k = ri(0, 5);
    if (k === 0) q.hutBuffer = Math.max(0, Math.min(3, q.hutBuffer + pick([-1, 1])));
    else if (k === 1) q.useHouse = !q.useHouse;
    else if (k === 2) { const r = q.rules[ri(0, q.rules.length - 1)]; if (r.type !== 'hut') r.cap = Math.max(0, Math.min(40, r.cap + pick([-3, -1, 1, 3]))); }
    else if (k === 3) { const i = ri(0, q.rules.length - 1), j = ri(0, q.rules.length - 1); [q.rules[i], q.rules[j]] = [q.rules[j], q.rules[i]]; }
    else if (k === 4) { const i = ri(0, q.rules.length - 1); if (q.rules[i].type !== 'hut') q.rules[i].type = pick(TYPES); }
    else { q.hutGate = pick([0, 0, 30, 50, 70]); q.forestCap = Math.max(4, Math.min(24, q.forestCap + pick([-2, 2]))); q.spendFloor = pick([0, 0, 20, 40, 60, 80]); }
    return q;
  };
  const evaluate = (p) => {
    const st = freshState(ov); resetCursor();
    const r = playthrough(st, makePolicyBot(p), { maxTicks, N, scoreFormula });
    restore();
    return r;
  };
  const sc = (r) => (r.levelAt[4] ?? 99999);
  let best = null, bestR = null;
  for (let rs = 0; rs < restarts; rs++) {
    let cur = rs === 0 && seedPolicy ? seedPolicy : randomPolicy();
    let curR = evaluate(cur);
    for (let it = 0; it < iters; it++) {
      const cand = mutate(cur); const candR = evaluate(cand);
      if (sc(candR) < sc(curR)) { cur = cand; curR = candR; }
    }
    if (!bestR || sc(curR) < sc(bestR)) { best = cur; bestR = curR; }
  }
  PLACER = tryPlaceExact;
  const stF = freshState(ov);
  const finalR = playthrough(stF, makePolicyBot(best), { maxTicks: 8000, N, scoreFormula, trace: true });
  restore();
  PLACER = tryPlaceFast;
  if (process.env.PRINT_POLICY) console.log('POLICY ' + JSON.stringify(best));
  return { policy: best, result: finalR };
}

// ---- 判定与汇总 ----
const BAND = [519, 683];
function judge(r, cap) {
  const L4 = r.levelAt[4];
  const inBand = L4 != null && L4 >= BAND[0] && L4 <= BAND[1];
  // 终局单一来源占比：按各来源对终局繁荣度总分的贡献（含封顶后的恒计分、住房分）
  const bd = r.final.breakdown;
  let constant = 0;
  for (const t of ['farm', 'forest', 'granary']) constant += (bd[t] ?? 0) * BUILDINGS[t].score;
  constant = Math.min(constant, cap);
  let housing = 0, hcap = 0;
  for (const t of ['hut', 'house']) { housing += (bd[t] ?? 0) * BUILDINGS[t].score; hcap += (bd[t] ?? 0) * BUILDINGS[t].capacity; }
  const occ = hcap > 0 ? Math.min(1, r.final.pop / hcap) : 0;
  housing = housing * occ;
  const parts = [['恒计分(封顶)', constant], ['住房', housing]];
  for (const t of ['mill', 'carpenter', 'eatery', 'grocer']) if (bd[t]) parts.push([t, bd[t] * BUILDINGS[t].score]);
  const total = parts.reduce((a, [, v]) => a + v, 0);
  const maxPart = total > 0 ? parts.reduce((a, b) => (b[1] > a[1] ? b : a)) : ['—', 0];
  const maxShare = total > 0 ? +(maxPart[1] / total).toFixed(2) : 0;
  return { inBand, downgrades: r.downgrades, maxShare, maxSource: maxPart[0], total: +total.toFixed(1) };
}

const mode = process.argv[2] ?? 'all';

// ---- 0. 基线复现门槛（不通过则中止）----
if (mode === 'all' || mode.startsWith('repro')) {
  PLACER = tryPlaceExact;
  const st = freshState({});
  const r = playthrough(st, verificationBot, { N: 1, maxTicks: 3000 });
  restore();
  console.log('--- 0. 基线复现（验收 bot，期望 12/315/515）---');
  console.log(JSON.stringify({ Lv2: r.levelAt[2], Lv3: r.levelAt[3], Lv4: r.levelAt[4] }));
  if (r.levelAt[4] !== 515) { console.error('基线复现失败，中止！'); process.exit(1); }
  PLACER = tryPlaceFast;
}

// ---- 1. 变体矩阵 ----
if (mode === 'all' || mode === 'matrix' || /^\d+,\d+/.test(mode)) {
  const CAPS = [24, 26, 28, 30];
  const LV4S = [130, 135, 140, 145, 150];
  let pairs = [];
  if (/^\d+,\d+/.test(mode)) {
    pairs = mode.split(';').map((s) => s.split(',').map(Number));
  } else {
    for (const c of CAPS) for (const t of LV4S) pairs.push([c, t]);
  }
  console.log('--- 1. 变体矩阵（N=∞，Lv3=60，迁入=5，restarts=10/iters=70，同预算可比）---');
  console.log('表头: 封顶, Lv4阈值 | Lv2, Lv3, Lv4 | 回落 | 建筑/户/花钱 | 熟练×1.7 / 普通×2.4 | 落带判定');
  for (const [cap, lv4] of pairs) {
    const t0 = Date.now();
    const sf = capConstant(cap);
    const { result: r } = search({ thresholds: [0, 20, 60, lv4] }, { scoreFormula: sf });
    const j = judge(r, cap);
    console.log(JSON.stringify({
      封顶: cap, Lv4阈值: lv4,
      Lv2: r.levelAt[2], Lv3: r.levelAt[3], Lv4: r.levelAt[4],
      等级回落: r.downgrades,
      建筑: r.final.buildings, 户: r.final.pop, 花钱: Math.round(r.moneySpent),
      熟练: r.levelAt[4] != null ? Math.round(r.levelAt[4] * 1.7) : null,
      普通: r.levelAt[4] != null ? Math.round(r.levelAt[4] * 2.4) : null,
      落带: j.inBand ? '✓' : (r.levelAt[4] == null ? '✗未通关' : '✗'),
      单一来源: j.maxSource, 单一来源占比: j.maxShare, 终局总分: j.total,
      终局: r.final.breakdown,
      耗时秒: +((Date.now() - t0) / 1000).toFixed(0),
    }));
  }
}

// ---- 2. Lv3→Lv4 段稀缺诊断（对指定配置，用于 N2 立项佐证与选项代价评估）----
if (mode === 'diag') {
  const ids = (process.env.DIAG_IDS ?? 'CAP24_150,CAP24_140,CAP28_150').split(',').filter(Boolean);
  console.log('--- 2. Lv3→Lv4 段稀缺诊断（N=∞）---');
  for (const id of ids) {
    const [cap, lv4] = id.replace('CAP', '').split('_').map(Number);
    const sf = capConstant(cap);
    const { result: r } = search({ thresholds: [0, 20, 60, lv4] }, { scoreFormula: sf });
    const tr = r.trace;
    const w = tr.filter((x) => x.t >= (r.levelAt[3] ?? 0) && x.t <= (r.levelAt[4] ?? Infinity));
    if (!w.length) { console.log(JSON.stringify({ 配置: id, 诊断: '无窗口' })); continue; }
    const f = (pred) => +(w.filter(pred).length / w.length).toFixed(3);
    const avg = (g) => +(w.reduce((a, x) => a + g(x), 0) / w.length).toFixed(2);
    console.log(JSON.stringify({
      配置: id, 窗口tick: w.length,
      劳力缺口帧占比: f((x) => x.idleLabor > 0),
      缺料帧占比: f((x) => x.idleMat > 0),
      住房满员帧占比: f((x) => x.vacant <= 0),
      食不过安全线帧占比: f((x) => x.food <= 10),
      '「无任何稀缺」帧占比': f((x) => x.idleLabor === 0 && x.idleMat === 0 && x.vacant > 0 && x.food > 10),
      平均劳力需求: avg((x) => x.dem), 平均户数: avg((x) => x.pop),
      劳力利用率: +(avg((x) => x.dem) / Math.max(1, avg((x) => x.pop))).toFixed(2),
    }));
  }
}

// ---- 3. N2 候选①预研：同类建筑造价递增（第 n 座 ×(1+slope·(n−from))）----
// 目的：验证「造价递增」能否在落带的同时压低空转帧占比（对照 CAP24_150 的 93.1%）
if (mode === 'ramp') {
  const specs = (process.env.RAMP_SPECS ?? 'S05F6,S05F10,S10F6').split(',').filter(Boolean);
  const lv4 = +(process.env.RAMP_LV4 ?? 150);
  console.log(`--- 3. 造价递增预研（N=∞，封顶24 + 阈值60/${lv4}，迁入5）---`);
  for (const spec of specs) {
    const slope = +('0.' + spec.slice(1, 3)) / 10; // S05 → 0.05
    const from = +spec.slice(4);
    COSTSCALE = { slope, from };
    const t0 = Date.now();
    const sf = capConstant(24);
    const { result: r } = search({ thresholds: [0, 20, 60, lv4] }, { scoreFormula: sf });
    const tr = r.trace;
    const w = tr.filter((x) => x.t >= (r.levelAt[3] ?? 0) && x.t <= (r.levelAt[4] ?? Infinity));
    const f = (pred) => w.length ? +(w.filter(pred).length / w.length).toFixed(3) : null;
    const avg = (g) => w.length ? +(w.reduce((a, x) => a + g(x), 0) / w.length).toFixed(2) : null;
    console.log(JSON.stringify({
      规格: spec, 语义: `第${from + 1}座起 ×(1+${slope}(n−${from}))`,
      Lv2: r.levelAt[2], Lv3: r.levelAt[3], Lv4: r.levelAt[4],
      等级回落: r.downgrades, 建筑: r.final.buildings, 户: r.final.pop, 花钱: Math.round(r.moneySpent),
      落带: r.levelAt[4] != null && r.levelAt[4] >= BAND[0] && r.levelAt[4] <= BAND[1] ? '✓' : '✗',
      窗口tick: w.length,
      劳力缺口帧: f((x) => x.idleLabor > 0), 缺料帧: f((x) => x.idleMat > 0),
      住房满员帧: f((x) => x.vacant <= 0), 食不过线帧: f((x) => x.food <= 10),
      无稀缺帧占比: f((x) => x.idleLabor === 0 && x.idleMat === 0 && x.vacant > 0 && x.food > 10),
      劳力利用率: avg ? +(avg((x) => x.dem) / Math.max(1, avg((x) => x.pop))).toFixed(2) : null,
      终局: r.final.breakdown,
      耗时秒: +((Date.now() - t0) / 1000).toFixed(0),
    }));
    COSTSCALE = null;
  }
}
