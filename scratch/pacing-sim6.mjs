// T-P6-09 候选方案的「每配置重新求最优」推演（只读脚本，不改 src/ 与 tests/）
// 背景：pacing-sim5 的单点推演被证明不可信——同一套策略在造价/阈值变化后会
//       「卡在自家上限」或「崩到只靠市税」，读数失真。因此本脚本对每个候选配置
//       重新跑一遍爬山搜索，求出该配置下的真实最优路线 L*(config)。
// 运行：node scratch/pacing-sim6.mjs           （默认全跑，约 3~5 分钟）
//       SIM_BUDGET=0.4 node scratch/pacing-sim6.mjs  （快速模式）
import { createInitialState } from '../src/core/state.js';
import { tick, housingCapacity, computeLevel } from '../src/core/simulation.js';
import { placeBuilding } from '../src/core/grid.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

const S = RULES.mapSize;
const BASE = {
  thresholds: [...RULES.unlockThresholds],
  money0: RULES.initialMoney, wood0: RULES.initialResources.wood,
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

// ---- 放置（fast 模式 + 游标；最终结果用 exact 模式复核）----
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

// ---- 策略 bot ----
function makePolicyBot(policy) {
  return function (state) {
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

// 恒计分封顶公式
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

function playthrough(state, bot, { maxTicks = 6000, scoreFormula = null, sustain = 0 } = {}) {
  const levelAt = { 2: null, 3: null, 4: null };
  let moneySpent = 0, sustainCount = 0, winTick = null, downgrades = 0, maxLevel = 1;
  const need = RULES.unlockThresholds[3];
  for (let i = 0; i < maxTicks; i++) {
    const before = state.money;
    bot(state);
    moneySpent += Math.max(0, before - state.money);
    tick(state);
    if (scoreFormula) { state.prosperity = scoreFormula(state); state.level = computeLevel(state.prosperity); }
    for (const lv of [2, 3, 4]) if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level < maxLevel) downgrades++;
    maxLevel = Math.max(maxLevel, state.level);
    if (sustain > 0) {
      if (state.prosperity >= need) sustainCount++; else sustainCount = 0;
      if (winTick == null && sustainCount >= sustain) winTick = state.tick;
    }
    if (sustain === 0 && state.level >= 4) break;
    if (sustain > 0 && winTick != null) break;
  }
  return {
    levelAt, moneySpent, winTick, downgrades,
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

// ---- 爬山搜索（每个配置独立跑）----
const TYPES = ['farm', 'forest', 'mill', 'eatery', 'granary', 'carpenter', 'grocer', 'house'];
const CAPRANGE = { farm: [2, 30], forest: [2, 20], mill: [2, 30], eatery: [2, 14], granary: [0, 6], carpenter: [0, 10], grocer: [0, 4], house: [0, 8] };
function search(ov, { restarts = 8, iters = 60, maxTicks = 3000, seedPolicy = null, scoreFormula = null, sustain = 0 } = {}) {
  const rnd = (() => { let s = 987654321; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const randomPolicy = () => {
    const order = []; const pool = [...TYPES];
    while (pool.length) order.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    const rules = order.map((t) => ({ type: t, cap: ri(...CAPRANGE[t]) }));
    rules.splice(Math.floor(rnd() * (rules.length + 1)), 0, { type: 'hut', cap: 999 });
    return { hutBuffer: ri(0, 3), useHouse: rnd() < 0.5, houseMoney: pick([80, 100, 120, 160]), forestCap: ri(4, 16), hutGate: pick([0, 0, 30, 50, 70]), rules };
  };
  const mutate = (p) => {
    const q = JSON.parse(JSON.stringify(p)); const k = ri(0, 5);
    if (k === 0) q.hutBuffer = Math.max(0, Math.min(3, q.hutBuffer + pick([-1, 1])));
    else if (k === 1) q.useHouse = !q.useHouse;
    else if (k === 2) { const r = q.rules[ri(0, q.rules.length - 1)]; if (r.type !== 'hut') r.cap = Math.max(0, Math.min(30, r.cap + pick([-2, -1, 1, 2]))); }
    else if (k === 3) { const i = ri(0, q.rules.length - 1), j = ri(0, q.rules.length - 1); [q.rules[i], q.rules[j]] = [q.rules[j], q.rules[i]]; }
    else if (k === 4) { const i = ri(0, q.rules.length - 1); if (q.rules[i].type !== 'hut') q.rules[i].type = pick(TYPES); }
    else { q.hutGate = pick([0, 0, 30, 50, 70]); q.forestCap = Math.max(4, Math.min(20, q.forestCap + pick([-2, 2]))); }
    return q;
  };
  const evaluate = (p) => {
    const st = freshState(ov);
    for (const k of Object.keys(CURSOR)) delete CURSOR[k];
    const r = playthrough(st, makePolicyBot(p), { maxTicks, scoreFormula, sustain });
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
  // exact 模式复核
  PLACER = tryPlaceExact;
  const stF = freshState(ov);
  const finalR = playthrough(stF, makePolicyBot(best), { maxTicks: 8000, scoreFormula, sustain });
  restore();
  PLACER = tryPlaceFast;
  return { policy: best, result: finalR };
}

// ============================================================
// 主流程
// ============================================================
const BUDGET = Number(process.env.SIM_BUDGET ?? 1);
const RESTARTS = Math.max(3, Math.round(8 * BUDGET));
const ITERS = Math.max(25, Math.round(60 * BUDGET));

const CONFIGS = [
  { id: 'A0', name: '基线（现网数值）', ov: {}, seed: { hutBuffer: 0, useHouse: false, houseMoney: 160, forestCap: 5, hutGate: 0, rules: [{ type: 'eatery', cap: 3 }, { type: 'mill', cap: 11 }, { type: 'hut', cap: 999 }, { type: 'granary', cap: 1 }, { type: 'house', cap: 0 }, { type: 'carpenter', cap: 4 }, { type: 'forest', cap: 8 }, { type: 'grocer', cap: 3 }, { type: 'farm', cap: 13 }] } },
  { id: 'B1', name: 'C4 阈值 Lv3 60 / Lv4 150', ov: { thresholds: [0, 20, 60, 150] } },
  { id: 'B2', name: 'C4 阈值 Lv3 70 / Lv4 200', ov: { thresholds: [0, 20, 70, 200] } },
  { id: 'C1', name: 'C5a 农田/林场 2→1 分', ov: { score: { farm: 1, forest: 1 } } },
  { id: 'C2', name: 'C5c 恒计分封顶 12', ov: {}, scoreFormula: 'cap12' },
  { id: 'D1', name: '【主推候选】阈值 150 + 农田/林场 2→1', ov: { thresholds: [0, 20, 60, 150], score: { farm: 1, forest: 1 } } },
  { id: 'D2', name: '【主推候选】阈值 150 + 农田/林场 2→1 + 食肆 3→2', ov: { thresholds: [0, 20, 60, 150], score: { farm: 1, forest: 1 }, moneyOut: { eatery: 2, grocer: 4 } } },
  { id: 'D3', name: '【主推候选】阈值 200 + 农田/林场 2→1 + 食肆 3→2', ov: { thresholds: [0, 20, 70, 200], score: { farm: 1, forest: 1 }, moneyOut: { eatery: 2, grocer: 4 } } },
  { id: 'E1', name: '阈值 150 + 恒计分封顶 20', ov: { thresholds: [0, 20, 60, 150] }, scoreFormula: 'cap20' },
  { id: 'E2', name: '阈值 150 + 恒计分封顶 20 + 食肆 3→2', ov: { thresholds: [0, 20, 60, 150], moneyOut: { eatery: 2, grocer: 4 } }, scoreFormula: 'cap20' },
  { id: 'F1', name: '阈值 150 + 造价 ×1.25', ov: { thresholds: [0, 20, 60, 150], costMulAll: 1.25 } },
  { id: 'F2', name: '阈值 150 + 迁入 5→8 + 农田/林场 2→1', ov: { thresholds: [0, 20, 60, 150], moveIn: 8, score: { farm: 1, forest: 1 } } },
  { id: 'G1', name: '结构性：阈值 100 维持 400 tick', ov: {}, sustain: 400 },
  { id: 'G2', name: '结构性：阈值 100 维持 400 tick + 农田/林场 2→1', ov: { score: { farm: 1, forest: 1 } }, sustain: 400 },

  // ---- 第二轮：围绕 F2（终局构成最均衡）做加减 ----
  { id: 'J1', name: 'F2 抬阈值：Lv4 200 + 迁入8 + 农田/林场1分', ov: { thresholds: [0, 20, 70, 200], moveIn: 8, score: { farm: 1, forest: 1 } } },
  { id: 'J2', name: 'F2 + 降初始存量：钱240→160 木60→40', ov: { thresholds: [0, 20, 60, 150], moveIn: 8, score: { farm: 1, forest: 1 }, money0: 160, wood0: 40 } },
  { id: 'J3', name: 'F2 + 食肆3→2 / 杂货摊5→4', ov: { thresholds: [0, 20, 60, 150], moveIn: 8, score: { farm: 1, forest: 1 }, moneyOut: { eatery: 2, grocer: 4 } } },
  { id: 'J4', name: 'F2 + 粮仓2→0', ov: { thresholds: [0, 20, 60, 150], moveIn: 8, score: { farm: 1, forest: 1, granary: 0 } } },
  { id: 'J5', name: '阈值200 + 恒计分封顶20 + 食肆3→2 + 迁入6', ov: { thresholds: [0, 20, 70, 200], moneyOut: { eatery: 2, grocer: 4 }, moveIn: 6 }, scoreFormula: 'cap20' },
  { id: 'J6', name: '纯阈值杠杆：Lv4 250（不动任何经济参数）', ov: { thresholds: [0, 20, 60, 250] } },
  { id: 'J7', name: '纯阈值杠杆：Lv4 300（不动任何经济参数）', ov: { thresholds: [0, 20, 60, 300] } },
  { id: 'J8', name: '主推 P-1：阈值150 + 迁入8 + 农田/林场1分 + 粮仓2→0 + 食肆3→2', ov: { thresholds: [0, 20, 60, 150], moveIn: 8, score: { farm: 1, forest: 1, granary: 0 }, moneyOut: { eatery: 2, grocer: 4 } } },
  { id: 'J9', name: '备选 P-2：阈值200 + 迁入8 + 农田/林场1分 + 粮仓2→0 + 食肆3→2', ov: { thresholds: [0, 20, 70, 200], moveIn: 8, score: { farm: 1, forest: 1, granary: 0 }, moneyOut: { eatery: 2, grocer: 4 } } },
  { id: 'J10', name: 'A/B 对照：P-1 但迁入维持 5（隔离迁入杠杆）', ov: { thresholds: [0, 20, 60, 150], moveIn: 5, score: { farm: 1, forest: 1, granary: 0 } } },
  { id: 'J11', name: 'A/B 对照：P-1 但农田/林场维持 2 分（隔离削恒计分杠杆）', ov: { thresholds: [0, 20, 60, 150], moveIn: 8, score: { granary: 0 } } },
  { id: 'J12', name: 'A/B 对照：P-1 但阈值维持 100（隔离阈值杠杆）', ov: { thresholds: [0, 20, 50, 100], moveIn: 8, score: { farm: 1, forest: 1, granary: 0 } } },
  { id: 'J13', name: 'J1 + 粮仓2→0：阈值200 + 迁入8 + 农田/林场1分 + 粮仓0', ov: { thresholds: [0, 20, 70, 200], moveIn: 8, score: { farm: 1, forest: 1, granary: 0 } } },
  { id: 'J14', name: 'J13 但阈值 Lv4 180（折中）', ov: { thresholds: [0, 20, 65, 180], moveIn: 8, score: { farm: 1, forest: 1, granary: 0 } } },
  { id: 'J15', name: 'J13 再加 食肆3→2 / 杂货摊5→4', ov: { thresholds: [0, 20, 70, 200], moveIn: 8, score: { farm: 1, forest: 1, granary: 0 }, moneyOut: { eatery: 2, grocer: 4 } } },
];

const only = process.argv[2]; // 逗号分隔的 id 列表
const onlySet = only ? new Set(only.split(',')) : null;
console.log(`--- 每配置重新求最优（restarts=${RESTARTS}, iters=${ITERS}）---`);
const results = [];
for (const cfg of CONFIGS) {
  if (onlySet && !onlySet.has(cfg.id)) continue;
  const sf = cfg.scoreFormula === 'cap12' ? capConstant(12) : cfg.scoreFormula === 'cap20' ? capConstant(20) : null;
  const t0 = Date.now();
  const { policy, result } = search(cfg.ov, { restarts: RESTARTS, iters: ITERS, seedPolicy: cfg.seed ?? null, scoreFormula: sf, sustain: cfg.sustain ?? 0, maxTicks: cfg.sustain ? 2000 : 3000 });
  const r = result;
  console.log(JSON.stringify({
    配置: cfg.id, 名称: cfg.name,
    'L*_Lv2': r.levelAt[2], 'L*_Lv3': r.levelAt[3], 'L*_Lv4': r.levelAt[4],
    维持通关: r.winTick ?? null,
    花钱: Math.round(r.moneySpent), 等级回落: r.downgrades,
    终局: r.final, 耗时秒: +((Date.now() - t0) / 1000).toFixed(0),
  }));
  results.push({ cfg, r, policy });
}
console.log('\n--- 汇总（按 L* 排序）---');
for (const { cfg, r } of results.slice().sort((a, b) => (a.r.levelAt[4] ?? a.r.winTick ?? 9e9) - (b.r.levelAt[4] ?? b.r.winTick ?? 9e9))) {
  const t = cfg.sustain ? r.winTick : r.levelAt[4];
  console.log(JSON.stringify({
    配置: cfg.id, 名称: cfg.name, 通关tick: t,
    '估算真人Lv4(×1.3)': t ? Math.round(t * 1.3) : null,
    建筑数: r.final.buildings, 户数: r.final.pop, 容量: r.final.cap,
    花钱: Math.round(r.moneySpent),
  }));
}
