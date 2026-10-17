// 建筑定义：占地、成本、产出/消耗、劳力、繁荣度基础分、解锁等级、灰盒颜色
// 数值来源：设计案 5.1 / 5.2 / 5.3 / 5.4
// score 为繁荣度基础分，由设计案直接给定（不按 category 推导，同类别内也有差异）
import { RESOURCES } from './resources.js';

export const BUILDINGS = {
  hut: {
    name: '茅舍', abbr: '茅', category: '民居',
    size: [1, 1], cost: { money: 10, wood: 5 },
    inputs: {}, outputs: {}, workers: 0,
    capacity: 2, score: 1, terrain: null, unlockLevel: 1,
    color: '#8d6e63',
  },
  house: {
    name: '瓦屋', abbr: '瓦', category: '民居',
    size: [1, 1], cost: { money: 40, wood: 20 },
    inputs: {}, outputs: {}, workers: 0,
    capacity: 4, score: 3, terrain: null, unlockLevel: 3,
    color: '#a1887f',
  },
  farm: {
    name: '农田', abbr: '田', category: '原料',
    size: [2, 2], cost: { money: 15, wood: 10 },
    inputs: {}, outputs: { grain: 2 }, workers: 0,
    capacity: 0, score: 2, terrain: 'fertile', unlockLevel: 1,
    color: '#7cb342',
  },
  forest: {
    name: '林场', abbr: '林', category: '原料',
    size: [2, 2], cost: { money: 15, wood: 5 },
    inputs: {}, outputs: { wood: 1 }, workers: 0,
    capacity: 0, score: 2, terrain: 'woodland', unlockLevel: 1,
    color: '#33691e',
  },
  mill: {
    name: '磨坊', abbr: '磨', category: '工坊',
    size: [2, 2], cost: { money: 30, wood: 20 },
    inputs: { grain: 2 }, outputs: { food: 1 }, workers: 1,
    capacity: 0, score: 4, terrain: null, unlockLevel: 1,
    color: '#ffb300',
  },
  carpenter: {
    name: '木匠铺', abbr: '木', category: '工坊',
    size: [1, 1], cost: { money: 30, wood: 15 },
    inputs: { wood: 2 }, outputs: { goods: 1 }, workers: 2,
    capacity: 0, score: 4, terrain: null, unlockLevel: 3,
    color: '#795548',
  },
  eatery: {
    name: '食肆', abbr: '食', category: '商业',
    size: [1, 1], cost: { money: 50, wood: 25 },
    inputs: { food: 1 }, outputs: { money: 3 }, workers: 1,
    capacity: 0, score: 5, terrain: null, unlockLevel: 2,
    color: '#e53935',
  },
  grocer: {
    name: '杂货摊', abbr: '杂', category: '商业',
    size: [1, 1], cost: { money: 80, wood: 40 },
    inputs: { goods: 1 }, outputs: { money: 5 }, workers: 1,
    capacity: 0, score: 6, terrain: null, unlockLevel: 4,
    color: '#8e24aa',
  },
  granary: {
    name: '粮仓', abbr: '仓', category: '存储',
    size: [2, 2], cost: { money: 40, wood: 30 },
    inputs: {}, outputs: {}, workers: 0,
    capacity: 0, score: 2, terrain: null, unlockLevel: 2,
    color: '#c0ca33',
  },
};

// 配置校验：字段完整性、资源名拼写必须存在于 resources.js
export function validateConfig() {
  const errors = [];
  for (const [id, def] of Object.entries(BUILDINGS)) {
    if (!def.name || !def.abbr) errors.push(`${id}: 缺少 name/abbr`);
    if (!Array.isArray(def.size) || def.size.length !== 2 || def.size.some((n) => n <= 0))
      errors.push(`${id}: size 非法`);
    if (typeof def.cost?.money !== 'number' || typeof def.cost?.wood !== 'number')
      errors.push(`${id}: cost 缺 money/wood`);
    for (const res of Object.keys(def.inputs ?? {}))
      if (!(res in RESOURCES)) errors.push(`${id}: inputs 引用了未知资源 ${res}`);
    for (const res of Object.keys(def.outputs ?? {}))
      if (res !== 'money' && !(res in RESOURCES)) errors.push(`${id}: outputs 引用了未知资源 ${res}`);
    if (def.terrain && !['fertile', 'woodland'].includes(def.terrain))
      errors.push(`${id}: 未知地形要求 ${def.terrain}`);
  }
  if (errors.length) throw new Error('建筑配置校验失败:\n' + errors.join('\n'));
}
