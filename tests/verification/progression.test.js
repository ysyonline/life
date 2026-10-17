// 独立验收：完整通关推演
// 目标：证明（或证伪）从初始状态（铜钱100/木50/粮20/食15）出发，
// 核心循环能自然攀升到繁荣度 Lv4（设计案 5.4：约 5 分钟 Lv2 / 15 分钟 Lv3 / 25 分钟 Lv4，1 tick = 1 秒）
import { describe, it, expect } from 'vitest';
import { createInitialState } from '../../src/core/state.js';
import { tick, housingCapacity, computeCaps } from '../../src/core/simulation.js';
import { placeBuilding, demolishBuilding } from '../../src/core/grid.js';
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

// ---------- 归档：旧版验收 bot（botBuildLegacy） ----------
// 【历史基线归档 2026-10-17，D0 拍板选 A 后由 botBuild 接任】
// 旧 bot 的历史读数（现网配置 20/50/100、迁入 5）：
//   V2 初始资源通关 = Lv2@12 / Lv3@315 / Lv4@515
//   V1 注入铜钱 100000 = Lv4@91
// 撤换原因（三方独立复核一致，见 docs/design/03-pacing-postmortem-round2.md 与
// docs/tech/02-p1-implementation-impact.md §8.2/§8.9）：写死硬上限
// （mill<6 / farm<6 / forest<12 / eatery<6 / carpenter<6 / granary<1 / grocer<8）
// 且从不拆除，终局 0 食肆 / 0 粮仓 / 0 杂货摊、收入 100% 市税，是"自我饿死"路线，
// 高估真实通关下限 3.71 倍（L*_human=139 vs 515），不得再用作节奏目标映射。
// 本函数保留仅供历史对照与基线复现（R-bot3），不再被验收用例调用。
function botBuildLegacy(state) {
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

// ---------- 现行验收 bot（botBuild，2026-10-17 D0 选 A 后生效） ----------
// 贪心 bot：每 tick 至多建造 1 座。住房优先保人口（人口=劳力+市税，是一切的前提）。
// R-bot1（按需扩张，无写死硬上限）：
//   粮线：磨坊耗 2 粮 / 农田产 2 粮 ⇒ 农田数与磨坊数挂钩（farms ≥ mills+1 才补磨坊）；
//         食净流 = 磨坊产食 − 食肆耗食 − 人口耗食，盈余不足时先补上游再补下游。
//   木线：木材低于 30 补林场，不设座数上限。
//   商业：只在食有净盈余（foodNet > 2）且铜钱宽裕时开食肆；粮仓在粮接近仓容时补；
//         木匠铺在木材宽裕时开；杂货摊在货有盈余时开。
// R-bot2（食流自救，防御性规则）：食净流为负且食库存低于安全区时拆 1 座食肆
//   （真人第 1 局真实做过的自救动作），避免"食肆顶死食流→人口迁出螺旋"。
// 新基线（现网配置 20/50/100、迁入 5，2026-10-17 实测）：
//   V2 初始资源通关 = Lv2@12 / Lv3@280 / Lv4@480
//   V1 注入铜钱 100000 = Lv4@106
function botBuild(state) {
  const lvl = state.level;
  const cap = housingCapacity(state);
  const pop = state.population.count;
  const c = countType;
  const farms = c(state, 'farm'), mills = c(state, 'mill'), eat = c(state, 'eatery');
  const carp = c(state, 'carpenter');

  // R-bot2 食流自救：食净流为负且库存低于安全区 → 拆 1 座食肆（其次木匠铺）回血
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
  // 住房最优先：没有人口就没有劳力与市税
  if (cap - pop < 2) wants.push(lvl >= 3 && state.money > 120 ? 'house' : 'hut');
  // 粮线按需：食库存低或净流无盈余 → 先保证农田供给，再扩磨坊
  if (state.resources.food < 20 || foodNet < 1) {
    if (farms >= mills + 1) wants.push('mill');
    else wants.push('farm');
  }
  if (state.resources.grain < 10 && farms < mills + 2) wants.push('farm');
  // 木线按需：木材低于 30 补林场（无座数上限）
  if (state.resources.wood < 30) wants.push('forest');
  // 商业按需：食有净盈余且铜钱宽裕才开食肆；粮接近仓容补粮仓；木材/货宽裕开木匠铺/杂货摊
  if (lvl >= 2 && foodNet > 2 && state.money > 120) wants.push('eatery');
  if (lvl >= 2 && state.resources.grain > computeCaps(state).grain * 0.8) wants.push('granary');
  if (lvl >= 3 && state.resources.wood > 60) wants.push('carpenter');
  if (lvl >= 4 && state.resources.goods > 4) wants.push('grocer');
  // 住房余量兜底
  if (cap - pop < 4) wants.push(lvl >= 3 ? 'house' : 'hut');

  for (const t of wants) if (tryPlace(state, t)) return t;
  return null;
}

function playthrough(state, bot, maxTicks) {
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
    const r = playthrough(state, botBuild, 2000);
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
    const r = playthrough(state, botBuild, 2000);
    console.log('[验收] 注入铜钱通关推演:', JSON.stringify({
      到Lv2: r.levelAt[2], 到Lv3: r.levelAt[3], 到Lv4: r.levelAt[4],
      最终等级: r.finalLevel, 最高繁荣度: r.maxProsperity,
      终局: { pop: state.population.count, 建筑数: state.buildings.length },
    }));
    expect(r.levelAt[4]).not.toBeNull();
  });

  // R-bot3 基线复现门槛（D0 选 A 的实施约束）：旧 bot（botBuildLegacy）在现网配置下
  // 必须逐字复现历史基线 V2=12/315/515 与 V1=91。若此用例红，说明现网配置相对
  // 2026-10-17 基线发生了漂移，新旧 bot 读数对照全部失效，须先查配置再谈其他。
  it('基线复现（R-bot3）：旧版 bot 在现网配置下必须复现历史基线 V2 12/315/515 与 V1 91 tick', () => {
    const s1 = createInitialState();
    const r1 = playthrough(s1, botBuildLegacy, 2000);
    console.log('[验收] 旧bot基线复现（V2）:', JSON.stringify({
      到Lv2: r1.levelAt[2], 到Lv3: r1.levelAt[3], 到Lv4: r1.levelAt[4],
    }));
    expect(r1.levelAt[2]).toBe(12);
    expect(r1.levelAt[3]).toBe(315);
    expect(r1.levelAt[4]).toBe(515);

    const s2 = createInitialState();
    s2.money = 100000;
    const r2 = playthrough(s2, botBuildLegacy, 2000);
    console.log('[验收] 旧bot基线复现（V1 注入铜钱）:', JSON.stringify({ 到Lv4: r2.levelAt[4] }));
    expect(r2.levelAt[4]).toBe(91);
  });
});
