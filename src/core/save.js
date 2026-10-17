// 存档：序列化/反序列化、localStorage 读写（单槽位，key 带版本号）
import { RULES } from '../config/rules.js';
import { cellKey } from './grid.js';

// state → 可 JSON 序列化的纯数据（grid Map 转数组，剔除 ui 瞬态）
export function serialize(state) {
  return {
    version: RULES.saveVersion,
    tick: state.tick,
    money: state.money,
    resources: { ...state.resources },
    population: { ...state.population },
    prosperity: state.prosperity,
    level: state.level,
    maxLevel: state.maxLevel,
    nextBuildingId: state.nextBuildingId,
    buildings: state.buildings.map((b) => ({ ...b })),
    grid: [...state.grid.entries()].map(([k, cell]) => [k, { ...cell }]),
  };
}

// 纯数据 → state（重建 grid Map，重置 ui）
export function deserialize(data, freshState) {
  const state = freshState();
  state.tick = data.tick;
  state.money = data.money;
  state.resources = { ...data.resources };
  state.population = { ...data.population };
  state.prosperity = data.prosperity;
  state.level = data.level;
  // 存档兼容（P3）：旧存档无 maxLevel 字段时以当前等级兜底初始化——旧规则下
  // 解锁本来就跟瞬时等级走，用 data.level 兜底语义等价，无需提升 saveVersion
  state.maxLevel = data.maxLevel ?? data.level ?? 1;
  state.nextBuildingId = data.nextBuildingId;
  state.buildings = data.buildings.map((b) => ({ ...b }));
  state.grid = new Map(data.grid.map(([k, cell]) => [k, { ...cell }]));
  // 防御：若存档与当前地图尺寸不符（如配置改动），丢弃
  if (state.grid.size !== RULES.mapSize * RULES.mapSize) return null;
  return state;
}

function storageAvailable() {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

export function hasSave() {
  if (!storageAvailable()) return false;
  return localStorage.getItem(RULES.saveKey) != null;
}

export function saveGame(state) {
  if (!storageAvailable()) return false;
  localStorage.setItem(RULES.saveKey, JSON.stringify(serialize(state)));
  return true;
}

// 返回 state 或 null（无存档/版本不符/损坏）
export function loadGame(freshState) {
  if (!storageAvailable()) return null;
  const raw = localStorage.getItem(RULES.saveKey);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (data.version !== RULES.saveVersion) return null;
    return deserialize(data, freshState);
  } catch {
    return null;
  }
}

export function clearSave() {
  if (!storageAvailable()) return;
  localStorage.removeItem(RULES.saveKey);
}

// 供序列化测试使用的辅助：从建筑重建格子占用（校验用）
export function gridKeyOf(x, y) {
  return cellKey(x, y);
}
