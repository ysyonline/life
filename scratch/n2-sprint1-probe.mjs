// T-N2-A：N2 首期实验（③存粮压力 + ②土地收紧）设计侧探针
//
// 纪律：只读 src/config + src/core，全部参数走内存覆盖（跑完 restore），不改任何 src/ 与 tests/ 文件。
// 基线门槛：必须先逐 tick 复现 O6′ 双 Gate（新 bot V2 = 12/355/605、V1 = 211），否则读数作废（self-abort）。
//
// 运行： node scratch/n2-sprint1-probe.mjs gate      # ③ 档位 × 双 Gate + 空转帧诊断
//        node scratch/n2-sprint1-probe.mjs land      # ② 土地收紧档位 × 双 Gate
//        node scratch/n2-sprint1-probe.mjs census    # 地形普查：各建筑锚点余量
//        node scratch/n2-sprint1-probe.mjs factory   # 工厂镇压力测试（D-N2-5 反向约束）
//        node scratch/n2-sprint1-probe.mjs all
import { createInitialState } from '../src/core/state.js';
import { tick, housingCapacity, computeCaps, computeLevel } from '../src/core/simulation.js';
import { placeBuilding, demolishBuilding } from '../src/core/grid.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

const S = RULES.mapSize;

// ---------- 内存覆盖（只动 baseCaps / granaryBonus / 地形；阈值与封顶一律不动）----------
const BASE = {
  baseCaps: { ...RULES.baseCaps },
  granaryBonus: { ...RULES.granaryBonus },
};
function applyCaps(ov = {}) {
  RULES.baseCaps = { ...BASE.baseCaps, ...(ov.baseCaps ?? {}) };
  RULES.granaryBonus = { ...BASE.granaryBonus, ...(ov.granaryBonus ?? {}) };
}
function restoreCaps() {
  RULES.baseCaps = { ...BASE.baseCaps };
  RULES.granaryBonus = { ...BASE.granaryBonus };
}

// ---------- 现行验收 bot（逐字复制自 tests/verification/progression.test.js 的 botBuild）----------
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

// ---------- 地形生成（与 src/core/grid.js genTerrain 同款，半径可覆盖）----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// radii: [fertile左下, fertile右上, woodland左上, woodland右下]
function genTerrain(size, radii = [6, 5, 5, 6], seed = 20261016, scale = 1) {
  const rand = mulberry32(seed);
  const N = Math.round(size * scale); // 可用区边长（等比缩放后的地图）
  const map = Array.from({ length: size }, () => Array(size).fill('plain'));
  const blob = (cx, cy, radius, terrain) => {
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const d = Math.hypot(x - cx * scale, y - cy * scale);
        if (d <= radius * scale * (0.75 + rand() * 0.5)) map[y][x] = terrain;
      }
  };
  blob(8, 22, radii[0], 'fertile');
  blob(24, 8, radii[1], 'fertile');
  blob(7, 7, radii[2], 'woodland');
  blob(24, 24, radii[3], 'woodland');
  return { map, N };
}
const terrainMapOf = (size, radii, seed, scale) => genTerrain(size, radii, seed, scale).map;

// 把地形写回 state.grid（不新增不可建区时只改 terrain 字段）
function applyTerrain(state, map) {
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) state.grid.get(`${x},${y}`).terrain = map[y][x];
}

// 不可建区（②-b：河道/禁建带）——用 buildingId 占位模拟（canPlace 视其为已占用）
// kind 'river'：横贯河道（y ∈ [r0, r1]）+ 一条支流；占格比例由 rows 控制
function applyBlocked(state, kind, param = {}) {
  const blocked = new Set();
  const mark = (x, y) => { if (x >= 0 && y >= 0 && x < S && y < S) blocked.add(`${x},${y}`); };
  if (kind === 'river') {
    const rows = param.rows ?? 3;      // 河宽（格）
    const y0 = param.y0 ?? 15;
    for (let y = y0; y < y0 + rows; y++) for (let x = 0; x < S; x++) mark(x, y);
    if (param.branch !== false) {      // 一条纵向支流（把地图切成两个象限）
      const bx = param.bx ?? 20;
      for (let y = 0; y < y0; y++) { mark(bx, y); mark(bx + 1, y); }
    }
  } else if (kind === 'scatter') {     // 均匀散布禁建（对照组，无空间结构）
    const step = param.step ?? 3;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if ((x + y) % step === 0) mark(x, y);
  } else if (kind === 'anti') {        // 反向散布：只保留 1/step（更狠的压缩）
    const step = param.step ?? 3;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if ((x + y) % step !== 0) mark(x, y);
  } else if (kind === 'scale') {       // 可用地等比压缩（等价「缩小地图 + 团块等比缩放」）
    const N = Math.round(S * (param.scale ?? 1));
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (x >= N || y >= N) mark(x, y);
  }
  for (const k of blocked) {
    const cell = state.grid.get(k);
    if (cell) cell.buildingId = -1;
  }
  return blocked.size;
}

// ---------- 推演 ----------
// 木材仓容（延伸候选 ③′）：src 的 computeCaps 只给 grain/food 设上限，wood/goods 无上限。
// 本探针在每 tick 结算前把 wood 钳到 woodCap，近似模拟「木材不可无限囤积」。
// 近似方向声明：真实实现应在 addResource 当场钳制（本 tick 产量也会被钳），本探针只钳 tick 初值，
// ⇒ 读数比真实实现**宽松**（真实咬合更强），保守可用。
// land.method：② 土地收紧的方式（quality-lead 要求：任何 ② 读数必须声明方式，否则不可比）
//   'scale' = 可用地等比压缩 + 地形团块等比缩放（等价「缩 mapSize 且整体等比缩小」）
//   'trim'  = 只裁掉网格外区、**保留原团块坐标**（等价「可用区裁角」；团块可能被切掉）
//   'blob'  = 不裁图，只收 genTerrain 团块半径（沃土/林地锚点收紧）
function run({ caps, woodCap = null, terrainRadii, blocked, scale = null, trim = false, injectMoney = false, maxTicks = 2000, granaryAdapt = false } = {}) {
  applyCaps(caps);
  const state = createInitialState();
  const terrainScale = trim ? 1 : (scale ?? 1);
  if (terrainRadii) applyTerrain(state, terrainMapOf(S, terrainRadii, 20261016, terrainScale));
  let blockedCells = 0;
  if (scale != null) blockedCells = applyBlocked(state, 'scale', { scale });
  if (blocked) blockedCells += applyBlocked(state, blocked.kind, blocked);
  if (injectMoney) state.money = 100000;

  const levelAt = { 2: null, 3: null, 4: null };
  let maxP = 0;
  const win = { frames: 0, noScarcity: 0, laborGap: 0, materialGap: 0, housingFull: 0, foodLow: 0, grainCapped: 0,
    noAction: 0, moneyIdle: 0 };
  for (let i = 0; i < maxTicks; i++) {
    if (woodCap != null && state.resources.wood > woodCap) state.resources.wood = woodCap;
    let act = botBuild(state);
    // 最小适配（仅工厂镇探针用）：磨坊缺料闲置时补 1 座粮仓
    if (granaryAdapt && !String(act ?? '').startsWith('demolish')) {
      const millStarved = state.buildings.some((b) => b.type === 'mill' && b.idle && b.idleReason === 'material');
      if (millStarved && countType(state, 'granary') < 6 && tryPlace(state, 'granary')) act = 'granary(adapt)';
    }
    tick(state);
    maxP = Math.max(maxP, state.prosperity);
    const inWin = levelAt[3] != null && levelAt[4] == null;
    if (inWin) {
      win.frames++;
      const idleLabor = state.buildings.some((b) => b.idle && b.idleReason === 'labor');
      const idleMat = state.buildings.some((b) => b.idle && b.idleReason === 'material');
      const vacant = housingCapacity(state) - state.population.count;
      if (idleLabor) win.laborGap++;
      if (idleMat) win.materialGap++;
      if (vacant <= 0) win.housingFull++;
      if (state.resources.food <= 10) win.foodLow++;
      if (state.resources.grain >= computeCaps(state).grain - 0.001) win.grainCapped++;
      if (!idleLabor && !idleMat && vacant > 0 && state.resources.food > 10) win.noScarcity++;
      // 真正的「无事可做」：bot 本 tick 没建也没拆（无可执行决策）
      if (act == null) win.noAction++;
      // 钱躺在手里没处花（无出口）：余额 > 最贵可建建筑造价 80（杂货摊）
      if (state.money > 80) win.moneyIdle++;
    }
    for (const lv of [2, 3, 4]) if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level >= 4) break;
  }
  const bd = {};
  for (const b of state.buildings) bd[b.type] = (bd[b.type] ?? 0) + 1;
  let cells = 0;
  for (const [t, n] of Object.entries(bd)) cells += n * BUILDINGS[t].size[0] * BUILDINGS[t].size[1];
  restoreCaps();
  const pct = (n) => (win.frames ? +(n / win.frames).toFixed(3) : null);
  return {
    lv2: levelAt[2], lv3: levelAt[3], lv4: levelAt[4], maxP: +maxP.toFixed(2),
    pop: state.population.count, buildings: state.buildings.length, breakdown: bd,
    money: +state.money.toFixed(1), food: +state.resources.food.toFixed(1), wood: +state.resources.wood.toFixed(1),
    cellsUsed: cells,
    blockedCells,
    landMethod: trim ? 'trim(裁外区·保留原团块)' : scale != null ? 'scale(等比压缩·团块同步缩放)' : 'blob(只收团块)',
    win: {
      frames: win.frames, 空转帧占比: pct(win.noScarcity), 缺料帧: pct(win.materialGap),
      缺人帧: pct(win.laborGap), 住房满员帧: pct(win.housingFull), 食低帧: pct(win.foodLow),
      粮满仓帧: pct(win.grainCapped), 无事可做帧: pct(win.noAction), 钱无出口帧: pct(win.moneyIdle),
    },
  };
}

// ---------- 工厂镇策略（语义复制自 scratch/factory-town-policy.txt / replay2）----------
function makeFactoryTownPolicy() {
  const ORDER = [
    { type: 'carpenter', cap: 4 }, { type: 'forest', cap: 6 }, { type: 'eatery', cap: 19 },
    { type: 'hut', cap: Infinity }, { type: 'mill', cap: 25 }, { type: 'grocer', cap: 2 },
    { type: 'house', cap: 8 }, { type: 'carpenter', cap: 9 }, { type: 'farm', cap: 26 },
  ];
  return function policy(state, adapt) {
    if (state.money < 60) return null;
    const lvl = state.level, cap = housingCapacity(state), pop = state.population.count;
    const wants = [];
    if (adapt && state.buildings.some((b) => b.type === 'mill' && b.idle && b.idleReason === 'material')
      && countType(state, 'granary') < 4) wants.push('granary'); // 最小适配：磨坊缺料 → 补仓
    if (state.resources.wood < 10 && countType(state, 'forest') < 7) wants.push('forest');
    for (const r of ORDER) {
      const n = countType(state, r.type);
      if (r.type === 'hut') { if (cap - pop <= 3 && state.money > 50) wants.push('hut'); }
      else if (r.type === 'house') { if (cap - pop <= 3 && lvl >= 3 && n < r.cap) wants.push('house'); }
      else if (n >= r.cap) continue;
      else if (r.type === 'eatery') { if (lvl >= 2 && state.resources.food > 12) wants.push('eatery'); }
      else if (r.type === 'mill') { if (n <= countType(state, 'farm')) wants.push('mill'); }
      else if (r.type === 'grocer') { if (lvl >= 4) wants.push('grocer'); }
      else if (r.type === 'carpenter') { if (lvl >= 3) wants.push('carpenter'); }
      else wants.push(r.type);
    }
    for (const t of wants) if (tryPlace(state, t)) return t;
    return null;
  };
}
function runFactory({ caps, N = Infinity, adapt = false, maxTicks = 2000 } = {}) {
  applyCaps(caps);
  const state = createInitialState();
  const policy = makeFactoryTownPolicy();
  const levelAt = { 2: null, 3: null, 4: null };
  let maxP = 0;
  let maxGrain = 0, capHitTicks = 0, lastGrain = 0;
  for (let i = 0; i < maxTicks; i++) {
    let built = 0;
    while (built < N) { if (!policy(state, adapt)) break; built++; if (built > 500) break; }
    tick(state);
    // 粮库存轨迹：本探针只能观察 tick 末值（真正在 tick 内达到的峰值更高，见 §4.4 机理说明）
    const g = state.resources.grain;
    maxGrain = Math.max(maxGrain, g);
    if (g >= computeCaps(state).grain - 0.001) capHitTicks++;
    lastGrain = g;
    maxP = Math.max(maxP, state.prosperity);
    for (const lv of [2, 3, 4]) if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level >= 4) break;
  }
  const bd = {};
  for (const b of state.buildings) bd[b.type] = (bd[b.type] ?? 0) + 1;
  const idleMills = state.buildings.filter((b) => b.type === 'mill' && b.idle).length;
  restoreCaps();
  return { lv2: levelAt[2], lv3: levelAt[3], lv4: levelAt[4], maxP: +maxP.toFixed(2),
    pop: state.population.count, buildings: state.buildings.length, breakdown: bd, idleMills,
    粮库存末值: +lastGrain.toFixed(1), 粮库存末值峰值: +maxGrain.toFixed(1), 粮触顶帧: capHitTicks,
    终局仓容: computeCaps(state).grain };
}

// ---------- 地形普查 ----------
function census(radii = [6, 5, 5, 6], blocked = null, scale = 1) {
  const map = terrainMapOf(S, radii, 20261016, scale);
  const blockedSet = new Set();
  if (scale < 1) {
    const N = Math.round(S * scale);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (x >= N || y >= N) blockedSet.add(`${x},${y}`);
  }
  if (blocked) {
    // 复用 applyBlocked 的坐标规则（不依赖 state）
    const mark = (x, y) => { if (x >= 0 && y >= 0 && x < S && y < S) blockedSet.add(`${x},${y}`); };
    if (blocked.kind === 'river') {
      const rows = blocked.rows ?? 3, y0 = blocked.y0 ?? 15;
      for (let y = y0; y < y0 + rows; y++) for (let x = 0; x < S; x++) mark(x, y);
      if (blocked.branch !== false) { const bx = blocked.bx ?? 20; for (let y = 0; y < y0; y++) { mark(bx, y); mark(bx + 1, y); } }
    } else if (blocked.kind === 'scatter') {
      const step = blocked.step ?? 3;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if ((x + y) % step === 0) mark(x, y);
    }
  }
  let fertile = 0, woodland = 0, plain = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (blockedSet.has(`${x},${y}`)) continue;
    const t = map[y][x];
    if (t === 'fertile') fertile++; else if (t === 'woodland') woodland++; else plain++;
  }
  const anchors = {};
  for (const [id, def] of Object.entries(BUILDINGS)) {
    const [w, h] = def.size;
    let n = 0;
    for (let y = 0; y <= S - h; y++) for (let x = 0; x <= S - w; x++) {
      let ok = true;
      for (let dy = 0; dy < h && ok; dy++) for (let dx = 0; dx < w && ok; dx++) {
        if (blockedSet.has(`${x + dx},${y + dy}`)) { ok = false; break; }
        if (def.terrain && map[y + dy][x + dx] !== def.terrain) { ok = false; break; }
      }
      if (ok) n++;
    }
    anchors[id] = n;
  }
  // 贪心非重叠可建数（2×2 建筑的实际可建上限估计）
  const pack = (need) => {
    const used = Array.from({ length: S }, () => Array(S).fill(false));
    let n = 0;
    for (let y = 0; y <= S - 2; y++) for (let x = 0; x <= S - 2; x++) {
      let ok = true;
      for (let dy = 0; dy < 2 && ok; dy++) for (let dx = 0; dx < 2 && ok; dx++) {
        if (used[y + dy][x + dx] || blockedSet.has(`${x + dx},${y + dy}`) || map[y + dy][x + dx] !== need) ok = false;
      }
      if (ok) { for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) used[y + dx * 0 + dy][x + dx] = true; n++; }
    }
    return n;
  };
  return { radii, scale, blocked: blocked ? blocked.kind : null, blockedCells: blockedSet.size,
    可用格: S * S - blockedSet.size, fertile, woodland, plain,
    锚点: anchors, 非重叠可建: { farm: pack('fertile'), forest: pack('woodland') } };
}

// 组合档：本设计案 T1 / T2 / T3 的完整组合实测
function comb() {
  console.log('--- 7. 组合档实测（T1/T2/T3，双 Gate + 空转）---');
  for (const [id, cfg] of [
    ['T1 = grain40/50 + 地形团块×0.75（不缩图）', { caps: { baseCaps: { grain: 40 }, granaryBonus: { grain: 50 } }, terrainRadii: [4.5, 3.75, 3.75, 4.5], scale: 1 }],
    ['T2 = grain30/25 + 可用地×0.75（24×24）', { caps: { baseCaps: { grain: 30 }, granaryBonus: { grain: 25 } }, terrainRadii: [6, 5, 5, 6], scale: 0.75 }],
    ['T3 = grain20/20 + 可用地×0.45（14×14）', { caps: { baseCaps: { grain: 20 }, granaryBonus: { grain: 20 } }, terrainRadii: [6, 5, 5, 6], scale: 0.45 }],
  ]) {
    const v2 = run(cfg);
    const v1 = run({ ...cfg, injectMoney: true });
    console.log(JSON.stringify({ 档: id,
      V2: { Lv2: v2.lv2, Lv3: v2.lv3, Lv4: v2.lv4 ?? '❌', 最高: v2.maxP, 终局: `${v2.pop}户/${v2.buildings}建筑`, 占地率: +(v2.cellsUsed / (1024 - v2.blockedCells)).toFixed(3), 构成: v2.breakdown },
      V1: { Lv4: v1.lv4 ?? '❌', 最高: v1.maxP },
      判定: v2.lv4 != null && v1.lv4 != null ? '✅双绿' : v2.lv4 != null ? '❌V1红' : '❌V2红',
      Lv3到Lv4窗口: v2.win }));
  }
}

// 咬合点验证：工厂镇 22 座磨坊需 44 粮/tick，若机理为「tick 内超产被截断」，
// 则咬合点应恰好在 仓容 = 44：cap ≥ 44 时闲置磨坊 0，cap < 44 时 > 0 且随 cap 线性增加。
function bindSweep() {
  console.log('--- 8. 工厂镇咬合点扫描（检验「tick 内超产截断」机理）---');
  console.log('机理预测：活跃磨坊上限 = min(农田数, 仓容/2)；工厂镇 22 磨坊 ⇒ 咬合点 = 仓容 44');
  for (const cap of [100, 60, 50, 48, 46, 44, 42, 40, 36, 30, 24]) {
    const r = runFactory({ caps: { baseCaps: { grain: cap } }, N: Infinity });
    const predicted = Math.min(22, Math.floor(cap / 2));
    console.log(JSON.stringify({ 仓容: cap, 冻结策略Lv4: r.lv4 ?? '❌', 最高: r.maxP, 闲置磨坊: r.idleMills,
      预测活跃磨坊: predicted, 预测闲置磨坊: 22 - predicted,
      末值粮库存: r.粮库存末值, 终局仓容: r.终局仓容 }));
  }
}

// ---------- 主流程 ----------
// 诊断：O6′ Lv3→Lv4 窗口到底被什么限速（人口？钱？地？）
function diag() {
  const BASEMOVE = RULES.moveInInterval;
  console.log('--- 5. 窗口限速器诊断（O6′）---');
  const cases = [
    { label: '现状 迁入5', moveIn: 5 },
    { label: '迁入3（人口加速 67%）', moveIn: 3 },
    { label: '迁入8（人口减速 37%）', moveIn: 8 },
  ];
  for (const c of cases) {
    RULES.moveInInterval = c.moveIn;
    const state = createInitialState();
    const levelAt = { 2: null, 3: null, 4: null };
    const snap = {};
    let noAction = 0, frames = 0, maxP = 0;
    for (let i = 0; i < 3000; i++) {
      const act = botBuild(state);
      tick(state);
      maxP = Math.max(maxP, state.prosperity);
      if (levelAt[3] != null && levelAt[4] == null) { frames++; if (act == null) noAction++; }
      for (const lv of [2, 3, 4]) {
        if (levelAt[lv] == null && state.level >= lv) {
          levelAt[lv] = state.tick;
          snap[lv] = { tick: state.tick, pop: state.population.count, 繁荣: +state.prosperity.toFixed(1),
            茅舍: countType(state, 'hut'), 磨坊: countType(state, 'mill'), 木匠铺: countType(state, 'carpenter'),
            钱: +state.money.toFixed(1), 建筑: state.buildings.length };
        }
      }
      if (state.level >= 4) break;
    }
    console.log(JSON.stringify({ 口径: c.label, Lv3: snap[3], Lv4: snap[4], 最高: +maxP.toFixed(2),
      窗口无事可做帧占比: frames ? +(noAction / frames).toFixed(3) : null }));
    RULES.moveInInterval = BASEMOVE;
  }
  RULES.moveInInterval = BASEMOVE;
}

// 延伸候选（超 D-N2-2 范围，仅供用户拍板参考）
//   M-A 耗食上调 0.1→0.14/0.18（让「食」重新咬合人口闸门）
//   M-B 食盈余换迁入：食库存 > T 时每 tick 额外迁入 1 户（把「等人口」变成「投资粮线换人口」）
function runMisc({ foodPer = null, bonusMoveIn = null } = {}) {
  const bf = RULES.foodPerHouseholdPerTick;
  if (foodPer != null) RULES.foodPerHouseholdPerTick = foodPer;
  const state = createInitialState();
  const levelAt = { 2: null, 3: null, 4: null };
  let maxP = 0, noAction = 0, frames = 0;
  for (let i = 0; i < 3000; i++) {
    const act = botBuild(state);
    tick(state);
    if (bonusMoveIn != null) {
      const vacant = housingCapacity(state) - state.population.count;
      if (state.resources.food > bonusMoveIn && vacant > 0) state.population.count += 1;
    }
    maxP = Math.max(maxP, state.prosperity);
    if (levelAt[3] != null && levelAt[4] == null) { frames++; if (act == null) noAction++; }
    for (const lv of [2, 3, 4]) if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level >= 4) break;
  }
  const bd = {};
  for (const b of state.buildings) bd[b.type] = (bd[b.type] ?? 0) + 1;
  RULES.foodPerHouseholdPerTick = bf;
  return { lv2: levelAt[2], lv3: levelAt[3], lv4: levelAt[4], maxP: +maxP.toFixed(2),
    pop: state.population.count, buildings: state.buildings.length, breakdown: bd,
    无事可做帧: frames ? +(noAction / frames).toFixed(3) : null };
}

const mode = process.argv[2] ?? 'all';
if (mode === 'diag' || mode === 'all') diag();

if (mode === 'comb') gate0();
if (mode === 'comb' || mode === 'all') comb();

if (mode === 'bind') bindSweep();

// ② 收紧方式对照（quality-lead 冲突定位：同一压缩比例、不同收紧方式 ⇒ 读数不可比）
if (mode === 'trim') {
  gate0();
  console.log('--- 9. ② 土地收紧：两种收紧方式对照（同为「可用地 ×s」）---');
  console.log('scale = 等比压缩（团块同步缩放，保住农田/林场能力）；trim = 裁外区（保留原团块坐标，可能切掉团块）');
  for (const s of [1, 0.85, 0.75, 0.65, 0.55, 0.45]) {
    for (const [m, isTrim] of [['scale', false], ['trim', true]]) {
      const v2 = run({ terrainRadii: [6, 5, 5, 6], scale: s === 1 ? null : s, trim: isTrim });
      const v1 = run({ terrainRadii: [6, 5, 5, 6], scale: s === 1 ? null : s, trim: isTrim, injectMoney: true });
      console.log(JSON.stringify({ 压缩: s, 方式: m, 禁建格: v2.blockedCells, 农田: v2.breakdown.farm ?? 0, 林场: v2.breakdown.forest ?? 0,
        V2: { Lv2: v2.lv2, Lv3: v2.lv3, Lv4: v2.lv4 ?? '❌', 最高: v2.maxP, 占地率: +(v2.cellsUsed / (1024 - v2.blockedCells)).toFixed(3) },
        V1: { Lv4: v1.lv4 ?? '❌', 最高: v1.maxP },
        判定: v2.lv4 != null && v1.lv4 != null ? '✅双绿' : v2.lv4 != null ? '❌V1红' : '❌V2红',
        无事可做帧: (v2.win ?? {}).无事可做帧 }));
    }
  }
}

if (mode === 'misc' || mode === 'all') {
  console.log('--- 6. 延伸候选（超 D-N2-2 范围，需用户拍板才可纳入）---');
  for (const [label, cfg] of [
    ['M-A1 耗食 0.1→0.14', { foodPer: 0.14 }],
    ['M-A2 耗食 0.1→0.18', { foodPer: 0.18 }],
    ['M-B1 食盈余>30 换额外迁入 1 户/tick', { bonusMoveIn: 30 }],
    ['M-B2 食盈余>60 换额外迁入 1 户/tick', { bonusMoveIn: 60 }],
    ['M-A1+B1 耗食0.14 + 食盈余>30 换迁入', { foodPer: 0.14, bonusMoveIn: 30 }],
  ]) {
    const v2 = runMisc(cfg);
    console.log(JSON.stringify({ 档: label,
      V2: { Lv2: v2.lv2, Lv3: v2.lv3, Lv4: v2.lv4 ?? '❌', 最高: v2.maxP, 终局: `${v2.pop}户/${v2.buildings}建筑`, 构成: v2.breakdown },
      无事可做帧: v2.无事可做帧 }));
  }
}

function gate0() {
  console.log('--- 0. 基线门槛：O6′ 双 Gate 复现（期望 V2 12/355/605、V1 211）---');
  const v2 = run({});
  const v1 = run({ injectMoney: true });
  console.log(JSON.stringify({ V2: [v2.lv2, v2.lv3, v2.lv4], V2最高: v2.maxP, V1: v1.lv4, V1最高: v1.maxP }));
  if (v2.lv2 !== 12 || v2.lv3 !== 355 || v2.lv4 !== 605 || v1.lv4 !== 211) {
    console.error('❌ 基线复现失败，全部读数作废'); process.exit(1);
  }
  console.log('✅ 基线复现通过；O6′ 基准空转读数：' + JSON.stringify(v2.win));
  return { v2, v1 };
}

// ③ 档位（grain 侧为主；food 侧单独做敏感性，不入推荐档）
const TIERS_G = [
  { id: 'G0 现状', caps: {} },
  { id: 'G1 温和 粮仓容60+40', caps: { baseCaps: { grain: 60 }, granaryBonus: { grain: 40 } } },
  { id: 'G2 推荐 粮仓容40+50', caps: { baseCaps: { grain: 40 }, granaryBonus: { grain: 50 } } },
  { id: 'G3 激进 粮仓容30+25', caps: { baseCaps: { grain: 30 }, granaryBonus: { grain: 25 } } },
  { id: 'G4 极端 粮仓容20+20', caps: { baseCaps: { grain: 20 }, granaryBonus: { grain: 20 } } },
  { id: 'S1 敏感性 食仓容40+25（粮不动）', caps: { baseCaps: { food: 40 }, granaryBonus: { food: 25 } } },
  // 延伸候选 ③′：木材仓容（wood 现无上限，可无限囤积 ⇒ 木匠铺永不见缺料）
  { id: 'W1 木仓容150', woodCap: 150 },
  { id: 'W2 木仓容100', woodCap: 100 },
  { id: 'W3 木仓容60', woodCap: 60 },
  { id: 'W4 木仓容40', woodCap: 40 },
  { id: 'G2+W2 粮40/50 + 木100', caps: { baseCaps: { grain: 40 }, granaryBonus: { grain: 50 } }, woodCap: 100 },
  { id: 'G2+W3 粮40/50 + 木60', caps: { baseCaps: { grain: 40 }, granaryBonus: { grain: 50 } }, woodCap: 60 },
];

if (mode === 'gate' || mode === 'all') {
  gate0();
  console.log('--- 1. ③ 存粮压力档位 × 双 Gate（V2 自然通关 / V1 注入铜钱）---');
  for (const t of TIERS_G) {
    const v2 = run({ caps: t.caps, woodCap: t.woodCap ?? null });
    const v1 = run({ caps: t.caps, woodCap: t.woodCap ?? null, injectMoney: true });
    console.log(JSON.stringify({
      档: t.id,
      V2: { Lv2: v2.lv2, Lv3: v2.lv3, Lv4: v2.lv4 ?? '❌', 最高: v2.maxP, 终局: `${v2.pop}户/${v2.buildings}建筑`,
        余钱: v2.money, 构成: v2.breakdown },
      V1: { Lv4: v1.lv4 ?? '❌', 最高: v1.maxP },
      判定: v2.lv4 != null && v1.lv4 != null ? '✅双绿' : v2.lv4 != null ? '❌V1红' : '❌V2红',
      Lv3到Lv4窗口: v2.win,
      构成: v2.breakdown,
    }));
  }
}

// ② 档位：地形团块缩放（沃土/林地锚点收紧）+ 不可建带（河道）
// scale = 可用地等比压缩系数（等价「mapSize 缩小到 32·scale 且地形团块等比缩放」）
const TIERS_L = [
  { id: 'L0 现状（32×32）', scale: 1 },
  { id: 'L1 可用地 ×0.85（28×28，占 72%）', scale: 0.85 },
  { id: 'L2 可用地 ×0.75（24×24，占 56%）', scale: 0.75 },
  { id: 'L3 可用地 ×0.65（21×21，占 42%）', scale: 0.65 },
  { id: 'L4 可用地 ×0.55（18×18，占 30%）', scale: 0.55 },
  { id: 'L5 可用地 ×0.45（14×14，占 19%）', scale: 0.45 },
  { id: 'L6 可用地 ×0.75 + 汴河3行', scale: 0.75, blocked: { kind: 'river', rows: 3, y0: 15 } },
  { id: 'L7 可用地 ×0.75 + 地形团块×0.75', scale: 0.75, terrainRadii: [4.5, 3.75, 3.75, 4.5] },
  { id: 'L8 可用地 ×0.65 + 地形团块×0.75', scale: 0.65, terrainRadii: [4.5, 3.75, 3.75, 4.5] },
  { id: 'L9 只收地形团块×0.75（不缩图，沃土/林地锚点 132/128→74/65）', scale: 1, terrainRadii: [4.5, 3.75, 3.75, 4.5] },
  { id: 'L10 只收地形团块×0.6（不缩图，锚点→43/46）', scale: 1, terrainRadii: [3.6, 3, 3, 3.6] },
  { id: 'L11 L9 + G2 粮仓容40/50', scale: 1, terrainRadii: [4.5, 3.75, 3.75, 4.5], caps: { baseCaps: { grain: 40 }, granaryBonus: { grain: 50 } } },
];

if (mode === 'land' || mode === 'all') {
  if (mode === 'land') gate0();
  console.log('--- 2. ② 土地收紧档位 × 双 Gate ---');
  for (const t of TIERS_L) {
    const v2 = run({ caps: t.caps, terrainRadii: t.terrainRadii ?? [6, 5, 5, 6], blocked: t.blocked, scale: t.scale ?? null });
    const v1 = run({ caps: t.caps, terrainRadii: t.terrainRadii ?? [6, 5, 5, 6], blocked: t.blocked, scale: t.scale ?? null, injectMoney: true });
    console.log(JSON.stringify({
      档: t.id, 禁建格: v2.blockedCells,
      V2: { Lv2: v2.lv2, Lv3: v2.lv3, Lv4: v2.lv4 ?? '❌', 最高: v2.maxP, 终局: `${v2.pop}户/${v2.buildings}建筑`,
        占地格: v2.cellsUsed, 占地率: + (v2.cellsUsed / (1024 - v2.blockedCells)).toFixed(3) },
      V1: { Lv4: v1.lv4 ?? '❌', 最高: v1.maxP },
      判定: v2.lv4 != null && v1.lv4 != null ? '✅双绿' : v2.lv4 != null ? '❌V1红' : '❌V2红',
      Lv3到Lv4窗口: v2.win,
    }));
  }
}

if (mode === 'census' || mode === 'all') {
  console.log('--- 3. 地形普查：各建筑锚点余量 ---');
  const cases = [
    { label: '现状（半径 6/5/5/6，32×32）', radii: [6, 5, 5, 6], scale: 1 },
    { label: '可用地 ×0.85（28×28）', radii: [6, 5, 5, 6], scale: 0.85 },
    { label: '可用地 ×0.75（24×24）', radii: [6, 5, 5, 6], scale: 0.75 },
    { label: '可用地 ×0.65（21×21）', radii: [6, 5, 5, 6], scale: 0.65 },
    { label: '可用地 ×0.55（18×18）', radii: [6, 5, 5, 6], scale: 0.55 },
    { label: '可用地 ×0.45（14×14）', radii: [6, 5, 5, 6], scale: 0.45 },
    { label: '现状 + 汴河3行', radii: [6, 5, 5, 6], scale: 1, blocked: { kind: 'river', rows: 3, y0: 15 } },
    { label: '现状 + 汴河5行', radii: [6, 5, 5, 6], scale: 1, blocked: { kind: 'river', rows: 5, y0: 14 } },
    { label: '可用地×0.75 + 地形团块×0.75', radii: [4.5, 3.75, 3.75, 4.5], scale: 0.75 },
    { label: '32×32 地形团块×0.75（不缩图）', radii: [4.5, 3.75, 3.75, 4.5], scale: 1 },
    { label: '32×32 地形团块×0.6（不缩图）', radii: [3.6, 3, 3, 3.6], scale: 1 },
  ];
  for (const c of cases) console.log(JSON.stringify({ 口径: c.label, ...census(c.radii, c.blocked ?? null, c.scale ?? 1) }));
}

if (mode === 'factory' || mode === 'all') {
  console.log('--- 4. 工厂镇压力测试（D-N2-5 反向约束；基准 O6′ N=∞ 226 / N=1 274）---');
  const capsList = [
    { id: 'G0 现状', caps: {} },
    { id: 'G1 60+40', caps: { baseCaps: { grain: 60 }, granaryBonus: { grain: 40 } } },
    { id: 'G2 40+50', caps: { baseCaps: { grain: 40 }, granaryBonus: { grain: 50 } } },
    { id: 'G3 30+25', caps: { baseCaps: { grain: 30 }, granaryBonus: { grain: 25 } } },
  ];
  for (const c of capsList) {
    for (const [口径, N] of [['N=∞', Infinity], ['N=1', 1]]) {
      const frozen = runFactory({ caps: c.caps, N });
      const adapted = runFactory({ caps: c.caps, N, adapt: true });
      console.log(JSON.stringify({
        档: c.id, 口径,
        冻结策略: { Lv4: frozen.lv4 ?? '❌', 最高: frozen.maxP, 闲置磨坊: frozen.idleMills, 粮仓: frozen.breakdown.granary ?? 0 },
        最小适配补仓: { Lv4: adapted.lv4 ?? '❌', 最高: adapted.maxP, 粮仓: adapted.breakdown.granary ?? 0, 终局: `${adapted.pop}户/${adapted.buildings}建筑` },
      }));
    }
  }
}
