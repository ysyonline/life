// T-P6-11 Step 2：P-1′ 终版双 Gate 探针（新验收 bot，迁入 5 口径）
//
// P-1′ 终版 = 恒计分封顶 24 + Lv3 50→60 + Lv4 100→150 + 迁入维持 5（不动）
// 注意：02 文档 §8.9 的 144.2 读数是 @迁入8 口径，本脚本实测迁入 5 终版。
//
// Gate 定义（与 tests/verification/progression.test.js 的两条用例同构）：
//   V2 Gate：初始资源（240 钱/60 木/20 粮/20 食/0 户）自然通关到 Lv4（2000 tick 内）
//   V1 Gate：注入铜钱 100000，隔离验证 Lv2→Lv4 链路（2000 tick 内）
//
// 纪律：只读 src/config + 内存覆盖（跑完 restore），不改任何 src/ 与 tests/ 文件。
// 基线门槛：新 bot 在现网配置下必须复现 12/280/480 与 V1 106（Step 1 实测值）。
//
// 运行： node scratch/pacing-sim12.mjs            # P-1′ 终版双 Gate + 终局构成 + 稀缺帧诊断
//        node scratch/pacing-sim12.mjs matrix     # 边界矩阵 Lv4×封顶 双 Gate 扫描（V1 红时用）
import { createInitialState } from '../src/core/state.js';
import { tick, housingCapacity, computeCaps, computeLevel } from '../src/core/simulation.js';
import { placeBuilding, demolishBuilding } from '../src/core/grid.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

// ---- 配置快照与覆盖（内存覆盖，跑完 restore）----
const BASE = {
  thresholds: [...RULES.unlockThresholds],
  moveIn: RULES.moveInInterval,
  score: Object.fromEntries(Object.entries(BUILDINGS).map(([k, v]) => [k, v.score])),
};
function applyOverrides(ov = {}) {
  RULES.unlockThresholds = [...(ov.thresholds ?? BASE.thresholds)];
  RULES.moveInInterval = ov.moveIn ?? BASE.moveIn;
  for (const [k, s] of Object.entries(BASE.score)) BUILDINGS[k].score = s;
}
function restore() {
  RULES.unlockThresholds = [...BASE.thresholds];
  RULES.moveInInterval = BASE.moveIn;
  for (const [k, s] of Object.entries(BASE.score)) BUILDINGS[k].score = s;
}

// ---- 放置（与验收测试同款：全图扫描第一个可放点）----
const S = RULES.mapSize;
function tryPlace(state, type) {
  const def = BUILDINGS[type];
  const [w, h] = def.size;
  for (let y = 0; y <= S - h; y++)
    for (let x = 0; x <= S - w; x++)
      if (placeBuilding(state, type, x, y).ok) return true;
  return false;
}
const countType = (state, t) => state.buildings.filter((b) => b.type === t).length;

// ---- 新验收 bot（与 tests/verification/progression.test.js 的 botBuild 逐字同款）----
function botBuild(state) {
  const lvl = state.level;
  const cap = housingCapacity(state);
  const pop = state.population.count;
  const c = countType;
  const farms = c(state, 'farm'), mills = c(state, 'mill'), eat = c(state, 'eatery');
  const carp = c(state, 'carpenter');

  const foodNet = mills * 1 - eat * 1 - pop * RULES.foodPerHouseholdPerTick;
  if (foodNet < 0 && state.resources.food < 15 && eat > 0) {
    const victim = state.buildings.find((b) => b.type === 'eatery');
    if (victim && demolishBuilding(state, victim.id).ok) return 'demolish:eatery';
  }
  if (foodNet < 0 && state.resources.food < 15 && eat === 0 && carp > 0) {
    const victim = state.buildings.find((b) => b.type === 'carpenter');
    if (victim && demolishBuilding(state, victim.id).ok) return 'demolish:carpenter';
  }

  const wants = [];
  if (cap - pop < 2) wants.push(lvl >= 3 && state.money > 120 ? 'house' : 'hut');
  if (state.resources.food < 20 || foodNet < 1) {
    if (farms >= mills + 1) wants.push('mill');
    else wants.push('farm');
  }
  if (state.resources.grain < 10 && farms < mills + 2) wants.push('farm');
  if (state.resources.wood < 30) wants.push('forest');
  if (lvl >= 2 && foodNet > 2 && state.money > 120) wants.push('eatery');
  if (lvl >= 2 && state.resources.grain > computeCaps(state).grain * 0.8) wants.push('granary');
  if (lvl >= 3 && state.resources.wood > 60) wants.push('carpenter');
  if (lvl >= 4 && state.resources.goods > 4) wants.push('grocer');
  if (cap - pop < 4) wants.push(lvl >= 3 ? 'house' : 'hut');

  for (const t of wants) if (tryPlace(state, t)) return t;
  return null;
}

// ---- 恒计分封顶公式（P-1′ 候选公式，与 02 文档 §8.9 探针同款：
//      working 含恒计分建筑分值，再减去超出封顶的部分 ⇒ 农田+林场+粮仓合计封顶 capN）----
function capConstant(capN) {
  return (state) => {
    const c = RULES.prosperityCoef;
    let working = 0, housingScore = 0, housingCap = 0, constant = 0;
    for (const b of state.buildings) {
      const def = BUILDINGS[b.type];
      if (def.capacity > 0) { housingScore += def.score; housingCap += def.capacity; continue; }
      working += def.score * (b.idle ? c.idle : c.active);
      if (['farm', 'forest', 'granary'].includes(b.type)) constant += def.score;
    }
    const occ = housingCap > 0 ? Math.min(1, state.population.count / housingCap) : 0;
    return working - Math.max(0, constant - capN) + housingScore * occ;
  };
}

// ---- 推演（含 Lv3→Lv4 窗口稀缺帧统计，为 N2 立项留数据）----
function run({ thresholds, moveIn = 5, capPassive = null, maxTicks = 2000, injectMoney = false }) {
  applyOverrides({ thresholds, moveIn });
  const state = createInitialState();
  if (injectMoney) state.money = 100000;
  const sf = capPassive != null ? capConstant(capPassive) : null;
  const levelAt = { 2: null, 3: null, 4: null };
  let maxP = 0;
  const win = { frames: 0, noScarcity: 0, laborGap: 0, materialGap: 0, housingFull: 0, foodLow: 0 };
  for (let i = 0; i < maxTicks; i++) {
    botBuild(state);
    tick(state);
    if (sf) {
      state.prosperity = sf(state);
      state.level = computeLevel(state.prosperity);
      state.maxLevel = Math.max(state.maxLevel ?? state.level, state.level);
    }
    maxP = Math.max(maxP, state.prosperity);
    // Lv3→Lv4 窗口稀缺帧统计（N2 数据）
    const inWin = state.tick >= (levelAt[3] ?? Infinity) && state.tick <= (levelAt[4] ?? Infinity);
    if (inWin && levelAt[3] != null && state.level < 4) {
      win.frames++;
      const idleLabor = state.buildings.some((b) => b.idle && b.idleReason === 'labor');
      const idleMat = state.buildings.some((b) => b.idle && b.idleReason === 'material');
      const vacant = housingCapacity(state) - state.population.count;
      if (idleLabor) win.laborGap++;
      if (idleMat) win.materialGap++;
      if (vacant <= 0) win.housingFull++;
      if (state.resources.food <= 10) win.foodLow++;
      if (!idleLabor && !idleMat && vacant > 0 && state.resources.food > 10) win.noScarcity++;
    }
    for (const lv of [2, 3, 4]) if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level >= 4) break;
  }
  const bd = {};
  for (const b of state.buildings) bd[b.type] = (bd[b.type] ?? 0) + 1;
  // 终局构成：恒计分（封顶后）/ 住房 / 各运转建筑分值占比
  let constant = 0;
  for (const t of ['farm', 'forest', 'granary']) constant += (bd[t] ?? 0) * BUILDINGS[t].score;
  if (capPassive != null) constant = Math.min(constant, capPassive);
  let housing = 0, hcap = 0;
  for (const t of ['hut', 'house']) { housing += (bd[t] ?? 0) * BUILDINGS[t].score; hcap += (bd[t] ?? 0) * BUILDINGS[t].capacity; }
  const occ = hcap > 0 ? Math.min(1, state.population.count / hcap) : 0;
  housing = housing * occ;
  const parts = { 恒计分: constant, 住房: housing };
  for (const t of ['mill', 'carpenter', 'eatery', 'grocer']) if (bd[t]) parts[t] = bd[t] * BUILDINGS[t].score;
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  restore();
  return {
    lv2: levelAt[2], lv3: levelAt[3], lv4: levelAt[4], maxP: +maxP.toFixed(2),
    pop: state.population.count, buildings: state.buildings.length, breakdown: bd,
    prosperityParts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, +v.toFixed(1)])),
    constantShare: total > 0 ? +(constant / total).toFixed(3) : null,
    win: { frames: win.frames, noScarcity: win.frames ? +(win.noScarcity / win.frames).toFixed(3) : null,
      laborGap: win.frames ? +(win.laborGap / win.frames).toFixed(3) : null,
      materialGap: win.frames ? +(win.materialGap / win.frames).toFixed(3) : null,
      housingFull: win.frames ? +(win.housingFull / win.frames).toFixed(3) : null,
      foodLow: win.frames ? +(win.foodLow / win.frames).toFixed(3) : null },
  };
}

const mode = process.argv[2] ?? 'final';

// ---- 0. 基线门槛：新 bot 现网配置复现 12/280/480 与 V1 106 ----
console.log('--- 0. 新 bot 基线复现（现网 20/50/100 迁入5，期望 V2 12/280/480、V1 106）---');
const b1 = run({ thresholds: [0, 20, 50, 100] });
const b2 = run({ thresholds: [0, 20, 50, 100], injectMoney: true });
console.log(JSON.stringify({ V2: [b1.lv2, b1.lv3, b1.lv4], V1_Lv4: b2.lv4 }));
if (b1.lv4 !== 480 || b2.lv4 !== 106) { console.error('新 bot 基线复现失败，中止！'); process.exit(1); }

if (mode === 'final') {
  // ---- 1. P-1′ 终版双 Gate（封顶24 + 60/150 + 迁入5）----
  console.log('--- 1. P-1′ 终版双 Gate（封顶24，阈值 20/60/150，迁入 5）---');
  for (const [label, cfg] of [
    ['V2 初始资源', { thresholds: [0, 20, 60, 150], capPassive: 24 }],
    ['V1 注入铜钱', { thresholds: [0, 20, 60, 150], capPassive: 24, injectMoney: true }],
  ]) {
    const r = run(cfg);
    console.log(JSON.stringify({
      gate: label, Lv2: r.lv2, Lv3: r.lv3, Lv4: r.lv4 ?? '❌未到达', 最高繁荣: r.maxP,
      判定: r.lv4 != null ? '✅绿' : '❌红',
      终局: { 户: r.pop, 建筑: r.buildings, 构成: r.breakdown },
      繁荣构成: r.prosperityParts, 恒计分占比: r.constantShare,
    }));
    if (r.win.frames > 0) {
      console.log(JSON.stringify({ gate: label, Lv3到Lv4窗口: r.win }));
    }
  }
}

if (mode === 'matrix') {
  // ---- 2. 边界矩阵：Lv4 阈值 × 封顶，双 Gate 读数 ----
  console.log('--- 2. 边界矩阵（Lv3=60，迁入=5，新 bot 双 Gate）---');
  console.log('表头: 封顶, Lv4阈值 | V2: Lv2/Lv3/Lv4/最高繁荣 | V1: Lv4/最高繁荣 | 双Gate判定');
  for (const cap of [24, 26, 28, 30]) {
    for (const lv4 of [130, 135, 140, 145, 150]) {
      const v2 = run({ thresholds: [0, 20, 60, lv4], capPassive: cap });
      const v1 = run({ thresholds: [0, 20, 60, lv4], capPassive: cap, injectMoney: true });
      const ok2 = v2.lv4 != null, ok1 = v1.lv4 != null;
      console.log(JSON.stringify({
        封顶: cap, Lv4阈值: lv4,
        V2: { Lv2: v2.lv2, Lv3: v2.lv3, Lv4: v2.lv4 ?? '❌', 最高繁荣: v2.maxP },
        V1: { Lv4: v1.lv4 ?? '❌', 最高繁荣: v1.maxP },
        判定: ok2 && ok1 ? '✅双绿' : ok2 ? '❌V1红' : '❌V2红',
      }));
    }
  }
}
