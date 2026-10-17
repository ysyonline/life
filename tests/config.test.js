// D10 配置基线快照测试：把全部数值钉死在期望值上。
// 目的（02 文档 §2.5 / HANDOVER §7.6）：任何数值改动（哪怕"看着合理"）都会让本文件红，
// 逼着改动走「确认是有意调整 → 更新快照 → 过双套测试」的流程——数值不能被无声地改。
// ⚠ 本文件 pin 的是【现网值】。P-1′（封顶24 + 60/150）尚未实施；将来实施时本文件会红，
//    届时按「确认有意调整」流程更新快照值——这正是本测试的设计目的。
import { describe, it, expect } from 'vitest';
import { BUILDINGS, validateConfig } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

// 8 种建筑的关键数值（score/cost/workers/capacity/unlockLevel/size/terrain）
// 来源：src/config/buildings.js 现网值（2026-10-17 基线，commit 5c424f9）
const BUILDING_SNAPSHOT = {
  hut:      { score: 1, cost: { money: 10, wood: 5 },  workers: 0, capacity: 2, unlockLevel: 1, size: [1, 1], terrain: null },
  house:    { score: 3, cost: { money: 40, wood: 20 }, workers: 0, capacity: 4, unlockLevel: 3, size: [1, 1], terrain: null },
  farm:     { score: 2, cost: { money: 15, wood: 10 }, workers: 0, capacity: 0, unlockLevel: 1, size: [2, 2], terrain: 'fertile' },
  forest:   { score: 2, cost: { money: 15, wood: 5 },  workers: 0, capacity: 0, unlockLevel: 1, size: [2, 2], terrain: 'woodland' },
  mill:     { score: 4, cost: { money: 30, wood: 20 }, workers: 1, capacity: 0, unlockLevel: 1, size: [2, 2], terrain: null },
  carpenter:{ score: 4, cost: { money: 30, wood: 15 }, workers: 2, capacity: 0, unlockLevel: 3, size: [1, 1], terrain: null },
  eatery:   { score: 5, cost: { money: 50, wood: 25 }, workers: 1, capacity: 0, unlockLevel: 2, size: [1, 1], terrain: null },
  grocer:   { score: 6, cost: { money: 80, wood: 40 }, workers: 1, capacity: 0, unlockLevel: 4, size: [1, 1], terrain: null },
  granary:  { score: 2, cost: { money: 40, wood: 30 }, workers: 0, capacity: 0, unlockLevel: 2, size: [2, 2], terrain: null },
};

describe('配置基线快照（D10）', () => {
  it('建筑种类齐全：恰为 9 种（快照表与 BUILDINGS 键集一致）', () => {
    expect(Object.keys(BUILDINGS).sort()).toEqual(Object.keys(BUILDING_SNAPSHOT).sort());
  });

  for (const [id, snap] of Object.entries(BUILDING_SNAPSHOT)) {
    it(`建筑 ${id}：score/cost/workers/capacity/unlockLevel/size/terrain 与快照一致`, () => {
      const def = BUILDINGS[id];
      expect(def.score).toBe(snap.score);
      expect(def.cost).toEqual(snap.cost);
      expect(def.workers).toBe(snap.workers);
      expect(def.capacity).toBe(snap.capacity);
      expect(def.unlockLevel).toBe(snap.unlockLevel);
      expect(def.size).toEqual(snap.size);
      expect(def.terrain).toBe(snap.terrain);
    });
  }

  it('RULES.unlockThresholds = [0, 20, 50, 100]（Lv1~Lv4）', () => {
    expect(RULES.unlockThresholds).toEqual([0, 20, 50, 100]);
  });

  it('RULES.moveInInterval = 5（每 5 tick 迁入 1 户）', () => {
    expect(RULES.moveInInterval).toBe(5);
  });

  it('RULES.tax = 每户每 tick 0.05，计税基数 = 在城户数，不受运转系数影响', () => {
    expect(RULES.tax).toEqual({
      perHouseholdPerTick: 0.05,
      sourceBuildings: ['hut', 'house'],
      countBasis: 'population',
      affectedByRuntimeFactor: false,
    });
  });

  it('RULES 人口与经济关键值：foodSafetyLine=10 / moveOutInterval=5 / starveGraceTicks=10 / foodPerHouseholdPerTick=0.1 / minPopulation=1', () => {
    expect(RULES.foodSafetyLine).toBe(10);
    expect(RULES.moveOutInterval).toBe(5);
    expect(RULES.starveGraceTicks).toBe(10);
    expect(RULES.foodPerHouseholdPerTick).toBe(0.1);
    expect(RULES.minPopulation).toBe(1);
  });

  it('RULES 繁荣度系数：active=1.0 / idle=0（P1：闲置不计分）', () => {
    expect(RULES.prosperityCoef).toEqual({ active: 1.0, idle: 0 });
  });

  it('RULES 初始资源与预算：240 钱 / 60 木 / 20 粮 / 20 食', () => {
    expect(RULES.initialMoney).toBe(240);
    expect(RULES.initialResources).toEqual({ grain: 20, wood: 60, food: 20, goods: 0 });
  });

  it('RULES 存储与拆除：baseCaps {grain:100, food:50} / granaryBonus {grain:50, food:50} / demolishRefundRate=0.5', () => {
    expect(RULES.baseCaps).toEqual({ grain: 100, food: 50 });
    expect(RULES.granaryBonus).toEqual({ grain: 50, food: 50 });
    expect(RULES.demolishRefundRate).toBe(0.5);
  });

  it('配置自校验通过（validateConfig 无异常）', () => {
    expect(() => validateConfig()).not.toThrow();
  });
});
