// 追加：找出「验收 bot 还能自然通关」的 Lv4 阈值边界（给设计侧的可行性边界）
// 前置校准已通过：`scratch/verify-candidate-vs-acceptance.mjs` 的基线用例给出 12/315/515，
// 与 HANDOVER §5 / 验收文档记录的 bot 基线逐 tick 一致 ⇒ 本搬运式 harness 可信。
import { createInitialState } from '../src/core/state.js';
import { placeBuilding } from '../src/core/grid.js';
import { tick, housingCapacity, computeLevel } from '../src/core/simulation.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

// ---- 与验收用例逐字一致的 tryPlace / botBuild（源：tests/verification/progression.test.js:12-59）----
function tryPlace(state, type) {
  const def = BUILDINGS[type];
  for (let y = 0; y <= 32 - def.size[1]; y++)
    for (let x = 0; x <= 32 - def.size[0]; x++)
      if (placeBuilding(state, type, x, y).ok) return true;
  return false;
}
const countType = (state, t) => state.buildings.filter((b) => b.type === t).length;
function botBuild(state) {
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
function prosperityCapped(state, cap) {
  const c = RULES.prosperityCoef;
  let working = 0, housingScore = 0, housingCap = 0, passive = 0;
  for (const b of state.buildings) {
    const def = BUILDINGS[b.type];
    if (def.capacity > 0) { housingScore += def.score; housingCap += def.capacity; }
    else if (b.type === 'farm' || b.type === 'forest' || b.type === 'granary') passive += def.score;
    else working += def.score * (b.idle ? c.idle : c.active);
  }
  const occ = housingCap > 0 ? Math.min(1, state.population.count / housingCap) : 0;
  return Math.min(passive, cap) + working + housingScore * occ;
}
function play(state, maxTicks, capPassive, injectMoney = false) {
  if (injectMoney) state.money = 100000;
  const levelAt = { 2: null, 3: null, 4: null };
  let maxP = 0;
  for (let i = 0; i < maxTicks; i++) {
    botBuild(state);
    tick(state);
    if (capPassive != null) {
      state.prosperity = prosperityCapped(state, capPassive);
      state.level = computeLevel(state.prosperity);
      state.maxLevel = Math.max(state.maxLevel ?? state.level, state.level);
    }
    maxP = Math.max(maxP, state.prosperity);
    for (const lv of [2, 3, 4]) if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level >= 4) break;
  }
  return { levelAt, maxP, buildings: state.buildings.length, pop: state.population.count, cap: housingCapacity(state) };
}
// ---- 逐字搬运结束 ----

function snapshot() { return { t: [...RULES.unlockThresholds], m: RULES.moveInInterval }; }
function restore(s) { RULES.unlockThresholds.splice(0, 4, ...s.t); RULES.moveInInterval = s.m; }

const TICKS = 2000; // 与验收用例一致
const line = (s = '') => console.log(s);

line('# 验收 bot 的「Lv4 阈值可行性边界」扫描（2000 tick 预算，等于验收用例上限）');
line('');
line('问题：提高 Lv4 阈值到多少时，`tests/verification/progression.test.js` 的');
line('「bot 应自然攀升至 Lv4」断言会变红？（这套 bot 有硬上限，城市规模存在自封顶）');
line('');

function scan(label, { moveIn, capPassive }) {
  line(`### ${label}`);
  line('');
  line('| Lv4 阈值 | bot 到 Lv4 | 建筑 | 户 | 容量 | 最高繁荣度 | 验收用例 |');
  line('|---|---|---|---|---|---|---|');
  const bak = snapshot();
  for (const lv4 of [100, 110, 120, 130, 140, 150, 175, 200, 250]) {
    RULES.unlockThresholds.splice(0, 4, 0, 20, 50, lv4);
    RULES.moveInInterval = moveIn;
    const r = play(createInitialState(), TICKS, capPassive);
    restore(bak);
    const ok = r.levelAt[4] != null;
    line(`| ${lv4} | ${r.levelAt[4] ?? '**未到达**'} | ${r.buildings} | ${r.pop} | ${r.cap} | ${r.maxP.toFixed(1)} | ${ok ? '✅ PASS' : '❌ FAIL'} |`);
  }
  line('');
}

scan('A. 仅抬 Lv4 阈值（迁入 5，无封顶）', { moveIn: 5, capPassive: null });
scan('B. 迁入 5→8 + 抬 Lv4 阈值（无封顶）', { moveIn: 8, capPassive: null });
scan('C. P-1′ 口径（封顶 24 + 迁入 8 + 抬 Lv4 阈值）', { moveIn: 8, capPassive: 24 });

line('## 验收用例 3「注入 100000 铜钱」在 P-1′ 下的表现');
line('');
line('| 配置 | 到 Lv4 | 建筑 | 户 | 最高繁荣度 | 验收断言 |');
line('|---|---|---|---|---|---|');
for (const [label, th, mv, cp] of [
  ['现网基线', [0, 20, 50, 100], 5, null],
  ['P-1′ 主推', [0, 20, 60, 150], 8, 24],
  ['纯阈值 250', [0, 20, 50, 250], 5, null],
]) {
  const bak = snapshot();
  RULES.unlockThresholds.splice(0, 4, ...th);
  RULES.moveInInterval = mv;
  const r = play(createInitialState(), TICKS, cp, true);
  restore(bak);
  line(`| ${label}（注入铜钱） | ${r.levelAt[4] ?? '**未到达**'} | ${r.buildings} | ${r.pop} | ${r.maxP.toFixed(1)} | ${r.levelAt[4] != null ? '✅ PASS' : '❌ **FAIL**'} |`);
}
line('');
line('> 读法：用例 3 只解除铜钱约束，**不解除 bot 的硬上限与建筑配额**。若它也 FAIL，');
line('> 说明失败原因不是「钱不够」而是「bot 的城市规模被自身配额封顶」，属验收 Gate 的脆弱性而非方案不可达。');
