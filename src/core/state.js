// 单一 state 树定义与初始化
import { RESOURCES, INITIAL_MONEY } from '../config/resources.js';
import { RULES } from '../config/rules.js';
import { validateConfig } from '../config/buildings.js';
import { createGrid } from './grid.js';

export function createInitialState() {
  validateConfig();
  const resources = {};
  for (const [id, def] of Object.entries(RESOURCES)) resources[id] = def.initial;

  return {
    version: RULES.saveVersion,
    tick: 0,
    money: INITIAL_MONEY,
    resources,
    population: { count: 0, starveTicks: 0 },
    prosperity: 0,
    level: 1,
    maxLevel: 1, // 历史最高等级（P3 解锁粘性，只升不降）；建造解锁判定以此为准
    grid: createGrid(RULES.mapSize), // Map<"x,y", { terrain, buildingId }>
    buildings: [], // { id, type, anchorX, anchorY, idle, idleReason }
    nextBuildingId: 1,
    // highlightType：UX-2 建造菜单高亮目标（Lv4 达成后置为 'grocer'，玩家选中后清除）；瞬态不入存档
    ui: { placingType: null, hoverCell: null, selectedBuildingId: null, toast: null, highlightType: null },
  };
}
