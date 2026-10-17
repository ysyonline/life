// T-P6-09 候选方案推演（只读脚本，不改 src/ 与 tests/）
// 目的：对 7 类候选杠杆逐一定量推演，给出 bot 推演 tick、估算真人 Lv4 tick、
//       副作用、不变量自检结论。
// 依赖：先跑 scratch/pacing-sim4.mjs star 得到 L* 最优策略，本脚本把该策略硬编码为 LSTAR_POLICY。
// 运行： node scratch/pacing-sim5.mjs
import { createInitialState } from '../src/core/state.js';
import { tick, housingCapacity, computeLevel } from '../src/core/simulation.js';
import { placeBuilding } from '../src/core/grid.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

const S = RULES.mapSize;
const BASE = {
  thresholds: [...RULES.unlockThresholds],
  money0: RULES.initialMoney,
  wood0: RULES.initialResources.wood,
  moveIn: RULES.moveInInterval,
  tax: RULES.tax.perHouseholdPerTick,
  idle: RULES.prosperityCoef.idle,
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

// ---- 放置：与验收用例逐字一致的扫描顺序（保证口径一致）----
function tryPlace(state, type) {
  const def = BUILDINGS[type];
  const [w, h] = def.size;
  // 预算预检（语义等价：买不起时 placeBuilding 必然失败，但可省掉整片扫描）
  if (state.money < def.cost.money || state.resources.wood < def.cost.wood) return false;
  for (let y = 0; y <= S - h; y++)
    for (let x = 0; x <= S - w; x++)
      if (placeBuilding(state, type, x, y).ok) return true;
  return false;
}
const countType = (state, t) => state.buildings.filter((b) => b.type === t).length;

// ---- 验收 bot ----
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

// ---- L* 策略 bot（由 scratch/pacing-sim4.mjs star 搜索得到，硬编码以便复现）----
// scratch/pacing-sim4.mjs star（1136 次策略评估的爬山搜索）收敛结果：L*=175 tick
// 终局 hut11 farm13 forest8 mill11 eatery1 granary1，21 户，花钱 805
export const LSTAR_POLICY = {
  hutBuffer: 0, useHouse: false, houseMoney: 160, forestCap: 5, hutGate: 0,
  rules: [
    { type: 'eatery', cap: 3 }, { type: 'mill', cap: 11 }, { type: 'hut', cap: 99 },
    { type: 'granary', cap: 1 }, { type: 'house', cap: 0 }, { type: 'carpenter', cap: 4 },
    { type: 'forest', cap: 8 }, { type: 'grocer', cap: 3 }, { type: 'farm', cap: 13 },
  ],
};
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
const LSTAR_BOT = makePolicyBot(LSTAR_POLICY);

// ---- 推演 ----
function playthrough(state, bot, { maxTicks = 4000, sustain = 0, sustainAt = null, scoreFormula = null } = {}) {
  const levelAt = { 2: null, 3: null, 4: null };
  let moneySpent = 0, sustainCount = 0, winTick = null, downgrades = 0, maxLevel = 1, maxPros = 0;
  const need = sustainAt ?? RULES.unlockThresholds[3];
  for (let i = 0; i < maxTicks; i++) {
    const before = state.money;
    bot(state);
    moneySpent += Math.max(0, before - state.money);
    tick(state);
    if (scoreFormula) { state.prosperity = scoreFormula(state); state.level = computeLevel(state.prosperity); }
    maxPros = Math.max(maxPros, state.prosperity);
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
    levelAt, moneySpent, winTick, downgrades, maxPros,
    final: {
      tick: state.tick, money: +state.money.toFixed(0), pop: state.population.count,
      cap: housingCapacity(state), buildings: state.buildings.length,
      breakdown: Object.fromEntries(Object.keys(BUILDINGS).map((k) => [k, countType(state, k)]).filter(([, v]) => v > 0)),
      prosperity: +state.prosperity.toFixed(1),
    },
  };
}

// 恒计分上限公式（farm/forest/granary 合计封顶 capN）
function capConstant(capN, rawScore = { farm: null, forest: null, granary: null }) {
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

function run(label, ov, { bot = 'both', sustain = 0, sustainAt = null, scoreFormula = null, maxTicks = 4000 } = {}) {
  const out = { 场景: label };
  if (bot === 'both' || bot === 'verif') {
    const m0 = applyOverrides(ov);
    const st = createInitialState(); st.money = m0;
    const r = playthrough(st, verificationBot, { maxTicks, sustain, sustainAt, scoreFormula });
    out['验收bot_Lv2'] = r.levelAt[2]; out['验收bot_Lv3'] = r.levelAt[3]; out['验收bot_Lv4'] = r.levelAt[4];
    if (sustain) out['验收bot_维持通关'] = r.winTick;
    out['验收bot_终局'] = r.final;
    restore();
  }
  if (bot === 'both' || bot === 'lstar') {
    const m0 = applyOverrides(ov);
    const st = createInitialState(); st.money = m0;
    const r = playthrough(st, LSTAR_BOT, { maxTicks, sustain, sustainAt, scoreFormula });
    out['L*_Lv2'] = r.levelAt[2]; out['L*_Lv3'] = r.levelAt[3]; out['L*_Lv4'] = r.levelAt[4];
    if (sustain) out['L*_维持通关'] = r.winTick;
    out['L*_花钱'] = Math.round(r.moneySpent);
    out['L*_终局'] = r.final;
    restore();
  }
  console.log(JSON.stringify(out));
  return out;
}

// ============================================================
// 0. 硬约束：初始资金下限（验收「上界证明」用例要求 Lv1 预算内最大繁荣度 ≥ Lv2 阈值）
// ============================================================
function lv1Knapsack(budget, scores) {
  let best = 0;
  const B = BUILDINGS;
  for (let hut = 0; hut <= 24; hut++)
    for (let farm = 0; farm <= 20; farm++)
      for (let forest = 0; forest <= 20; forest++)
        for (let mill = 0; mill <= 12; mill++) {
          const m = hut * B.hut.cost.money + farm * B.farm.cost.money + forest * B.forest.cost.money + mill * B.mill.cost.money;
          if (m > budget) continue;
          const s = hut * (scores?.hut ?? B.hut.score) + farm * (scores?.farm ?? B.farm.score)
            + forest * (scores?.forest ?? B.forest.score) + mill * (scores?.mill ?? B.mill.score);
          best = Math.max(best, s);
        }
  return best;
}
console.log('--- 0. 硬约束扫描：初始资金 vs 验收「上界证明」（要求 ≥ Lv2 阈值）---');
for (const m of [100, 120, 150, 160, 180, 200, 240]) {
  console.log(JSON.stringify({ 初始资金: m, Lv1预算内最大繁荣度: lv1Knapsack(m), Lv2阈值: 20, 用例通过: lv1Knapsack(m) >= 20 }));
}

console.log('--- 0b. 若同时把农田/林场降为 1 分，上界证明是否仍过 ---');
for (const m of [150, 180, 200, 240]) {
  console.log(JSON.stringify({ 初始资金: m, 农田林场1分时最大繁荣度: lv1Knapsack(m, { farm: 1, forest: 1 }), 用例通过: lv1Knapsack(m, { farm: 1, forest: 1 }) >= 20 }));
}

// ============================================================
// 1~7. 候选杠杆单点推演
// ============================================================
console.log('\n--- 1. 基线（现网数值，用于对齐）---');
run('1.0 现网基线', {});

console.log('\n--- 2. C1 降初始资金 / 初始木（存量杠杆）---');
run('C1a 钱240→150 木60→40', { money0: 150, wood0: 40 });
run('C1b 钱240→150 木60→60', { money0: 150 });
run('C1c 钱240→120（预期触发上界证明失败）', { money0: 120 });

console.log('\n--- 3. C2 降商业收入 / 递减 ---');
run('C2a 食肆 3→2 钱/tick', { moneyOut: { eatery: 2 } });
run('C2b 食肆 3→1.5、杂货摊 5→3', { moneyOut: { eatery: 1.5, grocer: 3 } });
run('C2c 市税 0.05→0.03', { tax: 0.03 });
run('C2d 商业递减：第 n 座食肆产出 3×max(0.4,1-0.1(n-1))', { moneyOut: { eatery: 2 } });

console.log('\n--- 4. C3 提高造价 ---');
run('C3a 全部造价 ×1.5', { costMulAll: 1.5 });
run('C3b 全部造价 ×2', { costMulAll: 2 });
run('C3c 仅计分类（农田/林场/磨坊/木匠铺/粮仓）×2', {
  costMul: { farm: 2, forest: 2, mill: 2, carpenter: 2, granary: 2 },
});

console.log('\n--- 5. C4 提高阈值 ---');
run('C4a Lv3 50→70、Lv4 100→150', { thresholds: [0, 20, 70, 150] });
run('C4b Lv3 50→70、Lv4 100→200', { thresholds: [0, 20, 70, 200] });
run('C4c Lv3 50→60、Lv4 100→250', { thresholds: [0, 20, 60, 250] });
run('C4d Lv4 100→300', { thresholds: [0, 20, 60, 300] });

console.log('\n--- 6. C5 削恒计分 ---');
run('C5a 农田/林场 2→1 分', { score: { farm: 1, forest: 1 } });
run('C5b 恒计分（农田+林场+粮仓）合计封顶 20', { score: {} }, { scoreFormula: null });
run('C5b-cap20 恒计分封顶 20', {}, { scoreFormula: capConstant(20) });
run('C5c-cap12 恒计分封顶 12', {}, { scoreFormula: capConstant(12) });
run('C5d 农田/林场 2→1 且 粮仓 2→0', { score: { farm: 1, forest: 1, granary: 0 } });

console.log('\n--- 7. C6 放慢迁入 ---');
run('C6a 迁入间隔 5→8', { moveIn: 8 });
run('C6b 迁入间隔 5→10', { moveIn: 10 });
run('C6c 迁入间隔 5→6', { moveIn: 6 });

console.log('\n--- 8. C7 结构性：维持型通关 ---');
run('C7a Lv4=繁荣≥100 持续 300 tick', {}, { sustain: 300, sustainAt: 100 });
run('C7b Lv4=繁荣≥100 持续 600 tick', {}, { sustain: 600, sustainAt: 100 });
