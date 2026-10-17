// 临时分析脚本 v2（T-P6-05）：验证组合拳「M1 闲置不计分 + M2 民居按入住率计分」。
// 通过自定义繁荣度公式包一层 tick 来模拟 core 改动；不改 src/tests 任何文件。
// 运行：node scratch/pacing-sim2.mjs
import { createInitialState } from '../src/core/state.js';
import { tick, housingCapacity, computeLevel } from '../src/core/simulation.js';
import { placeBuilding } from '../src/core/grid.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

// ---- 候选新公式：生产建筑闲置计 0；民居分 × 入住率（户数/容量，封顶 1）；农田/林场/粮仓不变 ----
function prosperityV2(state, opts) {
  let fixed = 0, housingScore = 0;
  for (const b of state.buildings) {
    const def = BUILDINGS[b.type];
    if (def.capacity > 0) { housingScore += def.score; continue; }
    fixed += def.score * (b.idle ? opts.idleCoef : 1);
  }
  if (!opts.occupancy) return fixed + housingScore;
  const cap = housingCapacity(state);
  const occ = cap > 0 ? Math.min(1, state.population.count / cap) : 0;
  return fixed + housingScore * occ;
}

function tickV2(state, opts) {
  tick(state); // 真实结算（含旧公式写 prosperity/level）
  if (opts.v2) {
    state.prosperity = prosperityV2(state, opts);
    state.level = computeLevel(state.prosperity);
  }
}

function tryPlace(state, type) {
  const def = BUILDINGS[type];
  const [w, h] = def.size;
  const size = RULES.mapSize;
  for (let y = 0; y <= size - h; y++)
    for (let x = 0; x <= size - w; x++)
      if (placeBuilding(state, type, x, y).ok) return true;
  return false;
}
const countType = (state, t) => state.buildings.filter((b) => b.type === t).length;

// 验收 bot（与 progression.test.js 一致）
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

// 真人第 2 局画像复刻：住房摆烂（终局 8 户/26 容量），铺 17 食肆刷分
function humanSpamBuild(state) {
  const lvl = state.level;
  const c = countType;
  const wants = [];
  if (c(state, 'farm') < 3) wants.push('farm');
  if (c(state, 'hut') < 5) wants.push('hut');
  if (c(state, 'forest') < 3) wants.push('forest');
  if (c(state, 'mill') < 1) wants.push('mill');
  if (lvl >= 2 && c(state, 'granary') < 2) wants.push('granary');
  if (lvl >= 2 && c(state, 'eatery') < 17) wants.push('eatery');
  if (state.resources.food < 10 && c(state, 'mill') < 4) wants.push('mill');
  if (state.resources.grain < 20 && c(state, 'farm') < 7) wants.push('farm');
  if (state.resources.wood < 30 && c(state, 'forest') < 6) wants.push('forest');
  if (lvl >= 3 && c(state, 'carpenter') < 3) wants.push('carpenter');
  if (lvl >= 3 && c(state, 'house') < 3 && state.money > 150) wants.push('house');
  if (c(state, 'hut') < 7) wants.push('hut');
  for (const t of wants) if (tryPlace(state, t)) return t;
  return null;
}

// 空茅舍刷分 bot：产业链只保基本盘，有钱就买茅舍
function hutSpamBuild(state) {
  const lvl = state.level;
  const c = countType;
  const wants = [];
  if (c(state, 'farm') < 3) wants.push('farm');
  if (c(state, 'forest') < 3) wants.push('forest');
  if (c(state, 'mill') < 2) wants.push('mill');
  if (c(state, 'hut') < 6) wants.push('hut');
  if (lvl >= 2 && c(state, 'eatery') < 6) wants.push('eatery');
  if (lvl >= 3 && c(state, 'carpenter') < 4) wants.push('carpenter');
  if (lvl >= 4 && c(state, 'grocer') < 4) wants.push('grocer');
  if (state.resources.wood < 30 && c(state, 'forest') < 12) wants.push('forest');
  if (state.money > 40 && state.resources.wood > 20 && c(state, 'hut') < 80) wants.push('hut');
  for (const t of wants) if (tryPlace(state, t)) return t;
  return null;
}

function playthrough(state, maxTicks, bot, opts) {
  const levelAt = { 2: null, 3: null, 4: null };
  let maxLevel = 1, downgrades = 0;
  for (let i = 0; i < maxTicks; i++) {
    bot(state);
    tickV2(state, opts);
    for (const lv of [2, 3, 4])
      if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level < maxLevel) downgrades++;
    maxLevel = Math.max(maxLevel, state.level);
    if (state.level >= 4) break;
  }
  return { levelAt, downgrades };
}

function scenario(name, opts, bot) {
  const state = createInitialState();
  const r = playthrough(state, 3000, bot, opts);
  const cap = housingCapacity(state);
  console.log(JSON.stringify({
    场景: name,
    到Lv2: r.levelAt[2], 到Lv3: r.levelAt[3], 到Lv4: r.levelAt[4],
    等级回落次数: r.downgrades,
    终局繁荣: +state.prosperity.toFixed(1),
    终局: { money: +state.money.toFixed(0), pop: state.population.count, cap, 建筑数: state.buildings.length },
  }));
}

console.log('--- 正常 bot ---');
scenario('A 基线（旧公式）', { v2: false }, botBuild);
scenario('B M1+M2 idle=0+入住率', { v2: true, idleCoef: 0, occupancy: true }, botBuild);
scenario('C M2 仅入住率（idle 仍 0.3）', { v2: true, idleCoef: 0.3, occupancy: true }, botBuild);
console.log('--- 真人第 2 局画像（17 食肆刷分） ---');
scenario('D 旧公式（应复现 ≈380 通关）', { v2: false }, humanSpamBuild);
scenario('E M1 仅闲置=0（茅舍仍满分）', { v2: true, idleCoef: 0, occupancy: false }, humanSpamBuild);
scenario('E2 M1+M2 组合拳', { v2: true, idleCoef: 0, occupancy: true }, humanSpamBuild);
console.log('--- 空茅舍刷分 bot ---');
scenario('F 旧公式', { v2: false }, hutSpamBuild);
scenario('G M1 仅闲置=0', { v2: true, idleCoef: 0, occupancy: false }, hutSpamBuild);
scenario('H M1+M2 组合拳', { v2: true, idleCoef: 0, occupancy: true }, hutSpamBuild);
