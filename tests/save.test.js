// 存档序列化 / 反序列化往返，以及 localStorage 读写（用内存桩替代浏览器 localStorage）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createInitialState } from '../src/core/state.js';
import { serialize, deserialize, saveGame, loadGame, hasSave, clearSave } from '../src/core/save.js';
import { placeBuilding } from '../src/core/grid.js';
import { RULES } from '../src/config/rules.js';
import { findSpot } from './helpers.js';

// 内存版 localStorage 桩
function installLocalStorageStub() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

let state;

beforeEach(() => {
  installLocalStorageStub();
  state = createInitialState();
});

afterEach(() => {
  delete globalThis.localStorage;
});

describe('序列化 / 反序列化', () => {
  it('核心字段往返一致', () => {
    const spot = findSpot(state, null, 1, 1);
    placeBuilding(state, 'hut', spot.x, spot.y);
    state.tick = 7;
    state.money = 55;
    state.population.count = 3;

    const data = serialize(state);
    expect(JSON.parse(JSON.stringify(data))).toEqual(data); // 可 JSON 往返

    const loaded = deserialize(data, createInitialState);
    expect(loaded).not.toBeNull();
    expect(loaded.tick).toBe(7);
    expect(loaded.money).toBe(55);
    expect(loaded.population.count).toBe(3);
    expect(loaded.buildings.length).toBe(1);
    expect(loaded.nextBuildingId).toBe(state.nextBuildingId);
    expect(loaded.grid.size).toBe(RULES.mapSize * RULES.mapSize);
    expect(loaded.grid.get(`${spot.x},${spot.y}`).buildingId).toBe(
      state.grid.get(`${spot.x},${spot.y}`).buildingId
    );
  });

  it('网格尺寸与当前地图不符时返回 null', () => {
    const data = serialize(state);
    data.grid = data.grid.slice(0, 10);
    expect(deserialize(data, createInitialState)).toBeNull();
  });

  it('反序列化后 ui 为全新瞬态', () => {
    state.ui.selectedBuildingId = 42;
    const loaded = deserialize(serialize(state), createInitialState);
    expect(loaded.ui.selectedBuildingId).toBeNull();
  });
});

describe('localStorage 读写', () => {
  it('保存后可载入，且 hasSave 为真', () => {
    expect(hasSave()).toBe(false);
    state.money = 42;

    expect(saveGame(state)).toBe(true);
    expect(hasSave()).toBe(true);
    expect(loadGame(createInitialState).money).toBe(42);
  });

  it('版本号不符时拒绝加载', () => {
    saveGame(state);
    const raw = JSON.parse(localStorage.getItem(RULES.saveKey));
    raw.version = RULES.saveVersion + 1;
    localStorage.setItem(RULES.saveKey, JSON.stringify(raw));
    expect(loadGame(createInitialState)).toBeNull();
  });

  it('存档损坏（非 JSON）时返回 null', () => {
    localStorage.setItem(RULES.saveKey, '{not-json');
    expect(loadGame(createInitialState)).toBeNull();
  });

  it('clearSave 清除存档', () => {
    saveGame(state);
    clearSave();
    expect(hasSave()).toBe(false);
    expect(loadGame(createInitialState)).toBeNull();
  });
});
