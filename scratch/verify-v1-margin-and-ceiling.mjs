// 两项增量核查（T-P6-08 后续，quality-lead；只读 src/，不写 src/ 与 tests/）
// A. 核实 design-strategist 报的「用例 3（注入铜钱）现网余量仅 1.08 分」——即 101.08 vs 阈值 100
// B. 核实其 N3「杂货摊鸡生蛋」的结构性事实，并分解验收 bot 的「Lv4 前可达分数天花板」
import { createInitialState } from '../src/core/state.js';
import { placeBuilding } from '../src/core/grid.js';
import { tick, housingCapacity, computeLevel } from '../src/core/simulation.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

const line = (s = '') => console.log(s);

// ---- 与验收用例逐字一致的 tryPlace / botBuild（源：tests/verification/progression.test.js:12-59，只读）----
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
function play(state, maxTicks) {
  const levelAt = { 2: null, 3: null, 4: null };
  let maxP = 0, peakPop = 0;
  const bdAtMax = {};
  for (let i = 0; i < maxTicks; i++) {
    botBuild(state);
    tick(state);
    if (state.prosperity > maxP) {
      maxP = state.prosperity;
      for (const k in bdAtMax) delete bdAtMax[k];
      for (const b of state.buildings) bdAtMax[b.type] = (bdAtMax[b.type] ?? 0) + 1;
    }
    peakPop = Math.max(peakPop, state.population.count);
    for (const lv of [2, 3, 4]) if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level >= 4) break;
  }
  return { levelAt, maxP, peakPop, bdAtMax, finalBd: (() => { const o = {}; for (const b of state.buildings) o[b.type] = (o[b.type] ?? 0) + 1; return o; })() };
}
// ---- 逐字搬运结束 ----

line('# A. 用例 3「注入 100000 铜钱」的现网余量核实');
line('');
line('> 该用例断言"能到 Lv4"，但没约束余量。若余量极小，任何压低繁荣度的改动都会静默踩破它。');
line('');
const s1 = createInitialState();
s1.money = 100000;
const r1 = play(s1, 2000);
line(`- 到 Lv4 @ tick **${r1.levelAt[4]}**`);
line(`- 全程最高繁荣度 = **${r1.maxP.toFixed(2)}**`);
line(`- Lv4 阈值 = ${RULES.unlockThresholds[3]}`);
line(`- **余量 = ${(r1.maxP - RULES.unlockThresholds[3]).toFixed(2)} 分** （占阈值的 ${(((r1.maxP - RULES.unlockThresholds[3]) / RULES.unlockThresholds[3]) * 100).toFixed(2)}%）`);
line(`- 峰值户数 = ${r1.peakPop}`);
line(`- 最高分时刻的构成：${JSON.stringify(r1.bdAtMax)}`);
line('');

line('## A2. 用例 2（自然通关，不注资）的余量对照');
line('');
const s2 = createInitialState();
const r2 = play(s2, 2000);
line(`- 到 Lv4 @ tick ${r2.levelAt[4]}｜最高繁荣度 ${r2.maxP.toFixed(2)}｜余量 ${(r2.maxP - RULES.unlockThresholds[3]).toFixed(2)} 分`);
line('');

line('# B. N3「杂货摊鸡生蛋」结构核实 + bot 的「Lv4 前可达分数天花板」分解');
line('');
line('## B1. 结构事实：杂货摊是 Lv4 才解锁 ⇒ 它的分数对"到达 Lv4"这件事永远为 0');
line('');
line('| 建筑 | score | unlockLevel | 验收 bot 的建造上限 | 上限内总分 | 到达 Lv4 **之前**能否贡献 |');
line('|---|---|---|---|---|---|');
let reachPre = 0, deadPre = 0;
const botCap = { hut: Infinity, house: Infinity, farm: 6, forest: 12, mill: 6, eatery: 6, carpenter: 6, granary: 1, grocer: 8 };
for (const [id, d] of Object.entries(BUILDINGS)) {
  const capN = botCap[id];
  const total = capN === Infinity ? '无硬上限（受人口驱动）' : `${capN} × ${d.score} = ${capN * d.score}`;
  const preOK = d.unlockLevel < 4;
  if (preOK && capN !== Infinity) reachPre += capN * d.score;
  if (!preOK && capN !== Infinity) deadPre += capN * d.score;
  line(`| ${id} | ${d.score} | Lv${d.unlockLevel} | ${capN === Infinity ? '—' : capN} | ${total} | ${preOK ? '✅ 能' : '❌ **不能**（Lv4 才解锁）'} |`);
}
line('');
line(`⇒ 被"鸡生蛋"锁死的分数（杂货摊 8 座 × 6 分）= **${deadPre} 分**，对"到达 Lv4"完全不可达。`);
line(`⇒ bot 在 Lv4 前的**固定配额**分数上限 ≈ ${reachPre} 分（不含无硬上限的茅舍/瓦屋）。`);
line('');

line('## B2. bot 实测天花板与其硬配额的对照（解释"为什么卡在 ~146~150"）');
line('');
const s3 = createInitialState();
// 用极高的 Lv4 阈值让 bot 一路建到配额打满，观察它能堆到多少分
const bak = [...RULES.unlockThresholds];
RULES.unlockThresholds.splice(0, 4, 0, 20, 60, 100000);
const r3 = play(s3, 3000);
RULES.unlockThresholds.splice(0, 4, ...bak);
line(`- 把 Lv4 阈值设成不可达（100000）后，bot 在 3000 tick 内堆到的最高繁荣度 = **${r3.maxP.toFixed(2)}**`);
line(`- 峰值户数 = ${r3.peakPop}`);
line(`- 终局构成：${JSON.stringify(r3.finalBd)}`);
line('');
let housingPts = 0;
for (const [t, n] of Object.entries(r3.finalBd)) {
  if (t === 'hut' || t === 'house') housingPts += BUILDINGS[t].score * n;
}
line(`⇒ 其中民居贡献 ${housingPts} 分（茅舍/瓦屋无硬上限，随人口增长）；固定配额部分 ≈ ${(reachPre)} 分。`);
line(`⇒ **bot 的 Lv4 前分数天花板 ≈ ${(reachPre + housingPts).toFixed(0)} 分**（≈固定配额 ${reachPre} + 民居 ${housingPts}），`);
line(`   这与实测边界（A 口径上限 145.9、B 口径 150.2）吻合 ⇒ **边界不是"时间不够"，是分数被配额封顶**。`);
line('');
line('> 推论：这条解释了 §6.7 那个反直觉现象——"把 Lv3 也抬到 60 反而能过 Lv4=150"。');
line('> 因为抬 Lv3 推迟了木匠铺/瓦屋的解锁时机，改变了建造顺序，终局户数从 23 变 75，');
line('> 而**民居分是唯一不受硬配额限制的部分**，户数上去了，分数天花板才跟着上去。');
