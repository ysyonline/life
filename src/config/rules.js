// 全局规则：tick 时长、繁荣度系数、人口规则、存档等
export const RULES = {
  tickMs: 1000, // 1 tick = 1 秒
  mapSize: 32,

  // 初始资源（铜钱另存于 state.money，不在 resources 表内）
  // 240 铜钱为「活预算」：修死锁 B 用，保证 Lv1 阶段有可扩张余量
  initialResources: { grain: 20, wood: 60, food: 20, goods: 0 },
  initialMoney: 240,

  // 繁荣度（P1：02-pacing-tuning.md）
  // idle=0：断链/闲置建筑不计繁荣度——堵死「铺闲置建筑刷分」口，繁荣度只奖励活着的城市
  prosperityCoef: { active: 1.0, idle: 0 },
  // 恒计分封顶（D-P1′ O6′）：farm/forest/granary 三类恒计分建筑的繁荣度**合计**封顶 26 分。
  // 堵死「铺原料建筑刷分」主导策略（真人第 4 局 40 分白送占 Lv4 的 40%）。单一真源在此，公式不硬编码。
  prosperityPassiveCap: { buildings: ['farm', 'forest', 'granary'], max: 26 },
  unlockThresholds: [0, 20, 60, 145], // Lv1~Lv4（D-P1′ O6′：2026-10-17 拍板，Lv3 50→60、Lv4 100→145）

  // 人口
  minPopulation: 1, // 保底户数：迁出不得跌破此值，杜绝「人口 0 且食不足」的吸收态
  foodSafetyLine: 10, // 食库存 > 10 才可迁入
  moveInInterval: 5, // 每 5 tick 迁入 1 户
  starveGraceTicks: 10, // 食耗尽持续 10 tick 后开始迁出
  moveOutInterval: 5, // 每 5 tick 迁出 1 户
  foodPerHouseholdPerTick: 0.1,

  // 市税（v0.3）：按「在城户数」每 tick 征收的保底收入，用于消灭「铜钱耗尽即永久死亡」的不可恢复态
  // 计税基数是实际户数（state.population.count），不是民居空置容量 —— 空置民居不计税，
  // 否则「建空茅舍 = 印钞机」会把整个经济压平。
  tax: {
    perHouseholdPerTick: 0.05, // 每户每 tick
    sourceBuildings: ['hut', 'house'], // 民居类
    countBasis: 'population', // 计税基数 = 在城户数
    affectedByRuntimeFactor: false, // 不受缺料/缺人运转系数（正常 1.0 / 闲置 0）影响
  },

  // 铜钱精度：内部浮点累计，显示时向下取整（避免「显示有钱却买不起」）
  money: { precision: 'float' },

  // 存储容量（务实补全：设计案只定方向，未给具体上限）
  baseCaps: { grain: 100, food: 50 }, // wood/goods/money 不设上限
  granaryBonus: { grain: 50, food: 50 }, // 每座粮仓提升的上限

  demolishRefundRate: 0.5, // 拆除返还 50% 造价

  // 存档
  saveKey: 'songtown-save-v1',
  saveVersion: 1,
  autosaveInterval: 30, // 每 30 tick 自动保存

  camera: { minZoom: 0.5, maxZoom: 3.0 },
};
