// T-P6-09 归因推演（只读脚本，不改 src/ 与 tests/）
// 目的：
//   ① 精确复现验收基线 bot 12/315/515（证明模型可信）
//   ② 回放第 3 局真人路线，检验「P1/P2 组合拳对该路线是否中性」→ 判定 H1
//   ③ 搜索「精简高能路线」的理论最短通关 tick = 真实下限 L*_bot → 判定 H2
//   ④ 分钱比分析 → 判定 H3/H4/H5
// 运行： node scratch/pacing-sim4.mjs
//        node scratch/pacing-sim4.mjs search   （只跑策略搜索）
import { createInitialState } from '../src/core/state.js';
import { tick, housingCapacity, computeLevel } from '../src/core/simulation.js';
import { placeBuilding } from '../src/core/grid.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

// ============================================================
// 0. 参数覆盖机制（内存覆盖，磁盘文件零改动）
// ============================================================
const BASE = {
  thresholds: [...RULES.unlockThresholds],
  money0: RULES.initialMoney,
  wood0: RULES.initialResources.wood,
  moveInInterval: RULES.moveInInterval,
  tax: RULES.tax.perHouseholdPerTick,
  idle: RULES.prosperityCoef.idle,
  cost: Object.fromEntries(Object.entries(BUILDINGS).map(([k, v]) => [k, { ...v.cost }])),
  score: Object.fromEntries(Object.entries(BUILDINGS).map(([k, v]) => [k, v.score])),
  moneyOut: Object.fromEntries(
    Object.entries(BUILDINGS).map(([k, v]) => [k, v.outputs?.money ?? 0])
  ),
};

function applyOverrides(ov = {}) {
  RULES.unlockThresholds = ov.thresholds ? [...ov.thresholds] : [...BASE.thresholds];
  RULES.initialResources.wood = ov.wood0 ?? BASE.wood0;
  RULES.moveInInterval = ov.moveInInterval ?? BASE.moveInInterval;
  RULES.tax.perHouseholdPerTick = ov.tax ?? BASE.tax;
  RULES.prosperityCoef.idle = ov.idle ?? BASE.idle;
  for (const [k, c] of Object.entries(BASE.cost)) {
    const m = ov.costMulAll ?? 1;
    const mk = ov.costMul?.[k] ?? m;
    BUILDINGS[k].cost.money = Math.round(c.money * mk);
    BUILDINGS[k].cost.wood = Math.round(c.wood * mk);
  }
  for (const [k, s] of Object.entries(BASE.score)) {
    BUILDINGS[k].score = ov.score?.[k] ?? s;
  }
  for (const [k, m] of Object.entries(BASE.moneyOut)) {
    if (m === 0) continue;
    const v = ov.moneyOut?.[k] ?? m;
    if (v === 0) delete BUILDINGS[k].outputs.money;
    else BUILDINGS[k].outputs.money = v;
  }
  return { money0: ov.money0 ?? BASE.money0 };
}

function restore() {
  RULES.unlockThresholds = [...BASE.thresholds];
  RULES.initialResources.wood = BASE.wood0;
  RULES.moveInInterval = BASE.moveInInterval;
  RULES.tax.perHouseholdPerTick = BASE.tax;
  RULES.prosperityCoef.idle = BASE.idle;
  for (const [k, c] of Object.entries(BASE.cost)) {
    BUILDINGS[k].cost.money = c.money;
    BUILDINGS[k].cost.wood = c.wood;
  }
  for (const [k, s] of Object.entries(BASE.score)) BUILDINGS[k].score = s;
  for (const [k, m] of Object.entries(BASE.moneyOut)) {
    if (m === 0) continue;
    BUILDINGS[k].outputs.money = m;
  }
}

// ============================================================
// 1. 放置工具（exact 模式与验收用例逐字一致；fast 模式用于大批量搜索）
// ============================================================
const S = RULES.mapSize;
let SPOTS = null; // { all1, all2, fert2, wood2 }

function buildSpotCache(state) {
  const all1 = [], all2 = [], fert2 = [], wood2 = [];
  const T = (x, y) => state.grid.get(`${x},${y}`).terrain;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) all1.push([x, y]);
  for (let y = 0; y <= S - 2; y++) for (let x = 0; x <= S - 2; x++) {
    all2.push([x, y]);
    if (T(x, y) === 'fertile' && T(x + 1, y) === 'fertile' && T(x, y + 1) === 'fertile' && T(x + 1, y + 1) === 'fertile')
      fert2.push([x, y]);
    if (T(x, y) === 'woodland' && T(x + 1, y) === 'woodland' && T(x, y + 1) === 'woodland' && T(x + 1, y + 1) === 'woodland')
      wood2.push([x, y]);
  }
  SPOTS = { all1, all2, fert2, wood2 };
  return SPOTS;
}

const countType = (state, t) => state.buildings.filter((b) => b.type === t).length;

function tryPlaceExact(state, type) {
  const def = BUILDINGS[type];
  const [w, h] = def.size;
  for (let y = 0; y <= S - h; y++)
    for (let x = 0; x <= S - w; x++)
      if (placeBuilding(state, type, x, y).ok) return true;
  return false;
}

// fast 模式：按类型缓存锚点列表 + 游标（放置是单调递增的，摊还 O(1)）
const CURSOR = {};
function tryPlaceFast(state, type) {
  const def = BUILDINGS[type];
  const [w, h] = def.size;
  if (state.money < def.cost.money || state.resources.wood < def.cost.wood) return false;
  let list;
  if (def.terrain === 'fertile') list = SPOTS.fert2;
  else if (def.terrain === 'woodland') list = SPOTS.wood2;
  else list = w === 2 || h === 2 ? SPOTS.all2 : SPOTS.all1;
  const n = list.length;
  let start = CURSOR[type] ?? 0;
  if (start >= n) start = 0;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const [x, y] = list[i];
    if (placeBuilding(state, type, x, y).ok) { CURSOR[type] = i + 1; return true; }
  }
  return false;
}
function resetCursor() { for (const k of Object.keys(CURSOR)) delete CURSOR[k]; }

let PLACER = tryPlaceExact;
const tryPlace = (state, t) => PLACER(state, t);

// ============================================================
// 2. 繁荣度公式覆盖（用于 P1/P2 中性检验与候选公式推演）
// ============================================================
// formula:
//   'v3'      = 现行（P1 闲置 0 + P2 入住率）
//   'v1'      = 调参前（闲置 0.3 + 民居全额）
//   'cap'     = v3 + 恒计分（农田/林场/粮仓）总额上限 ov.capN
function prosperityWith(state, formula, ov = {}) {
  const c = RULES.prosperityCoef;
  let working = 0, housingScore = 0, housingCap = 0, constant = 0;
  for (const b of state.buildings) {
    const def = BUILDINGS[b.type];
    if (def.capacity > 0) { housingScore += def.score; housingCap += def.capacity; continue; }
    const s = def.score * (b.idle ? c.idle : c.active);
    working += s;
    if (['farm', 'forest', 'granary'].includes(b.type)) constant += s;
  }
  const occ = housingCap > 0 ? Math.min(1, state.population.count / housingCap) : 0;
  let raw = working + housingScore * occ;
  if (formula === 'v1') {
    // 调参前：民居全额
    raw = working + housingScore;
  }
  if (formula === 'cap' && ov.capN != null) {
    const excess = Math.max(0, constant - ov.capN);
    raw -= excess;
  }
  return raw;
}

// ============================================================
// 3. bot 定义
// ============================================================

// 3.1 验收 bot（与 tests/verification/progression.test.js 逐字一致）
function verificationBot(state) {
  const lvl = state.level;
  const cap = housingCapacity(state);
  const pop = state.population.count;
  const c = countType;
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

// 3.2 策略化 bot：按顺序检查 {type, cap} 规则；'hut' 用动态规则（空位 < B 就补）
function makePolicyBot(policy) {
  return function (state) {
    const lvl = state.level;
    const cap = housingCapacity(state);
    const pop = state.population.count;
    const wants = [];
    // 木材保险：木 < 10 时优先补林场（否则会出现「木=0 → 什么都建不起」的假死锁）
    if (state.resources.wood < 10 && countType(state, 'forest') < (policy.forestCap ?? 12)) wants.push('forest');
    for (const rule of policy.rules) {
      if (rule.type === 'hut') {
        // hutGate：铜钱低于该阈值时不补住房，把钱让给商业/计分建筑（人类玩家的自然行为）
        if (cap - pop <= policy.hutBuffer && state.money > (policy.hutGate ?? 0))
          wants.push(lvl >= 3 && policy.useHouse && state.money > policy.houseMoney ? 'house' : 'hut');
      } else if (rule.type === 'house') {
        if (cap - pop <= policy.hutBuffer && lvl >= 3 && countType(state, 'house') < rule.cap) wants.push('house');
      } else if (rule.type === 'farm') {
        if (countType(state, 'farm') < rule.cap) wants.push('farm');
      } else if (rule.type === 'forest') {
        if (countType(state, 'forest') < rule.cap) wants.push('forest');
      } else if (rule.type === 'mill') {
        if (countType(state, 'mill') < rule.cap && countType(state, 'mill') <= countType(state, 'farm')) wants.push('mill');
      } else if (rule.type === 'eatery') {
        if (lvl >= 2 && countType(state, 'eatery') < rule.cap && state.resources.food > 12) wants.push('eatery');
      } else if (rule.type === 'granary') {
        if (lvl >= 2 && countType(state, 'granary') < rule.cap) wants.push('granary');
      } else if (rule.type === 'carpenter') {
        if (lvl >= 3 && countType(state, 'carpenter') < rule.cap) wants.push('carpenter');
      } else if (rule.type === 'grocer') {
        if (lvl >= 4 && countType(state, 'grocer') < rule.cap) wants.push('grocer');
      }
    }
    for (const t of wants) if (tryPlace(state, t)) return t;
    return null;
  };
}

// 3.3 第 3 局真人路线回放 bot（严格照抄遥测里的建造顺序与终局配比）
// 遥测：tick30 hut3 farm2 forest2 → tick60 +mill2 +eatery1 → tick90 +hut3 +forest1
//       → tick120 +mill1 +eatery1 +granary2 → tick150 +farm2 +granary1
//       → tick180 +mill2 +carpenter1 +house3 → tick210 +forest3 +mill1 +eatery2 → tick225 +mill1 +eatery1
function humanRound3Bot(state) {
  const lvl = state.level;
  const t = state.tick;
  const c = countType;
  const cap = housingCapacity(state), pop = state.population.count;
  const wants = [];
  // 住房：保持约 2 户空位（终局 24 户 / 24 容量，入住率 1.0）
  if (cap - pop < 2) wants.push(lvl >= 3 && c(state, 'house') < 3 ? 'house' : 'hut');
  if (t < 30) {
    if (c(state, 'farm') < 2) wants.push('farm');
    if (c(state, 'forest') < 2) wants.push('forest');
  }
  if (t >= 30) { if (c(state, 'mill') < 2) wants.push('mill'); if (lvl >= 2 && c(state, 'eatery') < 1) wants.push('eatery'); }
  if (t >= 60) { if (c(state, 'hut') < 6) wants.push('hut'); if (c(state, 'forest') < 3) wants.push('forest'); }
  if (t >= 90) { if (c(state, 'mill') < 3) wants.push('mill'); if (lvl >= 2 && c(state, 'eatery') < 2) wants.push('eatery'); if (lvl >= 2 && c(state, 'granary') < 2) wants.push('granary'); }
  if (t >= 120) { if (c(state, 'farm') < 5) wants.push('farm'); if (lvl >= 2 && c(state, 'granary') < 3) wants.push('granary'); }
  if (t >= 150) { if (c(state, 'mill') < 5) wants.push('mill'); if (lvl >= 3 && c(state, 'carpenter') < 1) wants.push('carpenter'); if (lvl >= 3 && c(state, 'house') < 3) wants.push('house'); }
  if (t >= 180) { if (c(state, 'forest') < 6) wants.push('forest'); if (c(state, 'mill') < 6) wants.push('mill'); if (lvl >= 2 && c(state, 'eatery') < 4) wants.push('eatery'); }
  if (t >= 210) { if (c(state, 'mill') < 7) wants.push('mill'); if (lvl >= 2 && c(state, 'eatery') < 5) wants.push('eatery'); }
  for (const x of wants) if (tryPlace(state, x)) return x;
  return null;
}

// ============================================================
// 4. 推演驱动
// ============================================================
function playthrough(state, bot, { maxTicks = 3000, formula = 'v3', ov = {}, sustain = 0 } = {}) {
  const levelAt = { 2: null, 3: null, 4: null };
  let moneySpent = 0, buildTicks = 0, sustainCount = 0, winTick = null;
  let maxPros = 0;
  for (let i = 0; i < maxTicks; i++) {
    const before = state.money;
    const built = bot(state);
    if (built) { moneySpent += before - state.money; buildTicks++; }
    tick(state);
    if (formula !== 'v3') {
      state.prosperity = prosperityWith(state, formula, ov);
      state.level = computeLevel(state.prosperity);
    }
    maxPros = Math.max(maxPros, state.prosperity);
    for (const lv of [2, 3, 4])
      if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (sustain > 0) {
      if (state.prosperity >= (ov.sustainAt ?? RULES.unlockThresholds[3])) sustainCount++;
      else sustainCount = 0;
      if (winTick == null && sustainCount >= sustain) winTick = state.tick;
    }
    if (sustain === 0 && state.level >= 4) break;
    if (sustain > 0 && winTick != null) break;
  }
  return {
    levelAt, moneySpent, buildTicks, maxPros, winTick,
    final: {
      tick: state.tick, money: +state.money.toFixed(0),
      pop: state.population.count, cap: housingCapacity(state),
      buildings: state.buildings.length,
      breakdown: Object.fromEntries(
        Object.keys(BUILDINGS).map((k) => [k, countType(state, k)]).filter(([, v]) => v > 0)
      ),
      prosperity: +state.prosperity.toFixed(1),
      level: state.level,
    },
  };
}

function freshState(ov = {}) {
  const inf = applyOverrides(ov);
  const st = createInitialState();
  if (!SPOTS) buildSpotCache(st);
  st.money = inf.money0;
  return st;
}

function report(label, r) {
  console.log(JSON.stringify({
    场景: label,
    到Lv2: r.levelAt[2], 到Lv3: r.levelAt[3], 到Lv4: r.levelAt[4],
    维持通关: r.winTick ?? null,
    累计花钱: Math.round(r.moneySpent),
    分每钱: +(100 / Math.max(1, r.moneySpent)).toFixed(3),
    建造次数: r.buildTicks,
    终局: r.final,
  }));
}

// ============================================================
// 5. 主流程
// ============================================================
const arg = process.argv[2] ?? 'all';

// --- 模块 A：地形普查 ---
if (arg === 'all' || arg === 'terrain') {
  const st = freshState({});
  buildSpotCache(st);
  let fertile = 0, woodland = 0, plain = 0;
  for (const [, cell] of st.grid) {
    if (cell.terrain === 'fertile') fertile++;
    else if (cell.terrain === 'woodland') woodland++;
    else plain++;
  }
  console.log('--- A. 地形普查（决定农田/林场硬上限）---');
  console.log(JSON.stringify({
    地图: `${S}x${S}`,
    沃土格: fertile, 林地格: woodland, 普通地: plain,
    农田可放锚点数: SPOTS.fert2.length,
    林场可放锚点数: SPOTS.wood2.length,
  }));
  restore();
}

// --- 模块 B：基线复现（验收 bot，必须 12/315/515）---
if (arg === 'all' || arg === 'baseline') {
  console.log('--- B. 基线复现（验收 bot，期望 12/315/515）---');
  PLACER = tryPlaceExact;
  const st = freshState({});
  report('B1 验收 bot（现行公式 v3）', playthrough(st, verificationBot, {}));
  restore();

  const st2 = freshState({ idle: 0.3 });
  report('B2 验收 bot（调参前公式 v1，idle=0.3+民居全额）',
    playthrough(st2, verificationBot, { formula: 'v1' }));
  restore();
}

// --- 模块 C：第 3 局真人路线回放 + P1/P2 中性检验 ---
if (arg === 'all' || arg === 'human') {
  console.log('--- C. 第 3 局真人路线回放（遥测 45/145/225，终局 24 户/36 建筑/100.0）---');
  PLACER = tryPlaceExact;
  const a = freshState({});
  report('C1 现行公式 v3（P1+P2 生效）', playthrough(a, humanRound3Bot, { formula: 'v3' }));
  restore();
  const b = freshState({ idle: 0.3 });
  report('C2 调参前公式 v1（idle=0.3 + 民居全额）', playthrough(b, humanRound3Bot, { formula: 'v1' }));
  restore();
  const c = freshState({ idle: 0.3 });
  report('C3 仅 P1（idle=0，民居仍全额）', playthrough(c, humanRound3Bot, { formula: 'v3' }));
  restore();
}

// --- 模块 D：真实下限 L* 搜索 ---
if (arg === 'all' || arg === 'search' || arg === 'star') {
  console.log('--- D. 真实下限 L* 搜索（精简高能路线）---');
  PLACER = tryPlaceFast;

  // D0：手搓的「第 3 局精简镜像」策略（作为搜索起点）
  const mkSeed = (o) => ({
    hutBuffer: 1, useHouse: false, houseMoney: 100, forestCap: 10, hutGate: 0, ...o,
  });
  // S1：第 3 局真人镜像（住房紧跟随人口、食肆优先、原料/磨坊兜底）
  const seedPolicy = mkSeed({
    hutBuffer: 0, forestCap: 8,
    rules: [
      { type: 'hut', cap: 99 },
      { type: 'forest', cap: 3 }, { type: 'farm', cap: 2 }, { type: 'mill', cap: 2 },
      { type: 'eatery', cap: 8 },
      { type: 'farm', cap: 12 }, { type: 'forest', cap: 10 }, { type: 'mill', cap: 12 },
      { type: 'granary', cap: 3 }, { type: 'carpenter', cap: 3 }, { type: 'grocer', cap: 0 },
    ],
  });
  // S2：极限压住房 —— 只养够劳力的户，其余钱全砸 0.133 分/钱的 farm/forest/mill
  const seedPolicy2 = mkSeed({
    hutBuffer: 0, hutGate: 50, forestCap: 12,
    rules: [
      { type: 'forest', cap: 4 }, { type: 'farm', cap: 2 }, { type: 'mill', cap: 2 },
      { type: 'eatery', cap: 10 },
      { type: 'hut', cap: 99 },
      { type: 'farm', cap: 16 }, { type: 'forest', cap: 12 }, { type: 'mill', cap: 16 },
      { type: 'carpenter', cap: 4 }, { type: 'granary', cap: 2 }, { type: 'grocer', cap: 0 },
    ],
  });
  // S3：上一轮搜索收敛到的最优策略（L*=175），作为再精修的起点
  const seedPolicy3 = mkSeed({
    hutBuffer: 0, useHouse: false, houseMoney: 160, forestCap: 5, hutGate: 0,
    rules: [
      { type: 'eatery', cap: 3 }, { type: 'mill', cap: 11 }, { type: 'hut', cap: 99 },
      { type: 'granary', cap: 1 }, { type: 'house', cap: 0 }, { type: 'carpenter', cap: 4 },
      { type: 'forest', cap: 8 }, { type: 'grocer', cap: 3 }, { type: 'farm', cap: 13 },
    ],
  });
  for (const [nm, p] of [['D0-S1 真人镜像', seedPolicy], ['D0-S2 压住房', seedPolicy2], ['D0-S3 上轮最优(精修起点)', seedPolicy3]]) {
    const stx = freshState({});
    resetCursor();
    report(nm, playthrough(stx, makePolicyBot(p), {}));
    restore();
  }
  const SEEDS = [seedPolicy3, seedPolicy, seedPolicy2];

  // D1：随机策略搜索
  const TYPES = ['farm', 'forest', 'mill', 'eatery', 'granary', 'carpenter', 'grocer', 'house'];
  const rnd = (() => { let s = 20261017; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  const CAPRANGE = { farm: [2, 16], forest: [2, 14], mill: [2, 16], eatery: [2, 12], granary: [0, 4], carpenter: [0, 5], grocer: [0, 3], house: [0, 4] };
  function randomPolicy() {
    const order = [];
    const pool = [...TYPES];
    while (pool.length) order.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    const rules = order.map((t) => ({ type: t, cap: ri(...CAPRANGE[t]) }));
    // hut 规则插入随机位置
    const hutRules = { type: 'hut', cap: 99 };
    rules.splice(Math.floor(rnd() * (rules.length + 1)), 0, hutRules);
    return {
      hutBuffer: ri(0, 3), useHouse: rnd() < 0.5, houseMoney: pick([80, 100, 120, 160]),
      forestCap: ri(6, 14), hutGate: pick([0, 0, 30, 50, 70]),
      rules,
    };
  }
  function mutate(p) {
    const q = JSON.parse(JSON.stringify(p));
    const k = ri(0, 5);
    if (k === 0) q.hutBuffer = Math.max(0, Math.min(3, q.hutBuffer + pick([-1, 1])));
    else if (k === 1) q.useHouse = !q.useHouse;
    else if (k === 2) {
      const i = ri(0, q.rules.length - 1);
      const r = q.rules[i];
      if (r.type !== 'hut') r.cap = Math.max(0, Math.min(18, r.cap + pick([-2, -1, 1, 2])));
    } else if (k === 3) {
      const i = ri(0, q.rules.length - 1), j = ri(0, q.rules.length - 1);
      [q.rules[i], q.rules[j]] = [q.rules[j], q.rules[i]];
    } else if (k === 4) {
      const i = ri(0, q.rules.length - 1);
      if (q.rules[i].type !== 'hut') q.rules[i].type = pick(TYPES);
    } else {
      q.hutGate = pick([0, 0, 30, 50, 70]);
      q.forestCap = Math.max(4, Math.min(16, q.forestCap + pick([-2, 2])));
    }
    return q;
  }
  const evaluate = (p) => {
    const s = freshState({});
    resetCursor();
    const r = playthrough(s, makePolicyBot(p), { maxTicks: 900 });
    restore();
    return r;
  };
  const score = (r) => (r.levelAt[4] ?? 9999);

  let best = seedPolicy, bestR = null;
  const t0 = Date.now();
  let evals = 0;
  const RESTARTS = Number(process.env.SIM_RESTARTS ?? 16);
  const ITERS = Number(process.env.SIM_ITERS ?? 70);
  // 爬山 + 随机重启
  for (let restart = 0; restart < RESTARTS; restart++) {
    let cur = restart < SEEDS.length ? SEEDS[restart] : randomPolicy();
    let curR = evaluate(cur); evals++;
    for (let it = 0; it < ITERS; it++) {
      const cand = mutate(cur);
      const candR = evaluate(cand); evals++;
      if (score(candR) < score(curR)) { cur = cand; curR = candR; }
    }
    if (!bestR || score(curR) < score(bestR)) { best = cur; bestR = curR; }
    console.log(`  restart ${restart}: 当前最优 Lv4 = ${score(bestR)} tick  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log(JSON.stringify({ 搜索耗时秒: +((Date.now() - t0) / 1000).toFixed(1), 策略评估次数: evals }));

  // 用 exact 放置模式复核最优策略（保证与验收 bot 同一放置口径）
  PLACER = tryPlaceExact;
  const stF = freshState({});
  const finalR = playthrough(stF, makePolicyBot(best), {});
  report('D-BEST 最优策略（exact 模式复核）', finalR);
  console.log('  最优策略 = ' + JSON.stringify(best));
  console.log('  L*_bot = ' + finalR.levelAt[4] + ' tick');
  restore();

  // 对照：验收 bot 同样条件下
  const stV = freshState({});
  const vr = playthrough(stV, verificationBot, {});
  report('D-REF 验收 bot（对照）', vr);
  restore();
  console.log(JSON.stringify({
    结论: `验收 bot ${vr.levelAt[4]} tick vs 真实下限 L* ${finalR.levelAt[4]} tick`,
    bot高估倍数: +(vr.levelAt[4] / finalR.levelAt[4]).toFixed(2),
    建筑数: `${vr.final.buildings} vs ${finalR.final.buildings}`,
    花钱: `${Math.round(vr.moneySpent)} vs ${Math.round(finalR.moneySpent)}`,
  }));
}

// --- 模块 E：分钱比与边际分析 ---
if (arg === 'all' || arg === 'econ') {
  console.log('--- E. 分钱比：繁荣度本质是「铜钱的另一种货币」---');
  console.log(JSON.stringify(Object.fromEntries(
    Object.entries(BUILDINGS).map(([k, v]) => [v.name, {
      分: v.score, 钱: v.cost.money, 木: v.cost.wood,
      分每钱: +(v.score / v.cost.money).toFixed(3),
      劳力: v.workers,
      是否恒计分: v.workers === 0 && Object.keys(v.inputs).length === 0,
      产钱: v.outputs?.money ?? 0,
    }])
  )));
  console.log('--- E2. 恒计分（不受劳力/原料约束）建筑清单 ---');
  console.log(JSON.stringify(Object.entries(BUILDINGS)
    .filter(([, v]) => v.workers === 0 && Object.keys(v.inputs).length === 0)
    .map(([k, v]) => ({ id: k, name: v.name, 分: v.score, 钱: v.cost.money, 木: v.cost.wood, 地形限制: v.terrain ?? '无' }))));
}
