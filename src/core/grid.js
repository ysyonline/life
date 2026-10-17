// 网格系统：地块数据、地形生成、放置校验、建造/拆除
import { BUILDINGS } from '../config/buildings.js';
import { RULES } from '../config/rules.js';

export const TERRAIN = { PLAIN: 'plain', FERTILE: 'fertile', WOODLAND: 'woodland' };

export function cellKey(x, y) {
  return `${x},${y}`;
}

// 确定性伪随机（mulberry32），保证每次开局地形一致
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 预生成地形：若干团块状的沃土与林地，其余为普通地
export function genTerrain(size, seed = 20261016) {
  const rand = mulberry32(seed);
  const map = Array.from({ length: size }, () => Array(size).fill(TERRAIN.PLAIN));

  const blob = (cx, cy, radius, terrain) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= radius * (0.75 + rand() * 0.5)) map[y][x] = terrain;
      }
    }
  };

  // 沃土：左下、右上两团；林地：左上、右下两团
  blob(8, 22, 6, TERRAIN.FERTILE);
  blob(24, 8, 5, TERRAIN.FERTILE);
  blob(7, 7, 5, TERRAIN.WOODLAND);
  blob(24, 24, 6, TERRAIN.WOODLAND);
  return map;
}

export function createGrid(size) {
  const terrain = genTerrain(size);
  const grid = new Map();
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      grid.set(cellKey(x, y), { terrain: terrain[y][x], buildingId: null });
  return grid;
}

export function getCell(state, x, y) {
  return state.grid.get(cellKey(x, y)) ?? null;
}

// 放置校验：解锁等级、边界、占用、地形。返回 { ok, reason }
// 解锁等级是唯一权威判定（UI 层的置灰只是提示），绕过 UI 的调用同样受此约束
export function canPlace(state, type, x, y) {
  const def = BUILDINGS[type];
  if (!def) return { ok: false, reason: '未知建筑' };
  if (def.unlockLevel > state.level)
    return { ok: false, reason: 'locked', needLevel: def.unlockLevel };
  const [w, h] = def.size;
  const size = RULES.mapSize;
  if (x < 0 || y < 0 || x + w > size || y + h > size)
    return { ok: false, reason: '超出边界' };
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const cell = getCell(state, x + dx, y + dy);
      if (!cell) return { ok: false, reason: '超出边界' };
      if (cell.buildingId != null) return { ok: false, reason: '格子被占用' };
      if (def.terrain && cell.terrain !== def.terrain)
        return { ok: false, reason: def.terrain === TERRAIN.FERTILE ? '需建在沃土上' : '需建在林地上' };
    }
  }
  return { ok: true, reason: null };
}

export function canAfford(state, type) {
  const cost = BUILDINGS[type].cost;
  return state.money >= cost.money && state.resources.wood >= cost.wood;
}

// 建造（意图函数）：校验地形/占用/造价，扣铜钱+木材，放置即时完成
export function placeBuilding(state, type, x, y) {
  const check = canPlace(state, type, x, y);
  if (!check.ok) return { ok: false, reason: check.reason, needLevel: check.needLevel };
  if (!canAfford(state, type)) return { ok: false, reason: '铜钱或木材不足' };

  const def = BUILDINGS[type];
  state.money -= def.cost.money;
  state.resources.wood -= def.cost.wood;

  const id = state.nextBuildingId++;
  const building = { id, type, anchorX: x, anchorY: y, idle: false, idleReason: null };
  state.buildings.push(building);
  const [w, h] = def.size;
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      getCell(state, x + dx, y + dy).buildingId = id;
  return { ok: true, building };
}

// 拆除（意图函数）：返还 50% 造价（向下取整）
export function demolishBuilding(state, id) {
  const idx = state.buildings.findIndex((b) => b.id === id);
  if (idx < 0) return { ok: false, reason: '建筑不存在' };
  const b = state.buildings[idx];
  const def = BUILDINGS[b.type];
  const [w, h] = def.size;
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++) {
      const cell = getCell(state, b.anchorX + dx, b.anchorY + dy);
      if (cell && cell.buildingId === id) cell.buildingId = null;
    }
  state.money += Math.floor(def.cost.money * RULES.demolishRefundRate);
  state.resources.wood += Math.floor(def.cost.wood * RULES.demolishRefundRate);
  state.buildings.splice(idx, 1);
  if (state.ui.selectedBuildingId === id) state.ui.selectedBuildingId = null;
  return { ok: true };
}

export function buildingAt(state, x, y) {
  const cell = getCell(state, x, y);
  if (!cell || cell.buildingId == null) return null;
  return state.buildings.find((b) => b.id === cell.buildingId) ?? null;
}
