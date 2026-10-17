// 测试辅助：在指定地形上找一块 w×h 的空地（terrain 传 null 表示不限地形）
import { RULES } from '../src/config/rules.js';

export function findSpot(state, terrain = null, w = 1, h = 1) {
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
