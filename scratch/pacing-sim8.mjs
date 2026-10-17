// T-P6-09 补充推演：解除「每 tick 至多建造 1 座」节流后的真实下限 L*_human
// 背景：tests/verification/progression.test.js:57 的 `for (const t of wants) if (tryPlace(...)) return t;`
//       命中即 return —— bot 每 tick 只落 1 座。真人不受此限（UI 连点，1 秒内可落多座），
//       且 bot 还有 mill<6 / eatery<6 / carpenter<6 / granary<1 等硬上限（真人第 3 局 mill=7 已越过）。
//       沿用该节流会系统性高估 L*。本脚本按 team-lead 要求做 N 敏感性分析（N = 1/2/3/∞）。
//
// 运行： node scratch/pacing-sim8.mjs            # 全跑（N 敏感性 + P-1/P-2 重算，约 6~10 分钟）
//        node scratch/pacing-sim8.mjs sweep      # 只跑 N 敏感性曲线
//        node scratch/pacing-sim8.mjs repro      # 只跑 N=1 基线复现（必须 12/315/515）
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
  moneyOut: Object.fromEntries(Object.entries(BUILDINGS).map(([k, v]) => [k, v.outputs?.money ?? 0])),
};
function applyOverrides(ov = {}) {
  RULES.unlockThresholds = ov.thresholds ? [...ov.thresholds] : [...BASE.thresholds];
  RULES.initialResources.wood = ov.wood0 ?? BASE.wood0;
  RULES.moveInInterval = ov.moveIn ?? BASE.moveIn;
  RULES.tax.perHouseholdPerTick = ov.tax ?? BASE.tax;
  RULES.prosperityCoef.idle = ov.idle ?? BASE.idle;
  for (const [k, c] of Object.entries(BASE.cost)) {
    const mk = ov.costMul?.[k] ?? ov.costMulAll ?? 1;
    BUILDINGS[k].cost.money = Math.round(c.money * mk);
    BUILDINGS[k].cost.wood = Math.round(c.wood * mk);
  }
  for (const [k, s] of Object.entries(BASE.score)) BUILDINGS[k].score = ov.score?.[k] ?? s;
  for (const [k, m] of Object.entries(BASE.moneyOut)) {
    if (m === 0) continue;
    const v = ov.moneyOut?.[k] ?? m;
    if (v === 0) delete BUILDINGS[k].outputs.money; else BUILDINGS[k].outputs.money = v;
  }
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
  for (const [k, m] of Object.entries(BASE.moneyOut)) { if (m === 0) continue; BUILDINGS[k].outputs.money = m; }
}

// ---- 放置（fast 模式 + 游标；exact 模式用于最终复核）----
let SPOTS = null;
function buildSpotCache(state) {
  const all1 = [], all2 = [], fert2 = [], wood2 = [];
  const T = (x, y) => state.grid.get(`${x},${y}`).terrain;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) all1.push([x, y]);
  for (let y = 0; y <= S - 2; y++) for (let x = 0; x <= S - 2; x++) {
    all2.push([x, y]);
    if (T(x, y) === 'fertile' && T(x + 1, y) === 'fertile' && T(x, y + 1) === 'fertile' && T(x + 1, y + 1) === 'fertile') fert2.push([x, y]);
    if (T(x, y) === 'woodland' && T(x + 1, y) === 'woodland' && T(x, y + 1) === 'woodland' && T(x + 1, y + 1) === 'woodland') wood2.push([x, y]);
  }
  SPOTS = { all1, all2, fert2, wood2 };
}
const CURSOR = {};
function resetCursor() { for (const k of Object.keys(CURSOR)) delete CURSOR[k]; }
function tryPlaceFast(state, type) {
  const def = BUILDINGS[type];
  const [w, h] = def.size;
  if (state.money < def.cost.money || state.resources.wood < def.cost.wood) return false;
  let list;
  if (def.terrain === 'fertile') list = SPOTS.fert2;
  else if (def.terrain === 'woodland') list = SPOTS.wood2;
  else list = w === 2 || h === 2 ? SPOTS.all2 : SPOTS.all1;
  const n = list.length; let start = CURSOR[type] ?? 0; if (start >= n) start = 0;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n; const [x, y] = list[i];
    if (placeBuilding(state, type, x, y).ok) { CURSOR[type] = i + 1; return true; }
  }
  return false;
}
function tryPlaceExact(state, type) {
  const def = BUILDINGS[type];
  const [w, h] = def.size;
  if (state.money < def.cost.money || state.resources.wood < def.cost.wood) return false;
  for (let y = 0; y <= S - h; y++)
    for (let x = 0; x <= S - w; x++)
      if (placeBuilding(state, type, x, y).ok) return true;
  return false;
}
let PLACER = tryPlaceFast;
const tryPlace = (s, t) => PLACER(s, t);
const countType = (state, t) => state.buildings.filter((b) => b.type === t).length;

// ---- 验收 bot（与 progression.test.js 逐字一致，用于 N=1 基线复现与 L*_bot 对照）----
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

// ---- 策略 bot（无硬上限封顶，上限由搜索决定；每 tick 可建 N 座）----
function makePolicyBot(policy) {
  return function (state) {
    // spendFloor：本 tick 的「铜钱保留线」。真人连点时会给自己留钱买食肆（产钱引擎），
    // 不会把钱一次性全砸在茅舍上。没有这条，N=∞ 的贪心 bot 会过建住房 → 抽干铜钱 →
    // 退回纯市税路线（H7 双峰的下峰），反而更慢。
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

// 恒计分封顶公式（农田+林场+粮仓 合计封顶 capN）：保留前期计分速率，只掐断后期刷分
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

// ---- 推演：每 tick 调用 bot 至多 N 次（N=Infinity 表示建到建不动）----
function playthrough(state, bot, { maxTicks = 6000, N = 1, sustain = 0, scoreFormula = null, trace = false } = {}) {
  const levelAt = { 2: null, 3: null, 4: null };
  let moneySpent = 0, buildCount = 0, sustainCount = 0, winTick = null, downgrades = 0, maxLevel = 1;
  const need = RULES.unlockThresholds[3];
  const tr = [];
  for (let i = 0; i < maxTicks; i++) {
    const before = state.money;
    let built = 0;
    // N 次尝试：每次调用 bot 重新评估（受铜钱/木材/地形/解锁等级约束，无人为节流）
    while (built < N) {
      if (!bot(state)) break;
      built++;
      if (built > 500) break; // 安全阀
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
    if (sustain > 0) {
      if (state.prosperity >= need) sustainCount++; else sustainCount = 0;
      if (winTick == null && sustainCount >= sustain) winTick = state.tick;
    }
    if (sustain === 0 && state.level >= 4) break;
    if (sustain > 0 && winTick != null) break;
  }
  return {
    levelAt, moneySpent, buildCount, winTick, downgrades, trace: tr,
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

// ---- 爬山搜索（对给定配置 + 给定 N 求最优策略）----
const TYPES = ['farm', 'forest', 'mill', 'eatery', 'granary', 'carpenter', 'grocer', 'house'];
const CAPRANGE = { farm: [2, 40], forest: [2, 30], mill: [2, 40], eatery: [2, 20], granary: [0, 8], carpenter: [0, 14], grocer: [0, 4], house: [0, 12] };
function search(ov, { restarts = 8, iters = 60, N = 1, maxTicks = 3000, seedPolicy = null, sustain = 0, scoreFormula = null } = {}) {
  const rnd = (() => { let s = 20261017; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
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
    const r = playthrough(st, makePolicyBot(p), { maxTicks, N, sustain, scoreFormula });
    restore();
    return r;
  };
  const sc = (r) => (sustain > 0 ? (r.winTick ?? 99999) : (r.levelAt[4] ?? 99999));
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
  const finalR = playthrough(stF, makePolicyBot(best), { maxTicks: 8000, N, sustain, scoreFormula, trace: true });
  restore();
  PLACER = tryPlaceFast;
  return { policy: best, result: finalR };
}

const mode = process.argv[2] ?? 'all';

// ============================================================
// A. N=1 基线复现（必须与验收记录 12/315/515 一致，证明模型可信）
// ============================================================
if (mode === 'all' || mode === 'repro') {
  console.log('--- A. N=1 基线复现（验收 bot，期望 12/315/515）---');
  PLACER = tryPlaceExact;
  const st = freshState({});
  const r = playthrough(st, verificationBot, { N: 1, maxTicks: 3000 });
  console.log(JSON.stringify({ 场景: '验收 bot N=1', Lv2: r.levelAt[2], Lv3: r.levelAt[3], Lv4: r.levelAt[4], 终局: r.final }));
  restore();
  const st2 = freshState({});
  const r2 = playthrough(st2, verificationBot, { N: Infinity, maxTicks: 3000 });
  console.log(JSON.stringify({ 场景: '验收 bot 放开节流 N=∞', Lv2: r2.levelAt[2], Lv3: r2.levelAt[3], Lv4: r2.levelAt[4], 终局: r2.final }));
  restore();
  PLACER = tryPlaceFast;
}

// ============================================================
// B. N 敏感性曲线：L* 随「每 tick 建造上限 N」的变化（基线配置）
// ============================================================

// ============================================================
// D. 消融实验：逐项去掉 P-1' / P-1 的每个改动，量化各自边际贡献
//    并采集 Lv3→Lv4 段的稀缺约束诊断（回应 team-lead 对「迁入 5→8 是否
//    让劳力重新成为瓶颈」的机制性质询）
// ============================================================
const ABL = [
  { id: 'BASE',   name: '基线（什么都不改）', ov: {} },
  { id: 'A_full', name: "P-1′ 完整：恒计分封顶24 + 阈值60/150 + 迁入8", ov: { thresholds: [0, 20, 60, 150], moveIn: 8 }, scoreFormula: 'cap24' },
  { id: 'A_nomig',name: "P-1′ 去掉迁入5→8", ov: { thresholds: [0, 20, 60, 150], moveIn: 5 }, scoreFormula: 'cap24' },
  { id: 'A_nothr',name: "P-1′ 去掉抬阈值（回 50/100）", ov: { thresholds: [0, 20, 50, 100], moveIn: 8 }, scoreFormula: 'cap24' },
  { id: 'A_nocap',name: "P-1′ 去掉削恒计分（只抬阈值+迁入）", ov: { thresholds: [0, 20, 60, 150], moveIn: 8 }, scoreFormula: null },
  { id: 'B_full', name: 'P-1 完整：农田/林场2→1 + 阈值60/150 + 迁入8', ov: { thresholds: [0, 20, 60, 150], moveIn: 8, score: { farm: 1, forest: 1 } } },
  { id: 'B_nomig',name: 'P-1 去掉迁入5→8', ov: { thresholds: [0, 20, 60, 150], moveIn: 5, score: { farm: 1, forest: 1 } } },
];
function diagWindow(tr, lv3, lv4) {
  const w = tr.filter((r) => r.t >= (lv3 ?? 0) && r.t <= (lv4 ?? Infinity));
  if (!w.length) return null;
  const f = (pred) => +(w.filter(pred).length / w.length).toFixed(3);
  const avg = (g) => +(w.reduce((a, r) => a + g(r), 0) / w.length).toFixed(2);
  return {
    窗口tick: w.length,
    劳力缺口帧占比: f((r) => r.idleLabor > 0),
    缺料帧占比: f((r) => r.idleMat > 0),
    住房满员帧占比: f((r) => r.vacant <= 0),
    食不过安全线帧占比: f((r) => r.food <= 10),
    '「迁入节拍是唯一约束」帧占比': f((r) => r.vacant > 0 && r.food > 10 && r.idleLabor > 0),
    '「无任何稀缺」帧占比': f((r) => r.idleLabor === 0 && r.idleMat === 0 && r.vacant > 0 && r.food > 10),
    平均劳力需求: avg((r) => r.dem), 平均户数: avg((r) => r.pop),
    劳力利用率: +(avg((r) => r.dem) / Math.max(1, avg((r) => r.pop))).toFixed(2),
  };
}
const SWEEP = [
  { N: 1, label: 'N=1（= 验收 bot 的节流）' },
  { N: 2, label: 'N=2' },
  { N: 3, label: 'N=3' },
  { N: Infinity, label: 'N=∞（建到建不动 = 人类能力上界）' },
];
const SEED = { hutBuffer: 0, useHouse: false, houseMoney: 160, forestCap: 5, hutGate: 0, spendFloor: 0,
  rules: [{ type: 'eatery', cap: 3 }, { type: 'mill', cap: 11 }, { type: 'hut', cap: 999 },
    { type: 'granary', cap: 1 }, { type: 'house', cap: 0 }, { type: 'carpenter', cap: 4 },
    { type: 'forest', cap: 8 }, { type: 'grocer', cap: 3 }, { type: 'farm', cap: 13 }] };

// ============================================================
// A0. 决定性对照：固定策略（N=1 下求出的最优策略）在 N=1/2/3/∞ 下的表现
//     ——不搜索，纯确定性重放，用于隔离「节流」这一个变量的真实量级
// ============================================================
if (mode === 'all' || mode === 'fixed') {
  console.log('--- A0. 固定策略 × 不同建造上限 N（隔离节流变量，不搜索）---');
  const P = SEED;
  for (const s of SWEEP) {
    PLACER = tryPlaceExact;
    const st = freshState({});
    const r = playthrough(st, makePolicyBot(P), { N: s.N, maxTicks: 3000 });
    restore();
    console.log(JSON.stringify({
      策略: 'N=1 最优策略（固定不变）', N: s.label,
      Lv2: r.levelAt[2], Lv3: r.levelAt[3], Lv4: r.levelAt[4],
      建造次数: r.buildCount, 建筑每tick: +(r.buildCount / Math.max(1, r.final.tick)).toFixed(2),
      花钱: Math.round(r.moneySpent), 等级回落: r.downgrades, 终局: r.final,
    }));
  }
  PLACER = tryPlaceFast;
}

if (mode === 'all' || mode === 'sweep') {
  console.log('--- B. N 敏感性曲线（基线配置，每档独立重新求最优）---');
  for (const s of SWEEP) {
    const t0 = Date.now();
    // 所有 N 档都注入 N=1 的最优策略作为起点（否则 N≥2 的搜索会掉进
    //「住房优先 → 抽干铜钱 → 退回纯市税」的更差局部最优，见报告 §1.4）
    const { result: r } = search({}, { restarts: 10, iters: 70, N: s.N, seedPolicy: SEED, maxTicks: 2000 });
    console.log(JSON.stringify({
      场景: `L* @ ${s.label}`, Lv2: r.levelAt[2], Lv3: r.levelAt[3], Lv4: r.levelAt[4],
      建造次数: r.buildCount, 建筑每tick: +(r.buildCount / Math.max(1, r.final.tick)).toFixed(2),
      花钱: Math.round(r.moneySpent), 等级回落: r.downgrades, 终局: r.final,
      耗时秒: +((Date.now() - t0) / 1000).toFixed(0),
    }));
  }
}

// ============================================================
// C. 用 N=∞ 重算候选方案（这是 team-lead 要求的「真实下限」口径）
// ============================================================
const CANDS = [
  { id: 'BASE', name: '基线（现网数值）', ov: {} },
  { id: 'P1', name: '主推 P-1：农田/林场2→1 + 阈值60/150 + 迁入5→8', ov: { thresholds: [0, 20, 60, 150], moveIn: 8, score: { farm: 1, forest: 1 } } },
  { id: 'P1nm', name: 'P-1 去掉迁入杠杆（QA 证 O2≈0%）：农田/林场2→1 + 阈值60/150', ov: { thresholds: [0, 20, 60, 150], score: { farm: 1, forest: 1 } } },
  { id: 'P1b', name: 'P-1 变体：阈值 60/180', ov: { thresholds: [0, 20, 60, 180], moveIn: 8, score: { farm: 1, forest: 1 } } },
  { id: 'P1c', name: 'P-1 变体：阈值 70/200', ov: { thresholds: [0, 20, 70, 200], moveIn: 8, score: { farm: 1, forest: 1 } } },
  { id: 'CAP24_ONLY', name: '仅 恒计分封顶24（阈值不动、迁入不动）—— 封顶自适应策略', ov: {}, scoreFormula: 'cap24',
    seed: { hutBuffer: 0, useHouse: false, houseMoney: 160, forestCap: 6, hutGate: 0, spendFloor: 0,
      rules: [{ type: 'eatery', cap: 3 }, { type: 'mill', cap: 20 }, { type: 'hut', cap: 999 },
        { type: 'forest', cap: 6 }, { type: 'farm', cap: 6 }, { type: 'carpenter', cap: 6 },
        { type: 'granary', cap: 1 }, { type: 'grocer', cap: 3 }] } },
  { id: 'CAP24_ONLY2', name: '仅 恒计分封顶24 —— 另一套封顶自适应策略（食肆优先）', ov: {}, scoreFormula: 'cap24',
    seed: { hutBuffer: 0, useHouse: false, houseMoney: 160, forestCap: 6, hutGate: 0, spendFloor: 40,
      rules: [{ type: 'eatery', cap: 8 }, { type: 'farm', cap: 6 }, { type: 'forest', cap: 6 },
        { type: 'mill', cap: 24 }, { type: 'hut', cap: 999 }, { type: 'carpenter', cap: 8 }, { type: 'grocer', cap: 4 }] } },
  { id: 'T130_ONLY', name: '仅 阈值 60/130（不削恒计分）', ov: { thresholds: [0, 20, 60, 130] } },
  { id: 'CAP20', name: '削恒计分的另一种形态：恒计分封顶 20（阈值 60/150，分值不变）', ov: { thresholds: [0, 20, 60, 150] }, scoreFormula: 'cap20' },
  { id: 'CAP24', name: '恒计分封顶 24（阈值 60/150，分值不变）', ov: { thresholds: [0, 20, 60, 150] }, scoreFormula: 'cap24' },
  { id: 'T250', name: '纯阈值 250（验证 QA 的「无阈值解」不可能性证明）', ov: { thresholds: [0, 20, 60, 250] } },
  { id: 'P2', name: '备选 P-2：农田/林场2→1 + 维持400tick', ov: { score: { farm: 1, forest: 1 } }, sustain: 400 },
];
if (mode === 'all' || mode === 'cands') {
  console.log('--- C. N=∞ 下的候选方案重算 ---');
  const only = (process.env.CANDS_IDS ?? '').split(',').filter(Boolean);
  for (const c of CANDS) {
    if (only.length && !only.includes(c.id)) continue;
    const t0 = Date.now();
    // 所有配置都注入同一个优良起点（N=1 基线最优策略），保证跨配置可比
    const sf = c.scoreFormula === 'cap20' ? capConstant(20) : c.scoreFormula === 'cap24' ? capConstant(24) : null;
    const { result: r } = search(c.ov, { restarts: 10, iters: 70, N: Infinity, maxTicks: 2000, sustain: c.sustain ?? 0, seedPolicy: c.seed ?? SEED, scoreFormula: sf });
    console.log(JSON.stringify({
      配置: c.id, 名称: c.name, Lv2: r.levelAt[2], Lv3: r.levelAt[3], Lv4: r.levelAt[4],
      维持通关: r.winTick ?? null, 建造次数: r.buildCount,
      建筑每tick: +(r.buildCount / Math.max(1, r.final.tick)).toFixed(2),
      花钱: Math.round(r.moneySpent), 等级回落: r.downgrades, 终局: r.final,
      耗时秒: +((Date.now() - t0) / 1000).toFixed(0),
    }));
  }
}

if (mode === 'all' || mode === 'ablate') {
  console.log('--- D. 消融实验（N=∞ 口径，每项独立重新求最优）---');
  const out = [];
  const onlyA = (process.env.ABL_IDS ?? '').split(',').filter(Boolean);
  for (const c of ABL) {
    if (onlyA.length && !onlyA.includes(c.id)) continue;
    const sf = c.scoreFormula === 'cap24' ? capConstant(24) : null;
    const { result: r } = search(c.ov, { restarts: 10, iters: 70, N: Infinity, maxTicks: 2000, seedPolicy: c.seed ?? SEED, scoreFormula: sf });
    console.log(JSON.stringify({
      配置: c.id, 名称: c.name,
      Lv2: r.levelAt[2], Lv3: r.levelAt[3], Lv4: r.levelAt[4],
      等级回落: r.downgrades, 建筑: r.final.buildings, 户: r.final.pop, 花钱: Math.round(r.moneySpent),
    }));
    console.log('   Lv3→Lv4 段诊断: ' + JSON.stringify(diagWindow(r.trace, r.levelAt[3], r.levelAt[4])));
    out.push({ id: c.id, r });
  }
  console.log('--- D2. 边际贡献（相对同一族完整配置）---');
  const g = (id) => out.find((o) => o.id === id).r.levelAt[4];
  const show = (full, drop, label) => {
    const F = g(full), D = g(drop);
    console.log(JSON.stringify({ 消融项: label, 完整Lv4: F, 去掉后Lv4: D, 'Δ': F - D, 'Δ%': +(((F - D) / F) * 100).toFixed(1) }));
  };
  show('A_full', 'A_nomig', "P-1′ 去掉 迁入5→8");
  show('A_full', 'A_nothr', "P-1′ 去掉 抬阈值");
  show('A_full', 'A_nocap', "P-1′ 去掉 削恒计分");
  show('B_full', 'B_nomig', 'P-1 去掉 迁入5→8');
}


