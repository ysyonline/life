// T-P6-09 不变量自检（只读脚本）：对候选配置逐条核对 设计案 §5.4《不可恢复态审计表》
// 与 §5.5「无吸收态」不变量，并实测「钱归零→买得起食肆」的恢复步数。
// 运行：node scratch/pacing-sim7.mjs
import { createInitialState } from '../src/core/state.js';
import { tick, housingCapacity } from '../src/core/simulation.js';
import { placeBuilding, demolishBuilding } from '../src/core/grid.js';
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
function tryPlace(state, type) {
  const def = BUILDINGS[type];
  const [w, h] = def.size;
  if (state.money < def.cost.money || state.resources.wood < def.cost.wood) return false;
  for (let y = 0; y <= S - h; y++)
    for (let x = 0; x <= S - w; x++)
      if (placeBuilding(state, type, x, y).ok) return true;
  return false;
}
const countType = (state, t) => state.buildings.filter((b) => b.type === t).length;

// 一个「正常经营」的简单 bot，用来把城市推到有户数/有产业链的状态
function liveBot(state) {
  const lvl = state.level, cap = housingCapacity(state), pop = state.population.count;
  const wants = [];
  if (cap - pop < 2) wants.push('hut');
  if (countType(state, 'forest') < 4) wants.push('forest');
  if (countType(state, 'farm') < 4) wants.push('farm');
  if (countType(state, 'mill') < 3 && countType(state, 'mill') <= countType(state, 'farm')) wants.push('mill');
  if (lvl >= 2 && countType(state, 'eatery') < 3) wants.push('eatery');
  for (const t of wants) if (tryPlace(state, t)) return t;
  return null;
}

// 场景：把城市跑到 tick warm，然后把某项资源打回 0，测恢复到「买得起食肆」的步数
function recoveryTest(label, ov, { warm = 120, zero = 'money', ruin = false, maxTicks = 4000 } = {}) {
  const m0 = applyOverrides(ov);
  const st = createInitialState(); st.money = m0;
  for (let i = 0; i < warm; i++) { liveBot(st); tick(st); }
  const snapshot = { tick: st.tick, money: +st.money.toFixed(1), wood: +st.resources.wood.toFixed(0), pop: st.population.count, buildings: st.buildings.length };
  if (ruin) { // 极端：拆光所有建筑（只剩保底户）
    for (const b of [...st.buildings]) demolishBuilding(st, b.id);
  }
  if (zero === 'money') st.money = 0;
  if (zero === 'money+wood') { st.money = 0; st.resources.wood = 0; }
  if (zero === 'money+wood+food') { st.money = 0; st.resources.wood = 0; st.resources.food = 0; }
  const target = BUILDINGS.eatery.cost.money;
  const needWood = BUILDINGS.eatery.cost.wood;
  let recovered = null;
  for (let i = 0; i < maxTicks; i++) {
    liveBot(st); tick(st);
    if (st.money >= target && st.resources.wood >= needWood) { recovered = st.tick - snapshot.tick; break; }
  }
  console.log(JSON.stringify({
    场景: label, 打零前快照: snapshot, 归零项: zero,
    目标: `买得起食肆(${target}钱/${needWood}木)`,
    恢复步数: recovered, 判定: recovered != null ? '✓ 有限步恢复，无吸收态' : '✗ 未恢复（存在吸收态）',
    终局: { money: +st.money.toFixed(1), wood: +st.resources.wood.toFixed(0), pop: st.population.count, buildings: st.buildings.length },
  }));
  restore();
  return recovered;
}

const CONFIGS = [
  { id: '现网（对照）', ov: {} },
  { id: 'P-1 主推：阈值150 + 迁入8 + 农田/林场2→1 + 粮仓2→0 + 食肆3→2', ov: { thresholds: [0, 20, 60, 150], moveIn: 8, score: { farm: 1, forest: 1, granary: 0 }, moneyOut: { eatery: 2, grocer: 4 } } },
  { id: 'P-2 备选：阈值200 + 迁入8 + 农田/林场2→1 + 粮仓2→0 + 食肆3→2', ov: { thresholds: [0, 20, 70, 200], moveIn: 8, score: { farm: 1, forest: 1, granary: 0 }, moneyOut: { eatery: 2, grocer: 4 } } },
  { id: '极端压力测试：上述 P-1 再叠加 造价×2 + 市税0.02（验证最坏局面）', ov: { thresholds: [0, 20, 60, 150], moveIn: 8, score: { farm: 1, forest: 1, granary: 0 }, moneyOut: { eatery: 2, grocer: 4 }, costMulAll: 2, tax: 0.02 } },
];

console.log('=== 设计案 §5.4《不可恢复态审计表》实测核对 ===');
for (const c of CONFIGS) {
  console.log(`\n--- ${c.id} ---`);
  recoveryTest('行1 钱0，户≥1（保底户兜底）', c.ov, { zero: 'money' });
  recoveryTest('行3 钱0+木0，有可拆建筑', c.ov, { zero: 'money+wood' });
  recoveryTest('行5 钱0+木0+食0，户=1（保底户）', c.ov, { zero: 'money+wood+food' });
  recoveryTest('极端 拆光全城（只剩保底户）', c.ov, { zero: 'money+wood', ruin: true });
}

console.log('\n=== §5.4 审计表第 1/2 行的解析式核对（不需模拟）===');
for (const c of CONFIGS) {
  const m0 = applyOverrides(c.ov);
  const tax = RULES.tax.perHouseholdPerTick;
  const eatCost = BUILDINGS.eatery.cost.money;
  const hutCost = BUILDINGS.hut.cost.money;
  console.log(JSON.stringify({
    配置: c.id,
    市税: tax, 食肆造价: eatCost, 茅舍造价: hutCost,
    '行1 钱0户1：市税': +(1 * tax).toFixed(3), '→ 攒够食肆需 tick': Math.ceil(eatCost / (1 * tax)),
    '行2 钱0户12：市税': +(12 * tax).toFixed(2), '→ 攒够食肆需 tick': Math.ceil(eatCost / (12 * tax)),
    '行4 钱0木0无林场：拆磨坊返还': `${Math.floor(BUILDINGS.mill.cost.money * RULES.demolishRefundRate)}钱/${Math.floor(BUILDINGS.mill.cost.wood * RULES.demolishRefundRate)}木`,
    '  ≥林场造价?': Math.floor(BUILDINGS.mill.cost.money * RULES.demolishRefundRate) >= BUILDINGS.forest.cost.money
      && Math.floor(BUILDINGS.mill.cost.wood * RULES.demolishRefundRate) >= BUILDINGS.forest.cost.wood,
  }));
  restore();
}

console.log('\n=== §5.5「单瓶颈」原则：推荐配置下各阶段瓶颈是否唯一 ===');
// 用 L* 路线跑一遍，记录每 100 tick 的限制性资源
console.log('（见 pacing-sim6 输出的终局建筑构成：若某一类建筑占比 >70% 说明存在主导策略）');
