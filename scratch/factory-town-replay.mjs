// T-P6-11b-3/4：工厂镇路线独立复放 + 脆弱性探针（最小复放脚本，不用 sim11 harness）
//
// 目的：独立交叉验证设计侧的「工厂镇」最快构型读数（O6′ 下 L*=226、现网基线下 181）。
// 方法：直接 import src/core 的 state/simulation/grid，内存覆盖参数（跑完 restore），
//       按工厂镇终点规格自构路线（farm~22/mill~22/eatery~19/carpenter~9、~26 户、最少住房）。
//
// 路线设计（自构，非 sim11 策略）：
//   - 劳力预算：26 户 ⇒ 26 劳力。mill 22×1 + eatery 19×1 = 41 > 26 ⇒ 劳力必然缺口，
//     但结算顺序保证 farm(0)→mill(1)→eatery(2) 先到先得，磨坊全开、食肆部分闲置。
//     设计侧称「劳力利用率 ~100%」——即 26 劳力全被占。mill22+eatery19=41 需求下，
//     磨坊吃 22、食肆吃 4。食净流 = mill 产 22 − eatery 耗 4(运转) − 26×0.1 = +15.4？
//     不对——设计侧称食净流 +0.4。以实测为准，本脚本逐 tick 记录真实读数。
//   - 住房：茅舍按迁入节奏补（cap-pop<2 时建），不追求满住。
//   - 顺序：每 tick 1 建（与验收 bot 同节流），优先级：hut → farm/mill(挂钩) → eatery → carpenter。
//
// 运行： node scratch/factory-town-replay.mjs            # 双口径复放（O6′ + 现网基线）
//        node scratch/factory-town-replay.mjs frag       # 脆弱性探针（3 次扰动）
// 纪律：只读 src/config + 内存覆盖，不改任何 src/tests/docs 文件。
import { createInitialState } from '../src/core/state.js';
import { tick, housingCapacity, computeCaps, computeLevel } from '../src/core/simulation.js';
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

// 调试：逐 tick 打印建造与资源（只打有建造动作的 tick + 每 20 tick 一条快照）
function debugEarly(target, maxTicks = 2000) {
  const state = createInitialState();
  for (let i = 0; i < maxTicks; i++) {
    const built = factoryTownBot(state, { target });
    tick(state);
    if (built || state.tick % 20 === 0)
      console.log(`t${state.tick} built=${built} money=${state.money.toFixed(0)} wood=${state.resources.wood.toFixed(0)} grain=${state.resources.grain.toFixed(1)} food=${state.resources.food.toFixed(1)} pop=${state.population.count} lvl=${state.level} p=${state.prosperity}`);
    if (state.level >= 4) { console.log(`t${state.tick} ★Lv4`); break; }
  }
}

// 恒计分封顶公式（与 pacing-sim12 同款）
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

// ---- 工厂镇路线 bot（自构：按终点规格贪心，每 tick 至多 1 建）----
// 目标构型：farm≈22 / mill≈22 / eatery≈19 / carpenter≈9 / hut 按需 / house 0 / forest 少量 / granary 0
// 粮线：farm 与 mill 1:1 同步扩张（磨坊耗 2 粮 = 农田产 2 粮，零库存闭合靠结算顺序）
// 商业：Lv2 起铺食肆（食有盈余即铺，直到 19）；Lv3 起铺木匠铺（木够即铺，直到 9）
function factoryTownBot(state, { target = { farm: 22, mill: 22, eatery: 19, carpenter: 9 } } = {}) {
  const lvl = state.level;
  const cap = housingCapacity(state);
  const pop = state.population.count;
  const c = countType;
  const wants = [];
  // 粮线最优先（食断 = 人口崩 = 全盘皆输）：磨坊先于一切扩张开工
  if (c(state, 'mill') < target.mill && c(state, 'farm') >= c(state, 'mill') + 1) wants.push('mill');
  if (c(state, 'farm') < target.farm) wants.push('farm');
  // 木（工厂镇木耗大：磨坊 20 木/食肆 25 木/木匠铺 15 木；林场是唯一木源）
  if (state.resources.wood < 30) wants.push('forest');
  // 住房：保迁入不断（cap-pop<2 就补茅舍）
  if (cap - pop < 2) wants.push('hut');
  // 商业：Lv2 食肆（食库存>15 才铺，防自饿）、Lv3 木匠铺（木>30）
  if (lvl >= 2 && c(state, 'eatery') < target.eatery && state.resources.food > 15) wants.push('eatery');
  if (lvl >= 3 && c(state, 'carpenter') < target.carpenter && state.resources.wood > 30) wants.push('carpenter');
  for (const t of wants) if (tryPlace(state, t)) return t;
  // 兜底（wants 全放不下才走到这）：钱不够且粮满仓 → 拆 1 座农田变现（返 15 钱/5 木）
  if (state.money < 30 && c(state, 'farm') > 2 && state.resources.grain > 90) {
    const victim = state.buildings.find((b) => b.type === 'farm');
    if (victim && demolishBuilding(state, victim.id).ok) return 'demolish:farm';
  }
  return null;
}

// ---- 复放 ----
// perturbations: [{ startTick, len, kind }] —— kind='pause'（连续 len tick 不建造）| 'extra'（多建 1 座非路线建筑）
function replay({ thresholds, moveIn = 5, capPassive = null, maxTicks = 2000, perturbations = [], target }) {
  apply({ thresholds, moveIn });
  const state = createInitialState();
  const sf = capPassive != null ? capConstant(capPassive) : null;
  const levelAt = { 2: null, 3: null, 4: null };
  let maxP = 0, paused = 0;
  const pLog = [];
  const foodNetAt = (s) => {
    const mills = countType(s, 'mill'), eat = countType(s, 'eatery');
    const runEat = s.buildings.filter((b) => b.type === 'eatery' && !b.idle).length;
    const runMill = s.buildings.filter((b) => b.type === 'mill' && !b.idle).length;
    return { gross: runMill - runEat - s.population.count * 0.1, runMill, runEat };
  };
  for (let i = 0; i < maxTicks; i++) {
    // 扰动注入
    const p = perturbations.find((q) => state.tick + 1 >= q.startTick && state.tick + 1 < q.startTick + q.len);
    if (p) {
      if (p.kind === 'pause') { /* 不建造 */ }
      else if (p.kind === 'extra' && !p.done) {
        const t = p.build ?? 'granary';
        if (tryPlace(state, t)) { p.done = true; pLog.push({ tick: state.tick + 1, action: `extra:${t}` }); }
      }
    } else {
      factoryTownBot(state, { target });
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
        pLog.push({ tick: state.tick, note: `扰动结束`, pop: state.population.count, food: +state.resources.food.toFixed(1), prosperity: +state.prosperity.toFixed(1), ...foodNetAt(state) });
      }
    }
    for (const lv of [2, 3, 4]) if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level >= 4) break;
  }
  const bd = {};
  for (const b of state.buildings) bd[b.type] = (bd[b.type] ?? 0) + 1;
  const fn = foodNetAt(state);
  restore();
  return { levelAt, maxP: +maxP.toFixed(2), pop: state.population.count, buildings: state.buildings.length,
    breakdown: bd, foodNet: +fn.gross.toFixed(2), runMill: fn.runMill, runEat: fn.runEat, pLog };
}

const mode = process.argv[2] ?? 'replay';
const TARGET = { farm: 22, mill: 22, eatery: 19, carpenter: 9 };

if (mode === 'debug') {
  debugEarly(TARGET);
}

if (mode === 'replay') {
  console.log('--- 工厂镇路线独立复放（自构路线，每 tick 1 建）---');
  for (const [label, cfg] of [
    ['O6′（封顶26 + 20/60/145 + 迁入5）', { thresholds: [0, 20, 60, 145], capPassive: 26 }],
    ['现网基线（20/50/100，标准公式）', { thresholds: [0, 20, 50, 100] }],
  ]) {
    const r = replay({ ...cfg, target: TARGET });
    console.log(JSON.stringify({
      口径: label, Lv2: r.levelAt[2], Lv3: r.levelAt[3], Lv4: r.levelAt[4] ?? '❌未到达',
      最高繁荣: r.maxP, 终局: { 户: r.pop, 建筑: r.buildings, 构成: r.breakdown },
      食净流终局: r.foodNet, 运转磨坊: r.runMill, 运转食肆: r.runEat,
    }));
  }
}

if (mode === 'frag') {
  console.log('--- 脆弱性探针（O6′ 口径，3 次扰动）---');
  // 扰动设计：Lv3 前后各一次 10-tick 停建（模拟真人犹豫/走神），Lv3 后一次多建 1 座粮仓（非路线建筑）
  const perturbations = [
    { startTick: 60, len: 10, kind: 'pause' },
    { startTick: 140, len: 10, kind: 'pause' },
    { startTick: 170, len: 1, kind: 'extra', build: 'granary' },
  ];
  const r = replay({ thresholds: [0, 20, 60, 145], capPassive: 26, perturbations, target: TARGET });
  console.log(JSON.stringify({
    Lv2: r.levelAt[2], Lv3: r.levelAt[3], Lv4: r.levelAt[4] ?? '❌未到达',
    最高繁荣: r.maxP, 终局: { 户: r.pop, 建筑: r.buildings, 构成: r.breakdown },
    扰动日志: r.pLog,
  }));
  // 对照：无扰动同口径
  const r0 = replay({ thresholds: [0, 20, 60, 145], capPassive: 26, target: TARGET });
  console.log(JSON.stringify({ 对照无扰动: { Lv4: r0.levelAt[4], 户: r0.pop } }));
}
