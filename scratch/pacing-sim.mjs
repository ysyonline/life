// 临时分析脚本（T-P6-05）：内存中覆盖 RULES 参数，跑 bot 通关推演估算调参影响。
// 不修改 src/config 与 tests/verification 下任何文件。运行：node scratch/pacing-sim.mjs
import { createInitialState } from '../src/core/state.js';
import { tick, housingCapacity, computeProsperity } from '../src/core/simulation.js';
import { placeBuilding } from '../src/core/grid.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

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

// 与 tests/verification/progression.test.js 完全一致的贪心 bot
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

// 模拟真人第 2 局的「刷分玩家」：优先大量铺食肆（超出劳力也照铺），住房仅保底
function spammerBuild(state) {
  const lvl = state.level;
  const cap = housingCapacity(state);
  const pop = state.population.count;
  const c = countType;
  const wants = [];
  if (c(state, 'farm') < 2) wants.push('farm');
  if (c(state, 'forest') < 2) wants.push('forest');
  if (c(state, 'mill') < 2) wants.push('mill');
  if (cap - pop < 2) wants.push('hut');
  if (state.resources.wood < 30 && c(state, 'forest') < 15) wants.push('forest');
  if (lvl >= 2 && c(state, 'eatery') < 17) wants.push('eatery'); // 刷分核心：铺 17 座
  if (state.resources.food < 20 && c(state, 'mill') < 6) wants.push('mill');
  if (state.resources.grain < 20 && c(state, 'farm') < 6) wants.push('farm');
  if (lvl >= 3 && c(state, 'carpenter') < 6) wants.push('carpenter');
  if (lvl >= 4 && c(state, 'grocer') < 8) wants.push('grocer');
  for (const t of wants) if (tryPlace(state, t)) return t;
  return null;
}

function playthrough(state, maxTicks, bot) {
  const levelAt = { 2: null, 3: null, 4: null };
  let maxProsperity = 0;
  for (let i = 0; i < maxTicks; i++) {
    bot(state);
    tick(state);
    maxProsperity = Math.max(maxProsperity, state.prosperity);
    for (const lv of [2, 3, 4])
      if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level >= 4) break;
  }
  return { levelAt, maxProsperity, finalLevel: state.level, state };
}

function scenario(name, overrides, bot = botBuild) {
  const saved = {
    idle: RULES.prosperityCoef.idle,
    thresholds: [...RULES.unlockThresholds],
    moveIn: RULES.moveInInterval,
  };
  if (overrides.idle !== undefined) RULES.prosperityCoef.idle = overrides.idle;
  if (overrides.thresholds) RULES.unlockThresholds = overrides.thresholds;
  if (overrides.moveIn) RULES.moveInInterval = overrides.moveIn;

  const state = createInitialState();
  const r = playthrough(state, 3000, bot);
  const idleScore = state.buildings
    .filter((b) => b.idle)
    .reduce((s, b) => s + BUILDINGS[b.type].score * RULES.prosperityCoef.idle, 0);
  console.log(JSON.stringify({
    场景: name,
    到Lv2: r.levelAt[2], 到Lv3: r.levelAt[3], 到Lv4: r.levelAt[4],
    最终等级: r.finalLevel, 终局繁荣: +state.prosperity.toFixed(1),
    终局: { money: +state.money.toFixed(0), pop: state.population.count, 建筑数: state.buildings.length },
    终局闲置建筑分: +idleScore.toFixed(1),
  }));

  RULES.prosperityCoef.idle = saved.idle;
  RULES.unlockThresholds = saved.thresholds;
  RULES.moveInInterval = saved.moveIn;
}

console.log('--- 正常 bot（= 验收 bot 复制品） ---');
scenario('A 基线 idle=0.3 阈值20/50/100', {});
scenario('B 仅堵口 idle=0', { idle: 0 });
scenario('C idle=0 + Lv2阈值30', { idle: 0, thresholds: [0, 30, 50, 100] });
scenario('D idle=0 + Lv2=30 + Lv4=120', { idle: 0, thresholds: [0, 30, 50, 120] });
scenario('E idle=0 + Lv2=30 + 迁入间隔6', { idle: 0, thresholds: [0, 30, 50, 100], moveIn: 6 });
scenario('F 软堵口 idle=0.1 + Lv2=30', { idle: 0.1, thresholds: [0, 30, 50, 100] });
scenario('G 仅提阈值 idle=0.3 + Lv2=30', { thresholds: [0, 30, 50, 100] });
console.log('--- 刷分 bot（模拟真人第 2 局：铺 17 座食肆） ---');
scenario('H 刷分@基线 idle=0.3', {}, spammerBuild);
scenario('I 刷分@堵口 idle=0', { idle: 0 }, spammerBuild);
scenario('J 刷分@idle=0+Lv2=30', { idle: 0, thresholds: [0, 30, 50, 100] }, spammerBuild);
