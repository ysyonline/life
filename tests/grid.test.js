// 放置校验、地形约束、造价扣减、拆除返还
import { describe, it, expect, beforeEach } from 'vitest';
import { createInitialState } from '../src/core/state.js';
import {
  canPlace,
  canAfford,
  placeBuilding,
  demolishBuilding,
  buildingAt,
} from '../src/core/grid.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

let state;

beforeEach(() => {
  state = createInitialState();
});

// 找一块 w×h 全为指定地形（传 null 表示不限地形）且未被占用的空地
function findSpot(terrain, w = 1, h = 1) {
  for (let y = 0; y < RULES.mapSize; y++) {
    for (let x = 0; x < RULES.mapSize; x++) {
      let ok = true;
      for (let dy = 0; dy < h && ok; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const c = state.grid.get(`${x + dx},${y + dy}`);
          if (!c || c.buildingId != null || (terrain && c.terrain !== terrain)) {
            ok = false;
            break;
          }
        }
      }
      if (ok) return { x, y };
    }
  }
  return null;
}

describe('地形约束', () => {
  it('农田只能建在沃土上，其他地形报"需建在沃土上"', () => {
    const spot = findSpot('plain', 2, 2);
    expect(spot).not.toBeNull();
    const r = canPlace(state, 'farm', spot.x, spot.y);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('需建在沃土上');
  });

  it('林场只能建在林地上，其他地形报"需建在林地上"', () => {
    const spot = findSpot('plain', 2, 2);
    const r = canPlace(state, 'forest', spot.x, spot.y);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('需建在林地上');
  });

  it('农田建在沃土、林场建在林地均通过', () => {
    const f = findSpot('fertile', 2, 2);
    const w = findSpot('woodland', 2, 2);
    expect(f).not.toBeNull();
    expect(w).not.toBeNull();
    expect(canPlace(state, 'farm', f.x, f.y).ok).toBe(true);
    expect(canPlace(state, 'forest', w.x, w.y).ok).toBe(true);
  });

  it('无地形要求的建筑（磨坊）可建在普通地上', () => {
    const spot = findSpot('plain', 2, 2);
    expect(canPlace(state, 'mill', spot.x, spot.y).ok).toBe(true);
  });
});

describe('边界与占用', () => {
  it('超出地图边界被拒绝', () => {
    expect(canPlace(state, 'hut', RULES.mapSize, 0).reason).toBe('超出边界');
    expect(canPlace(state, 'mill', RULES.mapSize - 1, RULES.mapSize - 1).reason).toBe('超出边界');
    expect(canPlace(state, 'hut', -1, 0).reason).toBe('超出边界');
  });

  it('2×2 建筑压到边界外被拒绝，边界内则通过', () => {
    expect(canPlace(state, 'mill', RULES.mapSize - 2, RULES.mapSize - 2).ok).toBe(true);
    expect(canPlace(state, 'mill', RULES.mapSize - 1, RULES.mapSize - 2).ok).toBe(false);
  });

  it('已占用的格子不可再建', () => {
    const spot = findSpot(null, 1, 1);
    expect(placeBuilding(state, 'hut', spot.x, spot.y).ok).toBe(true);
    const again = canPlace(state, 'hut', spot.x, spot.y);
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('格子被占用');
  });

  it('未知建筑类型被拒绝', () => {
    expect(canPlace(state, 'nope', 0, 0).ok).toBe(false);
  });
});

describe('造价与建造', () => {
  it('canAfford 按铜钱+木材双重判定', () => {
    expect(canAfford(state, 'hut')).toBe(true); // 钱240/木60，茅舍 10/5
    state.money = BUILDINGS.hut.cost.money - 1;
    expect(canAfford(state, 'hut')).toBe(false);
    state.money = 240;
    state.resources.wood = BUILDINGS.hut.cost.wood - 1;
    expect(canAfford(state, 'hut')).toBe(false);
  });

  it('建造扣除铜钱与木材，并在占位格写入 buildingId', () => {
    const spot = findSpot(null, 1, 1);
    const r = placeBuilding(state, 'hut', spot.x, spot.y);
    expect(r.ok).toBe(true);
    expect(state.money).toBe(240 - 10);
    expect(state.resources.wood).toBe(60 - 5);
    expect(buildingAt(state, spot.x, spot.y).id).toBe(r.building.id);
  });

  it('买不起时不扣资源也不落地', () => {
    state.money = 0;
    const spot = findSpot(null, 1, 1);
    const r = placeBuilding(state, 'hut', spot.x, spot.y);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('铜钱或木材不足');
    expect(state.buildings.length).toBe(0);
  });

  it('2×2 建筑占用 4 格且指向同一 id', () => {
    const spot = findSpot(null, 2, 2);
    const r = placeBuilding(state, 'mill', spot.x, spot.y);
    const id = r.building.id;
    const cells = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ].map(([dx, dy]) => state.grid.get(`${spot.x + dx},${spot.y + dy}`).buildingId);
    expect(cells).toEqual([id, id, id, id]);
  });
});

describe('解锁等级校验（core 层权威判定）', () => {
  // 动态取一个「解锁等级 > 1 且无地形要求」的建筑，避免写死具体数值
  function lockedType() {
    const id = Object.keys(BUILDINGS).find(
      (t) => BUILDINGS[t].unlockLevel > 1 && !BUILDINGS[t].terrain
    );
    if (!id) throw new Error('配置中缺少 unlockLevel > 1 的建筑，用例无法成立');
    return id;
  }

  it('Lv1 时建造未解锁建筑被拒，reason=locked 且带回 needLevel', () => {
    const type = lockedType();
    const need = BUILDINGS[type].unlockLevel;
    const [w, h] = BUILDINGS[type].size;
    const spot = findSpot(null, w, h);
    expect(state.level).toBe(1);
    expect(need).toBeGreaterThan(1);

    const r = canPlace(state, type, spot.x, spot.y);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('locked');
    expect(r.needLevel).toBe(need);
  });

  it('placeBuilding 同样被解锁校验拦下：不落地、不扣资源', () => {
    const type = lockedType();
    const [w, h] = BUILDINGS[type].size;
    state.money = 100000;
    state.resources.wood = 100000;
    const spot = findSpot(null, w, h);

    const r = placeBuilding(state, type, spot.x, spot.y);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('locked');
    expect(r.needLevel).toBe(BUILDINGS[type].unlockLevel);
    expect(state.buildings.length).toBe(0);
    expect(state.money).toBe(100000);
    expect(state.resources.wood).toBe(100000);
  });

  it('繁荣度等级达标后解锁，可正常建造', () => {
    const type = lockedType();
    const need = BUILDINGS[type].unlockLevel;
    const [w, h] = BUILDINGS[type].size;
    const spot = findSpot(null, w, h);

    state.level = need - 1;
    expect(canPlace(state, type, spot.x, spot.y).ok).toBe(false);

    state.level = need;
    expect(canPlace(state, type, spot.x, spot.y).ok).toBe(true);
    const r = placeBuilding(state, type, spot.x, spot.y);
    expect(r.ok).toBe(true);
    expect(state.buildings.length).toBe(1);
  });
});

describe('拆除', () => {
  it('返还 50% 造价（向下取整）并清空占位', () => {
    const spot = findSpot(null, 1, 1);
    const r = placeBuilding(state, 'hut', spot.x, spot.y);
    const d = demolishBuilding(state, r.building.id);
    expect(d.ok).toBe(true);
    expect(state.money).toBe(240 - 10 + 5); // 返 floor(10*0.5)
    expect(state.resources.wood).toBe(60 - 5 + 2); // 返 floor(5*0.5)
    expect(state.buildings.length).toBe(0);
    expect(state.grid.get(`${spot.x},${spot.y}`).buildingId).toBeNull();
  });

  it('拆除选中的建筑后清除选中态', () => {
    const spot = findSpot(null, 1, 1);
    const r = placeBuilding(state, 'hut', spot.x, spot.y);
    state.ui.selectedBuildingId = r.building.id;
    demolishBuilding(state, r.building.id);
    expect(state.ui.selectedBuildingId).toBeNull();
  });

  it('拆除不存在的建筑返回失败', () => {
    expect(demolishBuilding(state, 999).ok).toBe(false);
  });
});
