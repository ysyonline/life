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
    grid: createGrid(RULES.mapSize), // Map<"x,y", { terrain, buildingId }>
    buildings: [], // { id, type, anchorX, anchorY, idle, idleReason }
    nextBuildingId: 1,
    ui: { placingType: null, hoverCell: null, selectedBuildingId: null, toast: null },
  };
}
