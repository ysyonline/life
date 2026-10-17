// 独立验收：完整通关推演
// 目标：证明（或证伪）从初始状态（铜钱100/木50/粮20/食15）出发，
// 核心循环能自然攀升到繁荣度 Lv4（设计案 5.4：约 5 分钟 Lv2 / 15 分钟 Lv3 / 25 分钟 Lv4，1 tick = 1 秒）
import { describe, it, expect } from 'vitest';
import { createInitialState } from '../../src/core/state.js';
import { tick, housingCapacity } from '../../src/core/simulation.js';
import { placeBuilding } from '../../src/core/grid.js';
import { BUILDINGS } from '../../src/config/buildings.js';
import { RULES } from '../../src/config/rules.js';

// ---------- 工具 ----------
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

function playthrough(state, maxTicks) {
  const levelAt = { 2: null, 3: null, 4: null };
  let maxProsperity = 0;
  for (let i = 0; i < maxTicks; i++) {
    botBuild(state);
    tick(state);
    maxProsperity = Math.max(maxProsperity, state.prosperity);
    for (const lv of [2, 3, 4])
      if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level >= 4) break;
  }
  return { levelAt, maxProsperity, finalLevel: state.level };
}

// ---------- 用例 ----------
describe('通关推演（独立验收）', () => {
  it('上界证明：Lv1 可建建筑在初始铜钱预算内的最大繁荣度（0-1 背包，忽略木材/劳力约束取最宽松上界）', () => {
    // Lv1 可建：hut/farm/forest/mill；建筑自身不产铜钱（市税挂在人口上，不在建筑 outputs 里）
    const lv1 = Object.entries(BUILDINGS).filter(([, d]) => d.unlockLevel === 1);
    const hasMoneyIncome = lv1.some(([, d]) => (d.outputs?.money ?? 0) > 0);
    expect(hasMoneyIncome).toBe(false);

    const budget = RULES.initialMoney; // v0.3：240
    let best = 0;
    for (let hut = 0; hut <= 24; hut++)
      for (let farm = 0; farm <= 16; farm++)
        for (let forest = 0; forest <= 16; forest++)
          for (let mill = 0; mill <= 8; mill++) {
            const money =
              hut * BUILDINGS.hut.cost.money +
              farm * BUILDINGS.farm.cost.money +
              forest * BUILDINGS.forest.cost.money +
              mill * BUILDINGS.mill.cost.money;
            if (money > budget) continue;
            const score =
              hut * BUILDINGS.hut.score +
              farm * BUILDINGS.farm.score +
              forest * BUILDINGS.forest.score +
              mill * BUILDINGS.mill.score;
            best = Math.max(best, score);
          }
    console.log(`[验收] Lv1 理论最大繁荣度 = ${best}（预算 ${budget}，Lv2 阈值 = ${RULES.unlockThresholds[1]}）`);
    // 设计案 5.4 要求可达 Lv2。若上界 < 阈值，则 Lv1→Lv2 在数学上不可能。
    expect(best).toBeGreaterThanOrEqual(RULES.unlockThresholds[1]);
  });

  it('实测：bot 从初始状态游玩 2000 tick（约 33 分钟），应自然攀升至 Lv4', () => {
    const state = createInitialState();
    const r = playthrough(state, 2000);
    console.log('[验收] 初始资源通关推演:', JSON.stringify({
      到Lv2: r.levelAt[2], 到Lv3: r.levelAt[3], 到Lv4: r.levelAt[4],
      最终等级: r.finalLevel, 最高繁荣度: r.maxProsperity,
      设计目标: { Lv2: 300, Lv3: 900, Lv4: 1500 },
      终局: { money: state.money, pop: state.population.count, 建筑数: state.buildings.length },
    }));
    expect(r.levelAt[2]).not.toBeNull();
    expect(r.levelAt[3]).not.toBeNull();
    expect(r.levelAt[4]).not.toBeNull();
  });

  it('对照实验：注入足额初始铜钱（设计案 4.1 允许的跳中期手段），隔离验证 Lv2→Lv4 链路是否走得通', () => {
    const state = createInitialState();
    state.money = 100000; // 只解除铜钱约束，木材仍靠林场，人口仍靠迁入
    const r = playthrough(state, 2000);
    console.log('[验收] 注入铜钱通关推演:', JSON.stringify({
      到Lv2: r.levelAt[2], 到Lv3: r.levelAt[3], 到Lv4: r.levelAt[4],
      最终等级: r.finalLevel, 最高繁荣度: r.maxProsperity,
      终局: { pop: state.population.count, 建筑数: state.buildings.length },
    }));
    expect(r.levelAt[4]).not.toBeNull();
  });
});
