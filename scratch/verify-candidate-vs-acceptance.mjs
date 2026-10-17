// 候选方案对「独立验收套件」的冲击预检（T-P6-08 补充，quality-lead）
// 目的：设计侧主推 P-1′（恒计分封顶 24 + 阈值 60/150 + 迁入 5→8）尚未有人验过它对
//       tests/verification/progression.test.js 的影响。按 playtest-protocol 规则 4
//       「任何杠杆动后必须重跑验收确认 bot 仍自然通关 Lv4」，这是实施前的必检项。
//
// 方法：把 tests/verification/progression.test.js 的 tryPlace / botBuild / playthrough
//       逐字搬到本文件（源只读，未修改任何 tests/ 文件），在内存中覆盖 RULES 与繁荣度公式，
//       跑真实引擎 tick()（不是自己写的模拟器），观察各候选配置下验收 bot 能否在 2000 tick 内通关。
// 纪律：只读 src/，只在 scratch/ 落地，不写 src/ 与 tests/。
import { createInitialState } from '../src/core/state.js';
import { placeBuilding, genTerrain } from '../src/core/grid.js';
import { tick, housingCapacity, computeLevel } from '../src/core/simulation.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

// ---------- 以下三段逐字来自 tests/verification/progression.test.js: 12-73（源只读） ----------
function tryPlace(state, type) {
  const def = BUILDINGS[type];
  const size = 32;
  for (let y = 0; y <= size - def.size[1]; y++)
    for (let x = 0; x <= size - def.size[0]; x++)
      if (placeBuilding(state, type, x, y).ok) return true;
  return false;
}

const countType = (state, t) => state.buildings.filter((b) => b.type === t).length;

// 贪心 bot：每 tick 至多建造 1 座。住房优先保人口（人口=劳力+市税，是一切的前提），
// 粮线/木线自适应补产能，按解锁等级扩张商业。
function botBuild(state) {
  const lvl = state.level;
  const cap = housingCapacity(state);
  const pop = state.population.count;
  const c = countType;
  const wants = [];

  // 住房最优先：没有人口就没有劳力与市税
  if (cap - pop < 2) wants.push(lvl >= 3 && state.money > 120 ? 'house' : 'hut');
  // 自适应补链：食/粮/木低于安全库存时补上游（林场上限放宽，匹配木匠铺的耗木速度）
  if (state.resources.food < 20 && c(state, 'mill') < 6) wants.push('mill');
  if (state.resources.grain < 20 && c(state, 'farm') < 6) wants.push('farm');
  if (state.resources.wood < 20 && c(state, 'forest') < 12) wants.push('forest');
  // 基础产能
  if (c(state, 'farm') < 2) wants.push('farm');
  if (c(state, 'forest') < 2) wants.push('forest');
  if (c(state, 'mill') < 2) wants.push('mill');
  // 商业扩张
  if (lvl >= 2 && c(state, 'eatery') < 3) wants.push('eatery');
  if (lvl >= 2 && c(state, 'granary') < 1) wants.push('granary');
  if (lvl >= 3 && c(state, 'carpenter') < 2) wants.push('carpenter');
  if (lvl >= 4 && c(state, 'grocer') < 4) wants.push('grocer');
  // 后期规模化
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

function playthrough(state, maxTicks, capPassive) {
  const levelAt = { 2: null, 3: null, 4: null };
  let maxProsperity = 0;
  let levelDrops = 0;
  let prevLevel = 1;
  for (let i = 0; i < maxTicks; i++) {
    botBuild(state);
    tick(state);
    // 若候选方案含「恒计分封顶」，按提议公式覆盖 tick() 算出的繁荣度与等级
    if (capPassive != null) {
      state.prosperity = prosperityCapped(state, capPassive);
      state.level = computeLevel(state.prosperity);
      state.maxLevel = Math.max(state.maxLevel ?? state.level, state.level);
    }
    maxProsperity = Math.max(maxProsperity, state.prosperity);
    if (state.level < prevLevel) levelDrops++;
    prevLevel = state.level;
    for (const lv of [2, 3, 4])
      if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level >= 4) break;
  }
  return { levelAt, maxProsperity, finalLevel: state.level, levelDrops };
}
// ---------- 逐字搬运结束 ----------

// 候选方案的繁荣度公式：农田+林场+粮仓（恒计分、永不受 idle 影响）合计封顶
function prosperityCapped(state, cap) {
  const c = RULES.prosperityCoef;
  let working = 0;
  let housingScore = 0;
  let housingCap = 0;
  let passive = 0;
  for (const b of state.buildings) {
    const def = BUILDINGS[b.type];
    if (def.capacity > 0) {
      housingScore += def.score;
      housingCap += def.capacity;
    } else if (b.type === 'farm' || b.type === 'forest' || b.type === 'granary') {
      passive += def.score;
    } else {
      working += def.score * (b.idle ? c.idle : c.active);
    }
  }
  const occ = housingCap > 0 ? Math.min(1, state.population.count / housingCap) : 0;
  return Math.min(passive, cap) + working + housingScore * occ;
}

function snapshot() {
  return {
    thresholds: [...RULES.unlockThresholds],
    moveIn: RULES.moveInInterval,
  };
}
function restore(s) {
  RULES.unlockThresholds.splice(0, 4, ...s.thresholds);
  RULES.moveInInterval = s.moveIn;
}

function run(label, { thresholds, moveIn, capPassive }, maxTicks = 2000) {
  const bak = snapshot();
  if (thresholds) RULES.unlockThresholds.splice(0, 4, ...thresholds);
  if (moveIn != null) RULES.moveInInterval = moveIn;
  const state = createInitialState();
  const r = playthrough(state, maxTicks, capPassive);
  const bd = {};
  for (const b of state.buildings) bd[b.type] = (bd[b.type] ?? 0) + 1;
  restore(bak);
  return { label, levelAt: r.levelAt, maxProsperity: r.maxProsperity, finalLevel: r.finalLevel, levelDrops: r.levelDrops, buildings: state.buildings.length, pop: state.population.count, bd, money: state.money };
}

const line = (s = '') => console.log(s);
line('# 候选方案 × 独立验收 bot 的冲击预检（逐字搬运 tests/verification 的 bot）');
line(`生成时间：${new Date().toISOString()}`);
line('');
line('> 说明：bot 逻辑逐字来自 `tests/verification/progression.test.js:12-73`（只读源，未改动）；');
line('> 引擎是真跑 `tick(state)`，繁荣度公式为 P-1′ 提议式覆盖。预算上限与验收用例一致：**2000 tick**。');
line('');

const cases = [
  { label: '① 现网基线（阈值 20/50/100，迁入 5，无封顶）', cfg: { thresholds: [0, 20, 50, 100], moveIn: 5, capPassive: null } },
  { label: '② 仅封顶 24（阈值/迁入不变）', cfg: { thresholds: [0, 20, 50, 100], moveIn: 5, capPassive: 24 } },
  { label: '③ 仅阈值 60/150', cfg: { thresholds: [0, 20, 60, 150], moveIn: 5, capPassive: null } },
  { label: '④ 仅迁入 5→8', cfg: { thresholds: [0, 20, 50, 100], moveIn: 8, capPassive: null } },
  { label: '⑤ 阈值 60/150 + 迁入 5→8（无封顶）', cfg: { thresholds: [0, 20, 60, 150], moveIn: 8, capPassive: null } },
  { label: '⑥ **P-1′ 主推全套**（封顶 24 + 阈值 60/150 + 迁入 8）', cfg: { thresholds: [0, 20, 60, 150], moveIn: 8, capPassive: 24 } },
  { label: '⑦ 对照组：纯阈值 Lv4=250（design-strategist §5.5）', cfg: { thresholds: [0, 20, 50, 250], moveIn: 5, capPassive: null } },
];

line('| 配置 | Lv2 | Lv3 | Lv4 | 最高繁荣度 | 终局等级 | 等级回落 | 建筑 | 户 | 验收断言「2000 tick 内到 Lv4」 |');
line('|---|---|---|---|---|---|---|---|---|---|');
const results = {};
for (const c of cases) {
  const r = run(c.label, c.cfg);
  results[c.label] = r;
  const ok = r.levelAt[4] != null;
  const f = (v) => (v == null ? '**未到达**' : v);
  line(
    `| ${c.label} | ${f(r.levelAt[2])} | ${f(r.levelAt[3])} | ${f(r.levelAt[4])} | ${r.maxProsperity.toFixed(1)} | ${r.finalLevel} | ${r.levelDrops} | ${r.buildings} | ${r.pop} | ${ok ? '✅ PASS' : '❌ **FAIL**'} |`
  );
}
line('');

// 诊断：给 FAIL 的配置放宽 tick 上限，看它到底是「到不了」还是「只是慢」
line('## 诊断：FAIL 配置放宽到 8000 tick（区分「不可达」与「只是慢」）');
line('');
line('| 配置 | Lv4 @ | 建筑 | 户 | 最高繁荣度 |');
line('|---|---|---|---|---|');
for (const c of cases) {
  const r = results[c.label];
  if (r.levelAt[4] != null) continue;
  const long = run(c.label, c.cfg, 8000);
  line(`| ${c.label} | ${long.levelAt[4] ?? '8000 内仍未到达'} | ${long.buildings} | ${long.pop} | ${long.maxProsperity.toFixed(1)} |`);
}
line('');

// P-1′ 终局构成（用于对照 design-strategist 的 83 座/82 户）
const p1 = results['⑥ **P-1′ 主推全套**（封顶 24 + 阈值 60/150 + 迁入 8）'];
line(`## P-1′ 下验收 bot 的终局构成：${p1.buildings} 座 / ${p1.pop} 户`);
line('');
line('```');
line(JSON.stringify(p1.bd));
line('```');
line('');

// ---------- 地图物理容量硬约束 ----------
line('## 地图物理容量硬约束（model seed 20261016，确定性）');
const terrain = genTerrain(32);
const counts = { plain: 0, fertile: 0, woodland: 0 };
for (const row of terrain) for (const t of row) counts[t]++;
// 2×2 建筑在指定地形上最多能放几座（贪心估计，按行列扫描取不重叠 2×2 块）
function maxPlacements(terr) {
  const used = Array.from({ length: 32 }, () => Array(32).fill(false));
  let n = 0;
  for (let y = 0; y < 31; y++) {
    for (let x = 0; x < 31; x++) {
      let ok = true;
      for (let dy = 0; dy < 2 && ok; dy++)
        for (let dx = 0; dx < 2; dx++)
          if (terrain[y + dy][x + dx] !== terr || used[y + dy][x + dx]) { ok = false; break; }
      if (ok) {
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) used[y + dy][x + dx] = true;
        n++;
      }
    }
  }
  return n;
}
line('');
line(`- 地图 32×32 = 1024 格：普通地 ${counts.plain} ／ 沃土 ${counts.fertile} ／ 林地 ${counts.woodland}`);
line(`- 沃土最多可放 2×2 **农田**：约 ${maxPlacements('fertile')} 座`);
line(`- 林地最多可放 2×2 **林场**：约 ${maxPlacements('woodland')} 座`);
line(`- ⇒ 农田+林场合计硬上限 ≈ ${maxPlacements('fertile') + maxPlacements('woodland')} 座（每座 2 分 ⇒ 恒计分物理天花板 ≈ ${(maxPlacements('fertile') + maxPlacements('woodland')) * 2} 分）`);
line(`- 参考：P-1′ 封顶取 24 分 = ${24 / 2} 座原料建筑的分数。**封顶值 vs 物理天花板** 的比值 = ${(24 / ((maxPlacements('fertile') + maxPlacements('woodland')) * 2) * 100).toFixed(0)}%`);
line('');
line('> 这条约束决定「封顶 24」是软约束还是几乎不可达的松约束：若物理天花板远高于封顶值，');
line('> 则封顶确实会咬到最优路线；若天花板本就接近封顶值，则该杠杆的实际约束力需要重新估计。');
