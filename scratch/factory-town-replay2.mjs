// T-P6-11b-3/4：工厂镇路线独立复放（最小 harness，不 import sim11 任何代码）
//
// 策略来源：scratch/factory-town-policy.txt（sim11 SEED_OFF=1003 打印的策略，语义已解读）
// 本脚本用自己的实现复刻该策略语义，实测：
//   ① O6′ 口径（封顶26 + 20/60/145 + 迁入5）到 Lv4 的 tick —— 对照 sim11 的 226
//   ② 现网基线（20/50/100，标准公式）到 Lv4 的 tick —— 对照设计侧的 181
//   ③ N=∞（每 tick 可建多座，与 sim11 同节流）与 N=1（验收 bot 节流）两种口径都测
//   ④ 脆弱性探针：3 次扰动（2×10-tick 停建 + 1×多建粮仓）
//
// 纪律：只读 src/config + 内存覆盖（跑完 restore），不改任何 src/tests/docs 文件。
import { createInitialState } from '../src/core/state.js';
import { tick, housingCapacity, computeLevel } from '../src/core/simulation.js';
import { placeBuilding, demolishBuilding } from '../src/core/grid.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

const S = RULES.mapSize;
const BASE = { thresholds: [...RULES.unlockThresholds], moveIn: RULES.moveInInterval };
function apply(ov = {}) {
  RULES.unlockThresholds = [...(ov.thresholds ?? BASE.thresholds)];
  RULES.moveInInterval = ov.moveIn ?? BASE.moveIn;
}
function restore() {
  RULES.unlockThresholds = [...BASE.thresholds];
  RULES.moveInInterval = BASE.moveIn;
}

function tryPlace(state, type) {
  const def = BUILDINGS[type];
  const [w, h] = def.size;
  for (let y = 0; y <= S - h; y++)
    for (let x = 0; x <= S - w; x++)
      if (placeBuilding(state, type, x, y).ok) return true;
  return false;
}
const countType = (state, t) => state.buildings.filter((b) => b.type === t).length;

// 恒计分封顶公式（与 pacing-sim12 同款：working 含恒计分建筑，减去超出封顶部分）
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

// ---- 工厂镇策略（按 factory-town-policy.txt 的语义独立实现，与 sim11 makePolicyBot 语义逐条对齐）----
// spendFloor=60 / forestCap=7（wood<10 且 forest<7 补林场）/ hutBuffer=3 hutGate=50（vacant≤3 且 money>50 建茅舍，不建瓦屋）
// 优先级 wants 列表（先 forest 补充，再按 rules 顺序追加，第一个可放的胜出）：
//   carpenter≤4 → forest≤6 → eatery≤19 → hut∞ → mill≤25 → grocer≤2 → house≤8 → carpenter≤9 → farm≤26
// 门槛：eatery 需 Lv2+food>12；mill 需 mill≤farm；grocer 需 Lv4；carpenter 需 Lv3
function makeFactoryTownPolicy() {
  const RULES_ORDER = [
    { type: 'carpenter', cap: 4 },
    { type: 'forest', cap: 6 },
    { type: 'eatery', cap: 19 },
    { type: 'hut', cap: Infinity },
    { type: 'mill', cap: 25 },
    { type: 'grocer', cap: 2 },
    { type: 'house', cap: 8 },
    { type: 'carpenter', cap: 9 },
    { type: 'farm', cap: 26 },
  ];
  return function policyStep(state) {
    if (state.money < 60) return null; // spendFloor
    const lvl = state.level, cap = housingCapacity(state), pop = state.population.count;
    const wants = [];
    if (state.resources.wood < 10 && countType(state, 'forest') < 7) wants.push('forest');
    for (const r of RULES_ORDER) {
      const n = countType(state, r.type);
      if (r.type === 'hut') {
        if (cap - pop <= 3 && state.money > 50) wants.push('hut'); // useHouse=false
      } else if (r.type === 'house') {
        // useHouse=false ⇒ hut 规则不产 house；house 规则本身仍生效（vacant≤3 且 Lv3 且 house<8）
        if (cap - pop <= 3 && lvl >= 3 && n < r.cap) wants.push('house');
      } else if (n >= r.cap) {
        continue;
      } else if (r.type === 'eatery') {
        if (lvl >= 2 && state.resources.food > 12) wants.push('eatery');
      } else if (r.type === 'mill') {
        if (n <= countType(state, 'farm')) wants.push('mill');
      } else if (r.type === 'grocer') {
        if (lvl >= 4) wants.push('grocer');
      } else if (r.type === 'carpenter') {
        if (lvl >= 3) wants.push('carpenter');
      } else {
        wants.push(r.type); // farm / forest
      }
    }
    for (const t of wants) if (tryPlace(state, t)) return t;
    return null;
  };
}

// ---- 复放 ----
// N：每 tick 最多建造数（Infinity = sim11 口径；1 = 验收 bot 节流口径）
// perturbations：[{ startTick, len, kind }] —— 'pause' 停建 | 'extra' 多建 1 座非路线建筑
function replay({ thresholds, moveIn = 5, capPassive = null, maxTicks = 2000, N = Infinity, perturbations = [] }) {
  apply({ thresholds, moveIn });
  const state = createInitialState();
  const sf = capPassive != null ? capConstant(capPassive) : null;
  const policy = makeFactoryTownPolicy();
  const levelAt = { 2: null, 3: null, 4: null };
  let maxP = 0;
  const pLog = [];
  const foodNetAt = (s) => {
    const runMill = s.buildings.filter((b) => b.type === 'mill' && !b.idle).length;
    const runEat = s.buildings.filter((b) => b.type === 'eatery' && !b.idle).length;
    return runMill - runEat - s.population.count * 0.1;
  };
  for (let i = 0; i < maxTicks; i++) {
    const p = perturbations.find((q) => state.tick + 1 >= q.startTick && state.tick + 1 < q.startTick + q.len);
    if (p) {
      if (p.kind === 'extra' && !p.done) {
        if (tryPlace(state, p.build ?? 'granary')) { p.done = true; pLog.push({ tick: state.tick + 1, action: `extra:${p.build ?? 'granary'}` }); }
      }
      // pause：不建造
    } else {
      let built = 0;
      while (built < N) {
        if (!policy(state)) break;
        built++;
        if (built > 500) break;
      }
    }
    tick(state);
    if (sf) {
      state.prosperity = sf(state);
      state.level = computeLevel(state.prosperity);
      state.maxLevel = Math.max(state.maxLevel ?? state.level, state.level);
    }
    maxP = Math.max(maxP, state.prosperity);
    for (const q of perturbations) {
      if (!q.marked && state.tick >= q.startTick + q.len) {
        q.marked = true;
        pLog.push({ tick: state.tick, note: '扰动结束', pop: state.population.count, food: +state.resources.food.toFixed(1), prosperity: +state.prosperity.toFixed(1), foodNet: +foodNetAt(state).toFixed(2) });
      }
    }
    for (const lv of [2, 3, 4]) if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level >= 4) break;
  }
  const bd = {};
  for (const b of state.buildings) bd[b.type] = (bd[b.type] ?? 0) + 1;
  restore();
  return { levelAt, maxP: +maxP.toFixed(2), pop: state.population.count, buildings: state.buildings.length,
    breakdown: bd, foodNet: +foodNetAt(state).toFixed(2), pLog };
}

const mode = process.argv[2] ?? 'replay';

if (mode === 'replay') {
  console.log('--- 工厂镇策略独立复放（自实现 harness，策略语义来自 factory-town-policy.txt）---');
  for (const [label, cfg] of [
    ['O6′ 封顶26+20/60/145+迁入5 N=∞', { thresholds: [0, 20, 60, 145], capPassive: 26, N: Infinity }],
    ['O6′ 同上 N=1（验收节流）', { thresholds: [0, 20, 60, 145], capPassive: 26, N: 1 }],
    ['现网基线 20/50/100 标准公式 N=∞', { thresholds: [0, 20, 50, 100], N: Infinity }],
    ['现网基线 同上 N=1', { thresholds: [0, 20, 50, 100], N: 1 }],
  ]) {
    const r = replay(cfg);
    console.log(JSON.stringify({
      口径: label, Lv2: r.levelAt[2], Lv3: r.levelAt[3], Lv4: r.levelAt[4] ?? '❌未到达',
      最高繁荣: r.maxP, 终局: { 户: r.pop, 建筑: r.buildings, 构成: r.breakdown }, 食净流: r.foodNet,
    }));
  }
}

if (mode === 'frag') {
  console.log('--- 脆弱性探针（O6′ N=∞，3 次扰动）---');
  const perturbations = [
    { startTick: 50, len: 10, kind: 'pause' },
    { startTick: 100, len: 10, kind: 'pause' },
    { startTick: 150, len: 1, kind: 'extra', build: 'granary' },
  ];
  const r = replay({ thresholds: [0, 20, 60, 145], capPassive: 26, N: Infinity, perturbations });
  console.log(JSON.stringify({
    Lv2: r.levelAt[2], Lv3: r.levelAt[3], Lv4: r.levelAt[4] ?? '❌未到达',
    最高繁荣: r.maxP, 终局: { 户: r.pop, 建筑: r.buildings, 构成: r.breakdown },
    扰动日志: r.pLog,
  }));
  const r0 = replay({ thresholds: [0, 20, 60, 145], capPassive: 26, N: Infinity });
  console.log(JSON.stringify({ 对照无扰动: { Lv4: r0.levelAt[4], 户: r0.pop, 食净流: r0.foodNet } }));
}
