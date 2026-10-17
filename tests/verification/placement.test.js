// 独立验收：放置约束（地形 / 边界 / 重叠 / 造价 / 拆除返还）
import { describe, it, expect, beforeEach } from 'vitest';
import { createInitialState } from '../../src/core/state.js';
import { canPlace, placeBuilding, demolishBuilding, buildingAt } from '../../src/core/grid.js';
import { BUILDINGS } from '../../src/config/buildings.js';
import { RULES } from '../../src/config/rules.js';

let state;
beforeEach(() => {
  state = createInitialState();
});

// 找一块所有格子均为指定地形且未占用的 w×h 区域（不依赖既有测试的 helpers）
function findTerrainSpot(terrain, w, h) {
  const size = RULES.mapSize;
  for (let y = 0; y <= size - h; y++)
    for (let x = 0; x <= size - w; x++) {
      let ok = true;
      for (let dy = 0; dy < h && ok; dy++)
        for (let dx = 0; dx < w && ok; dx++) {
          const cell = state.grid.get(`${x + dx},${y + dy}`);
          if (!cell || cell.terrain !== terrain || cell.buildingId != null) ok = false;
        }
      if (ok) return { x, y };
    }
  return null;
}

describe('地形约束（设计案 2.1：农田/林场需建在对应地形格上）', () => {
  it('农田放林地必须失败', () => {
    const s = findTerrainSpot('woodland', 2, 2);
    expect(s, '地图上应存在 2×2 林地').not.toBeNull();
    const r = canPlace(state, 'farm', s.x, s.y);
    expect(r.ok).toBe(false);
    expect(placeBuilding(state, 'farm', s.x, s.y).ok).toBe(false);
  });

  it('农田放普通空地必须失败', () => {
    const s = findTerrainSpot('plain', 2, 2);
    expect(s).not.toBeNull();
    expect(canPlace(state, 'farm', s.x, s.y).ok).toBe(false);
  });

  it('林场放沃土必须失败', () => {
    const s = findTerrainSpot('fertile', 2, 2);
    expect(s).not.toBeNull();
    expect(canPlace(state, 'forest', s.x, s.y).ok).toBe(false);
  });

  it('农田放沃土成功 / 林场放林地成功（对照）', () => {
    const f = findTerrainSpot('fertile', 2, 2);
    expect(placeBuilding(state, 'farm', f.x, f.y).ok).toBe(true);
    const w = findTerrainSpot('woodland', 2, 2);
    expect(placeBuilding(state, 'forest', w.x, w.y).ok).toBe(true);
  });

  it('2×2 农田跨地形（部分沃土部分非沃土）必须失败', () => {
    // 找一个不全是沃土的 2×2 区域，且至少含 1 格沃土
    const size = RULES.mapSize;
    let spot = null;
    outer: for (let y = 0; y <= size - 2; y++)
      for (let x = 0; x <= size - 2; x++) {
        const terrains = new Set();
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++)
            terrains.add(state.grid.get(`${x + dx},${y + dy}`).terrain);
        if (terrains.has('fertile') && terrains.size > 1) { spot = { x, y }; break outer; }
      }
    expect(spot, '地图应存在跨地形边界').not.toBeNull();
    expect(canPlace(state, 'farm', spot.x, spot.y).ok).toBe(false);
  });
});

describe('2×2 建筑边界与重叠', () => {
  it('2×2 建筑压右边界（x=31）必须失败', () => {
    expect(canPlace(state, 'mill', 31, 10).ok).toBe(false);
  });

  it('2×2 建筑压底边界（y=31）必须失败', () => {
    expect(canPlace(state, 'mill', 10, 31).ok).toBe(false);
  });

  it('2×2 建筑贴边（x=30,y=30）应成功', () => {
    expect(placeBuilding(state, 'mill', 30, 30).ok).toBe(true);
    // 占用四格
    for (const [x, y] of [[30, 30], [31, 30], [30, 31], [31, 31]])
      expect(state.grid.get(`${x},${y}`).buildingId).not.toBeNull();
  });

  it('与已有建筑部分重叠必须失败', () => {
    const s = findTerrainSpot('fertile', 2, 2);
    expect(placeBuilding(state, 'farm', s.x, s.y).ok).toBe(true);
    // 磨坊右下角压在农田左上角一格
    const r = canPlace(state, 'mill', s.x - 1, s.y - 1);
    if (s.x > 0 && s.y > 0) expect(r.ok).toBe(false);
    // 直接完全重叠
    expect(canPlace(state, 'mill', s.x, s.y).ok).toBe(false);
  });

  it('1×1 建筑放在 2×2 建筑内部任意一格必须失败', () => {
    const s = findTerrainSpot('fertile', 2, 2);
    placeBuilding(state, 'farm', s.x, s.y);
    expect(canPlace(state, 'hut', s.x + 1, s.y + 1).ok).toBe(false);
  });
});

describe('造价约束', () => {
  it('铜钱不足时不能建造，且资源不被扣除', () => {
    state.money = 5;
    const woodBefore = state.resources.wood;
    const s = findTerrainSpot('plain', 1, 1);
    const r = placeBuilding(state, 'hut', s.x, s.y);
    expect(r.ok).toBe(false);
    expect(state.money).toBe(5);
    expect(state.resources.wood).toBe(woodBefore);
    expect(state.buildings.length).toBe(0);
  });

  it('木材不足时不能建造', () => {
    state.resources.wood = 0;
    const s = findTerrainSpot('plain', 1, 1);
    expect(placeBuilding(state, 'hut', s.x, s.y).ok).toBe(false);
    expect(state.money).toBe(RULES.initialMoney);
  });

  it('建造成功时精确扣除铜钱与木材', () => {
    const s = findTerrainSpot('plain', 1, 1);
    placeBuilding(state, 'hut', s.x, s.y);
    expect(state.money).toBe(RULES.initialMoney - BUILDINGS.hut.cost.money);
    expect(state.resources.wood).toBe(RULES.initialResources.wood - BUILDINGS.hut.cost.wood);
  });
});

describe('拆除返还（设计案 2.1：返还 50% 造价）', () => {
  it('拆除农田返还 50%（钱 15→7，木 10→5）', () => {
    const s = findTerrainSpot('fertile', 2, 2);
    const b = placeBuilding(state, 'farm', s.x, s.y).building;
    const mBefore = state.money;
    const wBefore = state.resources.wood;
    expect(demolishBuilding(state, b.id).ok).toBe(true);
    expect(state.money).toBe(mBefore + Math.floor(15 * 0.5));
    expect(state.resources.wood).toBe(wBefore + Math.floor(10 * 0.5));
    expect(state.buildings.length).toBe(0);
  });

  it('拆除后格子完全释放，可原地重建', () => {
    const s = findTerrainSpot('fertile', 2, 2);
    const b = placeBuilding(state, 'farm', s.x, s.y).building;
    demolishBuilding(state, b.id);
    for (const [x, y] of [[s.x, s.y], [s.x + 1, s.y], [s.x, s.y + 1], [s.x + 1, s.y + 1]])
      expect(state.grid.get(`${x},${y}`).buildingId).toBeNull();
    expect(placeBuilding(state, 'farm', s.x, s.y).ok).toBe(true);
  });

  it('拆除茅舍木材返还：5 × 50% = 2.5，实现向下取整为 2（与设计案"返还 50%"存在取整偏差）', () => {
    const s = findTerrainSpot('plain', 1, 1);
    const b = placeBuilding(state, 'hut', s.x, s.y).building;
    const wBefore = state.resources.wood;
    demolishBuilding(state, b.id);
    // 设计案字面要求 50%（2.5）；实现 floor 后只给 2。此处记录实际行为。
    expect(state.resources.wood).toBe(wBefore + 2);
  });

  it('拆除不存在的建筑返回失败', () => {
    expect(demolishBuilding(state, 99999).ok).toBe(false);
  });

  it('buildingAt 能命中 2×2 建筑的非锚点格', () => {
    const s = findTerrainSpot('fertile', 2, 2);
    const b = placeBuilding(state, 'farm', s.x, s.y).building;
    expect(buildingAt(state, s.x + 1, s.y + 1)?.id).toBe(b.id);
  });
});
