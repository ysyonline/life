// 临时分析脚本 v3（T-P6-05）：组合拳 + Lv2 阈值微调对 Lv1 段的影响；粮仓刷分残余口子探测。
// 运行：node scratch/pacing-sim3.mjs
import { createInitialState } from '../src/core/state.js';
import { tick, housingCapacity, computeLevel } from '../src/core/simulation.js';
import { placeBuilding } from '../src/core/grid.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

function prosperityV2(state) {
  let fixed = 0, housingScore = 0;
  for (const b of state.buildings) {
    const def = BUILDINGS[b.type];
    if (def.capacity > 0) { housingScore += def.score; continue; }
    fixed += def.score * (b.idle ? 0 : 1);
  }
  const cap = housingCapacity(state);
  const occ = cap > 0 ? Math.min(1, state.population.count / cap) : 0;
  return fixed + housingScore * occ;
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

// 粮仓刷分探测：组合拳下，有钱就囤粮仓（粮仓不占地形、恒计分）
function granarySpamBuild(state) {
  const lvl = state.level;
  const cap = housingCapacity(state);
  const pop = state.population.count;
  const c = countType;
  const wants = [];
  if (cap - pop < 2) wants.push('hut');
  if (c(state, 'farm') < 3) wants.push('farm');
  if (c(state, 'forest') < 3) wants.push('forest');
  if (c(state, 'mill') < 2) wants.push('mill');
  if (lvl >= 2 && c(state, 'eatery') < 6) wants.push('eatery');
  if (state.resources.wood < 40 && c(state, 'forest') < 12) wants.push('forest');
  if (lvl >= 3 && c(state, 'carpenter') < 4) wants.push('carpenter');
  if (lvl >= 4 && c(state, 'grocer') < 4) wants.push('grocer');
  if (lvl >= 2 && state.money > 60 && state.resources.wood > 45 && c(state, 'granary') < 30) wants.push('granary');
  for (const t of wants) if (tryPlace(state, t)) return t;
  return null;
}

function playthrough(state, maxTicks, bot) {
  const levelAt = { 2: null, 3: null, 4: null };
  let maxLevel = 1, downgrades = 0;
  for (let i = 0; i < maxTicks; i++) {
    bot(state);
    tick(state);
    state.prosperity = prosperityV2(state);
    state.level = computeLevel(state.prosperity);
    for (const lv of [2, 3, 4])
      if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level < maxLevel) downgrades++;
    maxLevel = Math.max(maxLevel, state.level);
    if (state.level >= 4) break;
  }
  return { levelAt, downgrades };
}

function scenario(name, thresholds, bot) {
  const saved = [...RULES.unlockThresholds];
  RULES.unlockThresholds = thresholds;
  const state = createInitialState();
  const r = playthrough(state, 3000, bot);
  console.log(JSON.stringify({
    场景: name, 到Lv2: r.levelAt[2], 到Lv3: r.levelAt[3], 到Lv4: r.levelAt[4],
    回落: r.downgrades, 终局繁荣: +state.prosperity.toFixed(1),
    终局: { money: +state.money.toFixed(0), pop: state.population.count, 建筑数: state.buildings.length },
  }));
  RULES.unlockThresholds = saved;
}

console.log('--- 组合拳（idle=0 + 入住率）下正常 bot，Lv2 阈值扫描 ---');
scenario('阈值 20/50/100', [0, 20, 50, 100], botBuild);
scenario('阈值 25/50/100', [0, 25, 50, 100], botBuild);
scenario('阈值 30/50/100', [0, 30, 50, 100], botBuild);
scenario('阈值 30/60/100', [0, 30, 60, 100], botBuild);
scenario('阈值 30/60/120', [0, 30, 60, 120], botBuild);
console.log('--- 残余口子探测：粮仓刷分（组合拳 + 20/50/100） ---');
scenario('粮仓刷分 bot', [0, 20, 50, 100], granarySpamBuild);
