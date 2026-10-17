// T-P6-09 阻塞项复核：用「逐字复制的验收 bot」跑 P-1′ 与阈值边界
// 背景：engineering-lead 与 quality-lead 两套独立 harness 都报「Lv4 阈值 150 时验收 bot 永久卡死」。
//       本脚本用与 tests/verification/progression.test.js 逐字一致的 bot 复核，
//       并同时跑 V1「注入 100000 铜钱」对照用例（QA 报它更苛刻：上限只有 85.8）。
// 运行： node scratch/pacing-sim10.mjs          # 验收 bot 矩阵（默认）
//        node scratch/pacing-sim10.mjs star     # 再对通过的配置求 L*_human（N=∞）
import { createInitialState } from '../src/core/state.js';
import { tick, housingCapacity, computeLevel } from '../src/core/simulation.js';
import { placeBuilding } from '../src/core/grid.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

const S = RULES.mapSize;
const BASE = {
  thresholds: [...RULES.unlockThresholds], money0: RULES.initialMoney, wood0: RULES.initialResources.wood,
  moveIn: RULES.moveInInterval, tax: RULES.tax.perHouseholdPerTick,
  cost: Object.fromEntries(Object.entries(BUILDINGS).map(([k, v]) => [k, { ...v.cost }])),
  score: Object.fromEntries(Object.entries(BUILDINGS).map(([k, v]) => [k, v.score])),
};
function applyOverrides(ov = {}) {
  RULES.unlockThresholds = ov.thresholds ? [...ov.thresholds] : [...BASE.thresholds];
  RULES.initialResources.wood = ov.wood0 ?? BASE.wood0;
  RULES.moveInInterval = ov.moveIn ?? BASE.moveIn;
  RULES.tax.perHouseholdPerTick = ov.tax ?? BASE.tax;
  for (const [k, c] of Object.entries(BASE.cost)) {
    const mk = ov.costMul?.[k] ?? ov.costMulAll ?? 1;
    BUILDINGS[k].cost.money = Math.round(c.money * mk); BUILDINGS[k].cost.wood = Math.round(c.wood * mk);
  }
  for (const [k, s] of Object.entries(BASE.score)) BUILDINGS[k].score = ov.score?.[k] ?? s;
  return ov.money0 ?? BASE.money0;
}
function restore() {
  RULES.unlockThresholds = [...BASE.thresholds];
  RULES.initialResources.wood = BASE.wood0;
  RULES.moveInInterval = BASE.moveIn;
  RULES.tax.perHouseholdPerTick = BASE.tax;
  for (const [k, c] of Object.entries(BASE.cost)) { BUILDINGS[k].cost.money = c.money; BUILDINGS[k].cost.wood = c.wood; }
  for (const [k, s] of Object.entries(BASE.score)) BUILDINGS[k].score = s;
}

// ---- 与 progression.test.js 逐字一致的 tryPlace / botBuild / playthrough ----
function tryPlace(state, type) {
  const def = BUILDINGS[type];
  const [w, h] = def.size;
  for (let y = 0; y <= S - h; y++)
    for (let x = 0; x <= S - w; x++)
      if (placeBuilding(state, type, x, y).ok) return true;
  return false;
}
const countType = (state, t) => state.buildings.filter((b) => b.type === t).length;
function botBuild(state) {
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
function playthrough(state, maxTicks, scoreFormula = null) {
  const levelAt = { 2: null, 3: null, 4: null };
  let maxProsperity = 0, maxPop = 0;
  for (let i = 0; i < maxTicks; i++) {
    botBuild(state);
    tick(state);
    if (scoreFormula) { state.prosperity = scoreFormula(state); state.level = computeLevel(state.prosperity); }
    maxProsperity = Math.max(maxProsperity, state.prosperity);
    maxPop = Math.max(maxPop, state.population.count);
    for (const lv of [2, 3, 4]) if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level >= 4) break;
  }
  return { levelAt, maxProsperity, finalLevel: state.level, maxPop,
    buildings: state.buildings.length, pop: state.population.count, money: +state.money.toFixed(0) };
}

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

function run(ov, { injected = false, maxTicks = 2000, scoreFormula = null } = {}) {
  const m0 = applyOverrides(ov);
  const state = createInitialState();
  state.money = injected ? 100000 : m0;
  const r = playthrough(state, maxTicks, scoreFormula);
  restore();
  return r;
}

const CONFIGS = [
  { id: 'BASE', name: '现网基线（校准用，应 12/315/515）', ov: {} },
  { id: 'CAP24', name: '仅 恒计分封顶 24', ov: {}, sf: 'cap24' },
  { id: 'CAP24_T120', name: '封顶24 + 阈值 60/120', ov: { thresholds: [0, 20, 60, 120] }, sf: 'cap24' },
  { id: 'CAP24_T130', name: '封顶24 + 阈值 60/130', ov: { thresholds: [0, 20, 60, 130] }, sf: 'cap24' },
  { id: 'CAP24_T140', name: '封顶24 + 阈值 60/140', ov: { thresholds: [0, 20, 60, 140] }, sf: 'cap24' },
  { id: 'CAP24_T150', name: '封顶24 + 阈值 60/150（= 我的主推 P-1′）', ov: { thresholds: [0, 20, 60, 150] }, sf: 'cap24' },
  { id: 'CAP20_T120', name: '封顶20 + 阈值 60/120', ov: { thresholds: [0, 20, 60, 120] }, sf: 'cap20' },
  { id: 'SC1_T120', name: '农田/林场2→1 + 阈值 60/120', ov: { thresholds: [0, 20, 60, 120], score: { farm: 1, forest: 1 } } },
  { id: 'SC1_T100', name: '农田/林场2→1 + 阈值不动', ov: { score: { farm: 1, forest: 1 } } },
  { id: 'T120', name: '仅 阈值 60/120（不削恒计分）', ov: { thresholds: [0, 20, 60, 120] } },
  { id: 'T130', name: '仅 阈值 60/130（不削恒计分）', ov: { thresholds: [0, 20, 60, 130] } },
  { id: 'T140', name: '仅 阈值 60/140（不削恒计分）', ov: { thresholds: [0, 20, 60, 140] } },
  { id: 'T150', name: '仅 阈值 60/150（不削恒计分）', ov: { thresholds: [0, 20, 60, 150] } },
  { id: 'CAP24_T120_M8', name: '封顶24 + 阈值60/120 + 迁入8', ov: { thresholds: [0, 20, 60, 120], moveIn: 8 }, sf: 'cap24' },
];

const mode = process.argv[2] ?? 'matrix';
if (mode === 'matrix') {
  console.log('--- 验收 bot 矩阵（bot 逐字复制自 progression.test.js；maxTicks=\${MT}）---');
  for (const c of CONFIGS) {
    const sf = c.sf === 'cap24' ? capConstant(24) : c.sf === 'cap20' ? capConstant(20) : null;
    const a = run(c.ov, { scoreFormula: sf });
    const b = run(c.ov, { injected: true, scoreFormula: sf });
    console.log(JSON.stringify({
      配置: c.id, 名称: c.name,
      'V2实测': { Lv2: a.levelAt[2], Lv3: a.levelAt[3], Lv4: a.levelAt[4], 最高分: +a.maxProsperity.toFixed(2),
        终局: { 建筑: a.buildings, 户: a.pop, 峰值户: a.maxPop } },
      'V2断言': a.levelAt[4] != null ? '✅ PASS' : '❌ FAIL',
      'V1注入铜钱': { Lv4: b.levelAt[4], 最高分: +b.maxProsperity.toFixed(2) },
      'V1断言': b.levelAt[4] != null ? '✅ PASS' : '❌ FAIL',
    }));
  }
}
