// 生产链结算、人口迁入/迁出、繁荣度（P1/P2：断链/闲置不计分，民居按入住率折算；P3：解锁粘性）
import { describe, it, expect, beforeEach } from 'vitest';
import { createInitialState } from '../src/core/state.js';
import { tick, computeProsperity, computeLevel, computeCaps } from '../src/core/simulation.js';
import { placeBuilding, canPlace } from '../src/core/grid.js';
import { RULES } from '../src/config/rules.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { findSpot } from './helpers.js';

let state;

beforeEach(() => {
  state = createInitialState();
});

function runTicks(n) {
  for (let i = 0; i < n; i++) tick(state);
}

describe('生产链结算', () => {
  it('tick 推进计数', () => {
    expect(state.tick).toBe(0);
    runTicks(3);
    expect(state.tick).toBe(3);
  });

  it('农田产粮 → 磨坊耗粮产食，一条链跑通', () => {
    const farmSpot = findSpot(state, 'fertile', 2, 2);
    const millSpot = findSpot(state, null, 2, 2);
    expect(placeBuilding(state, 'farm', farmSpot.x, farmSpot.y).ok).toBe(true);
    expect(placeBuilding(state, 'mill', millSpot.x, millSpot.y).ok).toBe(true);
    state.population.count = 4; // 农田 0 + 磨坊 1 劳力

    tick(state);

    // 粮：20 +2（农田） -2（磨坊） = 20；食：20 +1（磨坊） -0.4（4 户耗食） = 20.6
    expect(state.resources.grain).toBe(20);
    expect(state.resources.food).toBeCloseTo(20.6, 5);
    expect(state.buildings.every((b) => !b.idle)).toBe(true);
  });

  it('劳力紧张时食物链优先于商业：后建的磨坊先拿到劳力', () => {
    state.level = BUILDINGS.eatery.unlockLevel; // 食肆 Lv2 解锁
    const eaterySpot = findSpot(state, null, 1, 1);
    const eatery = placeBuilding(state, 'eatery', eaterySpot.x, eaterySpot.y).building;
    const millSpot = findSpot(state, null, 2, 2);
    const mill = placeBuilding(state, 'mill', millSpot.x, millSpot.y).building;
    state.population.count = 1; // 只够 1 处劳力
    state.resources.grain = 10;
    state.resources.food = 20;

    tick(state);

    // 建造顺序是食肆在前，但食链优先：劳力先给磨坊，避免食断供再度死锁
    expect(mill.idle).toBe(false);
    expect(eatery.idle).toBe(true);
    expect(eatery.idleReason).toBe('labor');
  });

  it('缺料时停产（idleReason=material），不扣原料也不产出', () => {
    const spot = findSpot(state, null, 2, 2);
    const mill = placeBuilding(state, 'mill', spot.x, spot.y).building;
    state.population.count = 4;
    state.resources.grain = 0;

    tick(state);

    expect(mill.idle).toBe(true);
    expect(mill.idleReason).toBe('material');
    expect(state.resources.grain).toBe(0);
    expect(state.resources.food).toBeCloseTo(20 - 0.4, 5); // 只有人口耗食
  });

  it('缺人时停产（idleReason=labor）', () => {
    // 磨坊需 1 劳力；农田/林场现已免劳力，改用磨坊验证缺人分支
    const spot = findSpot(state, null, 2, 2);
    const mill = placeBuilding(state, 'mill', spot.x, spot.y).building;
    state.population.count = 0; // 无劳力
    state.resources.grain = 10;

    tick(state);

    expect(mill.idle).toBe(true);
    expect(mill.idleReason).toBe('labor');
    expect(state.resources.grain).toBe(10); // 未产出
  });

  it('劳力按建筑顺序分配，不足时后者停产', () => {
    const a = findSpot(state, null, 2, 2);
    const millA = placeBuilding(state, 'mill', a.x, a.y).building;
    const b = findSpot(state, null, 2, 2);
    const millB = placeBuilding(state, 'mill', b.x, b.y).building;
    state.population.count = 1; // 只够 1 座磨坊
    state.resources.grain = 10;

    tick(state);

    expect(millA.idle).toBe(false);
    expect(millB.idle).toBe(true);
    expect(millB.idleReason).toBe('labor');
    expect(state.resources.grain).toBe(8); // 仅 1 座耗粮产出
  });

  it('产出受存储上限约束，粮仓提升上限', () => {
    const farmSpot = findSpot(state, 'fertile', 2, 2);
    placeBuilding(state, 'farm', farmSpot.x, farmSpot.y);
    state.population.count = 4;
    state.resources.grain = RULES.baseCaps.grain; // 已满仓

    tick(state);
    expect(state.resources.grain).toBe(RULES.baseCaps.grain); // 溢出被丢弃

    const granarySpot = findSpot(state, null, 2, 2);
    state.level = BUILDINGS.granary.unlockLevel; // 粮仓 Lv2 解锁，先提级再建
    placeBuilding(state, 'granary', granarySpot.x, granarySpot.y);
    expect(computeCaps(state).grain).toBe(RULES.baseCaps.grain + RULES.granaryBonus.grain);

    tick(state);
    expect(state.resources.grain).toBe(RULES.baseCaps.grain + 2); // 上限抬高后可继续入库
  });

  it('商业建筑产出铜钱', () => {
    const eaterySpot = findSpot(state, null, 1, 1);
    state.level = BUILDINGS.eatery.unlockLevel; // 食肆 Lv2 解锁，先提级再建
    placeBuilding(state, 'eatery', eaterySpot.x, eaterySpot.y);
    state.population.count = 4;
    state.resources.food = 20;

    const before = state.money;
    tick(state);

    // 食肆产钱 3 + 市税（4 户 × 0.05）
    expect(state.money).toBeCloseTo(before + 3 + 4 * RULES.tax.perHouseholdPerTick, 5);
    expect(state.resources.food).toBeCloseTo(20 - 1 - 0.4, 5);
  });
});

describe('人口', () => {
  it('有空房且食 > 安全线时，按 moveInInterval 间隔迁入', () => {
    const spot = findSpot(state, null, 1, 1);
    placeBuilding(state, 'hut', spot.x, spot.y); // 容量 2
    expect(state.resources.food).toBeGreaterThan(RULES.foodSafetyLine);

    runTicks(RULES.moveInInterval);
    expect(state.population.count).toBe(1);

    runTicks(RULES.moveInInterval);
    expect(state.population.count).toBe(2);
  });

  it('民居满容后停止迁入', () => {
    const spot = findSpot(state, null, 1, 1);
    placeBuilding(state, 'hut', spot.x, spot.y); // 容量 2
    runTicks(20);
    expect(state.population.count).toBe(2);
  });

  it('食库存低于安全线时不迁入', () => {
    const spot = findSpot(state, null, 1, 1);
    placeBuilding(state, 'hut', spot.x, spot.y);
    state.resources.food = RULES.foodSafetyLine; // 不大于安全线
    runTicks(5);
    expect(state.population.count).toBe(0);
  });

  it('食耗尽持续宽限 tick 后开始迁出', () => {
    state.population.count = 3;
    state.resources.food = 0;
    state.population.starveTicks = 0;

    runTicks(5); // 宽限期内不迁出
    expect(state.population.count).toBe(3);

    runTicks(5); // 第 10 tick 达到 starveGraceTicks 且 10 % 5 == 0
    expect(state.population.count).toBe(2);
  });

  it('食充足时不会迁出，且饥饿计时归零', () => {
    state.population.count = 2;
    state.resources.food = 30;
    state.population.starveTicks = 7;
    runTicks(10);
    expect(state.population.starveTicks).toBe(0);
    expect(state.population.count).toBe(2);
  });

  it('长期断食后人口迁出到保底户数即停止', () => {
    state.population.count = 3;
    state.resources.food = 0;
    state.population.starveTicks = 0;

    runTicks(60);
    // 「人口 0 且食不足」的吸收态不可达：始终保留 minPopulation 户
    expect(state.population.count).toBe(RULES.minPopulation);
  });
});

describe('繁荣度与解锁', () => {
  it('正常运转按基础分全额计入', () => {
    const spot = findSpot(state, null, 2, 2);
    placeBuilding(state, 'mill', spot.x, spot.y); // 工坊 4 分
    state.population.count = 4;
    state.resources.grain = 10;

    tick(state);
    expect(computeProsperity(state)).toBe(4);
  });

  it('断链建筑不计繁荣度（闲置=0）', () => {
    const spot = findSpot(state, null, 2, 2);
    const mill = placeBuilding(state, 'mill', spot.x, spot.y).building;
    state.population.count = 4;
    state.resources.grain = 10;
    tick(state);
    expect(computeProsperity(state)).toBe(4);

    state.resources.grain = 0; // 断料
    tick(state);
    expect(mill.idle).toBe(true);
    expect(computeProsperity(state)).toBeCloseTo(4 * RULES.prosperityCoef.idle, 5);
  });

  it('缺人与缺料同样不计分，正常建筑仍全额', () => {
    // 磨坊（工坊 4 分）需 1 劳力，用两座验证缺人不计分；农田已免劳力不适用此场景
    const millSpotA = findSpot(state, null, 2, 2);
    placeBuilding(state, 'mill', millSpotA.x, millSpotA.y);
    const millSpotB = findSpot(state, null, 2, 2);
    placeBuilding(state, 'mill', millSpotB.x, millSpotB.y);
    state.population.count = 0; // 全部缺人

    tick(state);
    // 两座磨坊各 4×0 = 0
    expect(computeProsperity(state)).toBeCloseTo(8 * RULES.prosperityCoef.idle, 5);

    state.population.count = 4;
    state.resources.grain = 10;
    tick(state);
    expect(computeProsperity(state)).toBe(8); // 全部正常运转
  });

  it('民居按入住率计分：0 户计 0，住满计全额，部分入住按比例', () => {
    const spot = findSpot(state, null, 1, 1);
    placeBuilding(state, 'hut', spot.x, spot.y); // 容量 2，基础分 1
    state.resources.food = 0; // 冻结迁入/迁出（3 tick 内不会触发迁出宽限），隔离人口变量

    state.population.count = 0; // 空屋不计分
    tick(state);
    expect(computeProsperity(state)).toBe(0);

    state.population.count = 2; // 住满 → 全额
    tick(state);
    expect(computeProsperity(state)).toBe(1);

    state.population.count = 1; // 入住率 1/2 → 按比例
    tick(state);
    expect(computeProsperity(state)).toBeCloseTo(0.5, 10);
  });

  it('入住率超过 100% 时按 1 截断（户数多于容量不多给分）', () => {
    const spot = findSpot(state, null, 1, 1);
    placeBuilding(state, 'hut', spot.x, spot.y); // 容量 2，基础分 1
    state.population.count = 5; // min(1, 5/2) = 1
    state.resources.food = 0;
    tick(state);
    expect(computeProsperity(state)).toBe(1);
  });

  it('等级按 unlockThresholds 划分（派生式：调阈值本用例不再红）', () => {
    const ths = RULES.unlockThresholds;
    expect(computeLevel(-1)).toBe(1);
    expect(computeLevel(ths[1] - 0.1)).toBe(1);
    expect(computeLevel(ths[1])).toBe(2);
    expect(computeLevel(ths[2] - 0.1)).toBe(2);
    expect(computeLevel(ths[2])).toBe(3);
    expect(computeLevel(ths[3] - 0.1)).toBe(3);
    expect(computeLevel(ths[3])).toBe(4);
    expect(computeLevel(ths[3] + 1000)).toBe(4); // 最高 4 级封顶
  });

  it('tick 后 state.level 随繁荣度更新', () => {
    // 20 座「住满」的茅舍 = 20 分达 Lv2 阈值（P2：民居按入住率计分，空屋计 0）
    state.money = 100000;
    state.resources.wood = 100000;
    for (let i = 0; i < 20; i++) {
      const s = findSpot(state, null, 1, 1);
      placeBuilding(state, 'hut', s.x, s.y);
    }
    state.population.count = 40; // 住满（总容量 20×2）
    tick(state);
    expect(state.prosperity).toBe(20);
    expect(state.level).toBe(2);
  });
});

describe('解锁粘性（P3：maxLevel 只升不降）', () => {
  it('升到 Lv3 后繁荣度回落，建造判定仍按 maxLevel 解锁（不再重锁）', () => {
    state.money = 100000;
    state.resources.wood = 100000;
    // 60 座住满茅舍 = 60 分 → Lv3（O6′ 阈值 60）
    for (let i = 0; i < 60; i++) {
      const s = findSpot(state, null, 1, 1);
      placeBuilding(state, 'hut', s.x, s.y);
    }
    state.population.count = 120; // 住满（总容量 60×2）
    tick(state);
    expect(state.level).toBe(3);
    expect(state.maxLevel).toBe(3);

    // 繁荣度回落：户数跌到 10 → 民居得分 60 × (10/120) ≈ 5 → 瞬时等级跌回 Lv1
    state.population.count = 10;
    tick(state);
    expect(state.level).toBe(1);
    expect(state.maxLevel).toBe(3); // 只升不降

    // core 放置校验（规则唯一权威）仍放行 Lv3 建筑
    const s = findSpot(state, null, 1, 1);
    expect(canPlace(state, 'carpenter', s.x, s.y).ok).toBe(true);
    expect(placeBuilding(state, 'carpenter', s.x, s.y).ok).toBe(true);
  });

  it('maxLevel 不随瞬时等级回落，也不低于当前等级', () => {
    expect(state.maxLevel).toBe(1);
    state.population.count = 0; // 无任何建筑，繁荣度恒 0
    runTicks(10);
    expect(state.level).toBe(1);
    expect(state.maxLevel).toBe(1);

    // 瞬时等级被人为抬高（等价于繁荣度冲高），maxLevel 跟上
    state.prosperity = RULES.unlockThresholds[3];
    state.level = computeLevel(state.prosperity);
    tick(state); // tick 内重算 level，但 maxLevel 已记录
    expect(state.maxLevel).toBeGreaterThanOrEqual(state.level);
  });
});

describe('恒计分封顶（P-1′ O6′：farm/forest/granary 合计 ≤ 26）', () => {
  it('合计低于封顶时全额计分', () => {
    state.money = 100000;
    state.resources.wood = 100000;
    for (let i = 0; i < 3; i++) {
      const s = findSpot(state, 'fertile', 2, 2);
      placeBuilding(state, 'farm', s.x, s.y);
    }
    state.population.count = 4;
    tick(state);
    expect(computeProsperity(state)).toBe(6); // 3×2=6 < 26
  });

  it('合计恰等于封顶时不截断（边界 26）', () => {
    state.money = 100000;
    state.resources.wood = 100000;
    for (let i = 0; i < 13; i++) {
      const s = findSpot(state, 'fertile', 2, 2);
      placeBuilding(state, 'farm', s.x, s.y);
    }
    state.population.count = 4;
    tick(state);
    expect(computeProsperity(state)).toBe(26); // 13×2=26
  });

  it('合计超过封顶时按 26 截断', () => {
    state.money = 100000;
    state.resources.wood = 100000;
    for (let i = 0; i < 14; i++) {
      const s = findSpot(state, 'fertile', 2, 2);
      placeBuilding(state, 'farm', s.x, s.y);
    }
    state.population.count = 4;
    tick(state);
    expect(computeProsperity(state)).toBe(26); // 14×2=28 → 26
  });

  it('粮仓计入封顶合计（跨类合计后截断）', () => {
    state.money = 100000;
    state.resources.wood = 100000;
    state.level = BUILDINGS.granary.unlockLevel; // 粮仓 Lv2 解锁
    for (let i = 0; i < 12; i++) {
      const s = findSpot(state, 'fertile', 2, 2);
      placeBuilding(state, 'farm', s.x, s.y);
    }
    const g = findSpot(state, null, 2, 2);
    placeBuilding(state, 'granary', g.x, g.y);
    state.population.count = 4;
    tick(state);
    expect(computeProsperity(state)).toBe(26); // 12×2 + 2 = 26
  });

  it('非恒计分建筑不受封顶影响（封顶后加工/商业分另算）', () => {
    state.money = 100000;
    state.resources.wood = 100000;
    for (let i = 0; i < 13; i++) {
      const s = findSpot(state, 'fertile', 2, 2);
      placeBuilding(state, 'farm', s.x, s.y);
    }
    const m = findSpot(state, null, 2, 2);
    placeBuilding(state, 'mill', m.x, m.y);
    state.population.count = 4;
    state.resources.grain = 10;
    tick(state);
    expect(computeProsperity(state)).toBe(30); // 恒计分 26（封顶）+ 磨坊 4
  });
});
