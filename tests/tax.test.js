// 市税（v0.3）：保底收入规则
// 覆盖：按户数结算（有钱/无钱一致）、空置民居不计税、不受运转系数影响、UI 取整与支付判定一致性
import { describe, it, expect, beforeEach } from 'vitest';
import { createInitialState } from '../src/core/state.js';
import { tick, taxIncome, commerceIncome } from '../src/core/simulation.js';
import { placeBuilding, canAfford } from '../src/core/grid.js';
import { moneyLabel, formatMoney } from '../src/ui/hud.js';
import { RULES } from '../src/config/rules.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { findSpot } from './helpers.js';

let state;

beforeEach(() => {
  state = createInitialState();
});

function buildHuts(n) {
  for (let i = 0; i < n; i++) {
    const s = findSpot(state, null, 1, 1);
    expect(placeBuilding(state, 'hut', s.x, s.y).ok).toBe(true);
  }
}

describe('市税配置', () => {
  it('数值与设计案一致', () => {
    expect(RULES.tax.perHouseholdPerTick).toBe(0.05);
    expect(RULES.tax.sourceBuildings).toEqual(['hut', 'house']);
    expect(RULES.tax.countBasis).toBe('population');
    expect(RULES.tax.affectedByRuntimeFactor).toBe(false);
    expect(RULES.money.precision).toBe('float');
  });
});

describe('市税按在城户数结算', () => {
  it('有钱时按户数增长：10 户 × 0.05 = 每 tick +0.5', () => {
    state.money = 1000;
    state.population.count = 10;
    for (let i = 1; i <= 4; i++) {
      const before = state.money;
      tick(state);
      expect(state.money - before).toBeCloseTo(0.5, 5);
    }
    expect(state.money).toBeCloseTo(1002, 5);
  });

  it('无钱（余额 0）时同样按户数增长——这是「铜钱耗尽」可穿越的直接证据', () => {
    state.money = 0;
    state.population.count = 6;
    tick(state);
    expect(state.money).toBeCloseTo(0.3, 5);
    tick(state);
    expect(state.money).toBeCloseTo(0.6, 5);
  });

  it('户数为 0 时不产生市税', () => {
    state.money = 50;
    state.population.count = 0;
    tick(state);
    expect(state.money).toBe(50);
    expect(taxIncome(state)).toBe(0);
  });

  it('taxIncome 与实际入账金额一致', () => {
    state.population.count = 7;
    const expected = taxIncome(state);
    const before = state.money;
    tick(state);
    expect(state.money - before).toBeCloseTo(expected, 10);
  });
});

describe('空置民居不计税（计税基数 = 实际户数，不是容量）', () => {
  it('容量相同、户数不同 → 税额只跟户数走', () => {
    buildHuts(3); // 容量 6
    state.population.count = 1;
    const withHuts = taxIncome(state);

    const bare = createInitialState();
    bare.population.count = 1;
    expect(taxIncome(bare)).toBeCloseTo(withHuts, 10);
    expect(withHuts).toBeCloseTo(0.05, 10);
  });

  it('堆空茅舍不产生额外收入：户数不变时，茅舍从 1 座加到 10 座，税额不变', () => {
    state.population.count = 2; // 低于容量，全部为空置
    state.resources.food = 0; // 冻结迁入，排除人口增长干扰
    buildHuts(1);
    tick(state);
    const tax1 = state.money - 0; // 建 1 座茅舍后 money = 240 - 10 + 税
    const base1 = 240 - BUILDINGS.hut.cost.money;
    expect(tax1 - base1).toBeCloseTo(0.1, 5);

    const moneyAfter1 = state.money;
    for (let i = 0; i < 9; i++) {
      const s = findSpot(state, null, 1, 1);
      placeBuilding(state, 'hut', s.x, s.y);
    }
    tick(state);
    const spent = 9 * BUILDINGS.hut.cost.money;
    // 再建 9 座空茅舍后，本 tick 新增收入仍只有 2 户的税，而非 20 容量的税
    expect(state.money - (moneyAfter1 - spent)).toBeCloseTo(0.1, 5);
  });
});

describe('市税不受运转系数影响', () => {
  it('建筑因缺料停产后，市税仍按户数全额结算', () => {
    const spot = findSpot(state, null, 2, 2);
    const mill = placeBuilding(state, 'mill', spot.x, spot.y).building;
    state.population.count = 4;
    state.resources.grain = 0; // 缺料 → 停产

    const before = state.money;
    tick(state);
    expect(mill.idle).toBe(true);
    expect(mill.idleReason).toBe('material');
    expect(state.money - before).toBeCloseTo(4 * RULES.tax.perHouseholdPerTick, 5);
  });

  it('idle 标记不影响税额：手工把建筑置为停产态，税额与入账均不变', () => {
    const spot = findSpot(state, null, 2, 2);
    placeBuilding(state, 'mill', spot.x, spot.y);
    state.population.count = 8;
    const full = taxIncome(state);
    state.buildings.forEach((b) => {
      b.idle = true;
      b.idleReason = 'material';
    });
    expect(taxIncome(state)).toBe(full); // 只看户数，不看 idle

    const before = state.money;
    tick(state);
    expect(state.money - before).toBeCloseTo(full, 5); // 8 户 × 0.05 = 0.4
  });

  it('断链建筑繁荣度不计分（idle=0）不影响市税结算', () => {
    const spot = findSpot(state, null, 2, 2);
    placeBuilding(state, 'mill', spot.x, spot.y);
    state.population.count = 4;
    state.resources.grain = 0;

    tick(state);
    expect(state.prosperity).toBeCloseTo(BUILDINGS.mill.score * RULES.prosperityCoef.idle, 5);
    // 断链状态下仍有 0.2/ tick 的现金流入
    const before = state.money;
    tick(state);
    expect(state.money - before).toBeCloseTo(0.2, 5);
  });
});

describe('收入拆分：市税 vs 商业', () => {
  it('无商业建筑时，商业收入为 0，全部为市税', () => {
    state.population.count = 4;
    expect(commerceIncome(state)).toBe(0);
    expect(taxIncome(state)).toBeCloseTo(0.2, 5);
  });

  it('商业建筑停产时不计入商业收入，但市税照计', () => {
    state.level = BUILDINGS.eatery.unlockLevel;
    const spot = findSpot(state, null, 1, 1);
    const eatery = placeBuilding(state, 'eatery', spot.x, spot.y).building;
    state.population.count = 4;
    state.resources.food = 0; // 缺料停产

    tick(state);
    expect(eatery.idle).toBe(true);
    expect(commerceIncome(state)).toBe(0);
    expect(taxIncome(state)).toBeCloseTo(0.2, 5);
  });

  it('商业建筑运转时商业收入 = 其产钱之和，且与市税分别计入', () => {
    state.level = BUILDINGS.eatery.unlockLevel;
    const spot = findSpot(state, null, 1, 1);
    placeBuilding(state, 'eatery', spot.x, spot.y);
    state.population.count = 4;
    state.resources.food = 50;

    tick(state);
    expect(commerceIncome(state)).toBe(BUILDINGS.eatery.outputs.money);
    expect(taxIncome(state)).toBeCloseTo(0.2, 5);
  });

  it('HUD 文案同时给出市税与商业两项', () => {
    state.level = BUILDINGS.eatery.unlockLevel;
    const spot = findSpot(state, null, 1, 1);
    placeBuilding(state, 'eatery', spot.x, spot.y);
    state.population.count = 4;
    state.resources.food = 50;
    tick(state);

    const label = moneyLabel(state);
    expect(label).toContain(`市税 +${(0.2).toFixed(2)}`);
    expect(label).toContain(`商业 +${BUILDINGS.eatery.outputs.money}`);
  });
});

describe('铜钱浮点累计与 UI 取整的一致性', () => {
  it('余额为小数时，显示向下取整', () => {
    state.money = 9.99;
    expect(formatMoney(state.money)).toBe('9');
    state.money = 10.75;
    expect(formatMoney(state.money)).toBe('10');
  });

  it('支付判定用浮点真值：显示 9 时买不起 10 钱的茅舍，真值 9.99 也不放行', () => {
    state.money = 9.99;
    expect(moneyLabel(state)).toContain('铜钱 9');
    expect(canAfford(state, 'hut')).toBe(false);
  });

  it('显示值 ≥ 造价 ⇔ 一定买得起（不会出现「显示有钱却买不起」）', () => {
    for (const v of [0, 0.05, 0.3, 4.999, 5, 9.99, 10, 10.01, 50.5, 239.95, 240]) {
      state.money = v;
      const shown = Number(formatMoney(state.money));
      if (shown >= BUILDINGS.hut.cost.money) expect(canAfford(state, 'hut')).toBe(true);
      // 显示值小于造价时，真值也必然小于造价（floor 不会虚增）
      else expect(state.money).toBeLessThan(BUILDINGS.hut.cost.money);
    }
  });

  it('仅靠市税能把 0 余额重新攒到食肆造价（50）', () => {
    state.money = 0;
    state.population.count = 5;
    state.resources.food = 1e9; // 隔离变量：排除饥饿迁出导致的户数下降
    let ticks = 0;
    while (state.money < BUILDINGS.eatery.cost.money && ticks < 10000) {
      tick(state);
      ticks++;
    }
    // 5 户 × 0.05 = 0.25/tick → 200 tick
    expect(state.money).toBeGreaterThanOrEqual(BUILDINGS.eatery.cost.money);
    expect(ticks).toBe(200);
  });
});
