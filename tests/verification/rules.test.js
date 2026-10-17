// 独立验收：解锁门槛（核心层）、资源非负、上限截断
import { describe, it, expect, beforeEach } from 'vitest';
import { createInitialState } from '../../src/core/state.js';
import { tick } from '../../src/core/simulation.js';
import { canPlace, placeBuilding } from '../../src/core/grid.js';
import { BUILDINGS } from '../../src/config/buildings.js';
import { RULES } from '../../src/config/rules.js';

let state;
beforeEach(() => {
  state = createInitialState();
});

function findPlainSpot(w, h) {
  const size = RULES.mapSize;
  for (let y = 0; y <= size - h; y++)
    for (let x = 0; x <= size - w; x++)
      if (canPlace(state, 'hut', x, y).ok || w * h > 1) {
        // 直接用 canPlace 对目标尺寸校验
        let ok = true;
        for (let dy = 0; dy < h && ok; dy++)
          for (let dx = 0; dx < w && ok; dx++) {
            const cell = state.grid.get(`${x + dx},${y + dy}`);
            if (!cell || cell.buildingId != null) ok = false;
          }
        if (ok) return { x, y };
      }
  return null;
}

describe('解锁门槛（设计案 2.4：Lv2 解锁食肆/粮仓，Lv3 解锁木匠铺/瓦屋，Lv4 解锁杂货摊）', () => {
  it.each([
    ['eatery', 2], ['granary', 2], ['carpenter', 3], ['house', 3], ['grocer', 4],
  ])('Lv1 时核心层应拒绝建造 %s（需 Lv%i）', (type) => {
    expect(state.level).toBe(1);
    const def = BUILDINGS[type];
    state.money = 100000;
    state.resources.wood = 100000; // 排除造价干扰，只验解锁门槛
    const s = findPlainSpot(def.size[0], def.size[1]);
    expect(s).not.toBeNull();
    const r = placeBuilding(state, type, s.x, s.y);
    // 设计案要求未解锁建筑"不可建造"。UI 层（buildMenu.js）有锁定，
    // 但核心层 placeBuilding/canPlace 不校验 unlockLevel —— 此处按设计期望断言。
    expect(r.ok).toBe(false);
  });

  it('配置解锁等级与设计案一致', () => {
    expect(BUILDINGS.eatery.unlockLevel).toBe(2);
    expect(BUILDINGS.granary.unlockLevel).toBe(2);
    expect(BUILDINGS.carpenter.unlockLevel).toBe(3);
    expect(BUILDINGS.house.unlockLevel).toBe(3);
    expect(BUILDINGS.grocer.unlockLevel).toBe(4);
    for (const t of ['hut', 'farm', 'forest', 'mill'])
      expect(BUILDINGS[t].unlockLevel).toBe(1);
  });
});

describe('资源边界处理', () => {
  it('多建筑竞争同一原料时不会扣成负数', () => {
    const s1 = findPlainSpot(2, 2);
    placeBuilding(state, 'mill', s1.x, s1.y);
    const s2 = findPlainSpot(2, 2);
    placeBuilding(state, 'mill', s2.x, s2.y);
    state.population.count = 4;
    state.resources.grain = 3; // 只够 1 座磨坊

    tick(state);
    expect(state.resources.grain).toBeGreaterThanOrEqual(0);
    expect(state.resources.grain).toBe(1); // 第一座耗 2，第二座停产
    expect(state.buildings.filter((b) => b.idle && b.idleReason === 'material').length).toBe(1);
  });

  it('人口耗食不会把食扣成负数', () => {
    state.population.count = 30;
    state.resources.food = 1;
    tick(state);
    expect(state.resources.food).toBe(0);
  });

  it('器（goods）按 rules.js 设计不设上限，可持续累积', () => {
    state.level = BUILDINGS.carpenter.unlockLevel; // core 现在校验解锁等级，需先达标
    const s = findPlainSpot(1, 1);
    placeBuilding(state, 'carpenter', s.x, s.y);
    state.population.count = 2;
    state.resources.wood = 1000;
    state.resources.food = 100;
    for (let i = 0; i < 100; i++) tick(state);
    expect(state.resources.goods).toBeGreaterThan(50); // 不被 baseCaps 误截断
  });

  it('铜钱无上限（商业产出持续累加）', () => {
    state.level = BUILDINGS.eatery.unlockLevel; // core 现在校验解锁等级，需先达标
    const s = findPlainSpot(1, 1);
    placeBuilding(state, 'eatery', s.x, s.y); // 造价 50 钱
    const moneyAfterBuild = state.money;
    state.population.count = 1;
    state.resources.food = 100;
    for (let i = 0; i < 10; i++) tick(state);
    // 食肆 3 钱/tick + 市税 0.05 钱/户/tick，10 tick 后必须显著高于建造后余额
    expect(state.money).toBeGreaterThan(moneyAfterBuild + 25);
  });

  it('不变式：铜钱=0 且户数≥1 时，资金必须严格恢复（0 是穿越点而非吸收态，设计案 v0.3）', () => {
    state.money = 0;
    state.population.count = 1;
    state.resources.food = 100; // 排除耗食迁出干扰
    const before = state.money;
    for (let i = 0; i < 10; i++) tick(state);
    expect(state.money).toBeGreaterThan(before); // 仅靠市税也必须回血
  });
});
