// UX-3 提示纯函数单测：触发条件、停滞窗口、优先级、一次性（由装配层语义保证，此处验证谓词边界）
// 纪律：hints.js 是只读纯函数，所有用例同时断言「不写 state」。
import { describe, it, expect, beforeEach } from 'vitest';
import { createInitialState } from '../src/core/state.js';
import { placeBuilding } from '../src/core/grid.js';
import { tick } from '../src/core/simulation.js';
import {
  evaluateHints,
  isStagnant,
  eateryCount,
  vacantCapacity,
  hintText,
  HINT_ORDER,
} from '../src/core/hints.js';
import { UI_HINTS } from '../src/config/uiHints.js';
import { findSpot } from './helpers.js';

let state;

beforeEach(() => {
  state = createInitialState();
});

// 构造一段繁荣度历史：开头 flat（停滞），可带尾部上升
function flatHistory(len, val = 20) {
  return Array.from({ length: len }, () => val);
}

const W = UI_HINTS.stagnationWindow;
const D = UI_HINTS.stagnationDelta;

describe('isStagnant 停滞窗口判定', () => {
  it('采样不足 window+1 时不判停滞（避免开局误触发）', () => {
    expect(isStagnant([])).toBe(false);
    expect(isStagnant(flatHistory(W))).toBe(false); // 恰好 W 个采样，测不出「W tick 的 Δ」
    expect(isStagnant(flatHistory(W + 1))).toBe(true); // W+1 个采样，Δ=0 < delta
  });

  it('窗口内 Δ 低于阈值判停滞，达到阈值不判', () => {
    const base = flatHistory(W + 1, 20);
    // 末尾 +0.5（< 1.0）→ 停滞
    const small = [...base];
    small[small.length - 1] = 20.5;
    expect(isStagnant(small)).toBe(true);
    // 末尾 +1.0（= 阈值，不 < 阈值）→ 不停滞
    const big = [...base];
    big[big.length - 1] = 21.0;
    expect(isStagnant(big)).toBe(false);
  });

  it('窗口只看最近的 W tick（更早的上升不影响当前停滞判定）', () => {
    const hist = [0, ...flatHistory(W, 30), 30.5]; // 很早有一次从 0 跳 30 的上升，最近 W tick 内 Δ=0.5
    expect(hist.length).toBe(W + 2);
    expect(isStagnant(hist)).toBe(true);
  });
});

describe('evaluateHints 触发条件', () => {
  it('T0：tick 达到阈值且零建筑时触发，已有建筑则不触发', () => {
    state.tick = UI_HINTS.t0Tick;
    expect(evaluateHints(state, { prosperityHistory: [] })).toEqual(['t0']);

    state.tick = UI_HINTS.t0Tick - 1;
    expect(evaluateHints(state, { prosperityHistory: [] })).toEqual([]);

    state.tick = UI_HINTS.t0Tick;
    const s = findSpot(state, 'fertile', 2, 2);
    placeBuilding(state, 'farm', s.x, s.y);
    expect(evaluateHints(state, { prosperityHistory: [] })).toEqual([]);
  });

  it('T1：Lv2 及以上 + 无食肆 + 停滞 → t1', () => {
    state.level = 2;
    state.maxLevel = 2;
    const hist = flatHistory(W + 1, 25);
    expect(evaluateHints(state, { prosperityHistory: hist })).toEqual(['t1']);
  });

  it('T1：有食肆时不触发（对症判据）', () => {
    state.level = 2;
    state.maxLevel = 2;
    const s = findSpot(state, null, 1, 1);
    placeBuilding(state, 'eatery', s.x, s.y);
    const hist = flatHistory(W + 1, 25);
    expect(evaluateHints(state, { prosperityHistory: hist })).toEqual([]);
  });

  it('T1：Lv1 时不触发（食肆尚未解锁）', () => {
    state.level = 1;
    state.maxLevel = 1;
    const hist = flatHistory(W + 1, 10);
    expect(evaluateHints(state, { prosperityHistory: hist })).toEqual([]);
  });

  it('T1：繁荣度持续在动（熟练玩家）不触发——与窗口长度无关', () => {
    state.level = 2;
    state.maxLevel = 2;
    // 每 tick 上升 0.2（远小于停滞阈值但非停滞？—— 0.2×W 远超 1.0，故不停滞）
    const hist = Array.from({ length: W + 1 }, (_, i) => 25 + i * 0.2);
    expect(isStagnant(hist)).toBe(false);
    expect(evaluateHints(state, { prosperityHistory: hist })).toEqual([]);
  });

  it('T2：Lv2 及以上 + 空置容量超阈值 + 停滞 → t2', () => {
    state.level = 2;
    state.maxLevel = 2;
    // 先建 1 座食肆，隔离 T1（避免「无食肆」也触发）
    const e = findSpot(state, null, 1, 1);
    placeBuilding(state, 'eatery', e.x, e.y);
    // 再建 4 间茅舍（容量 8），0 户 → 空置 8 ≥ 6
    for (let i = 0; i < 4; i++) {
      const s = findSpot(state, null, 1, 1);
      placeBuilding(state, 'hut', s.x, s.y);
    }
    expect(vacantCapacity(state)).toBe(8);
    const hist = flatHistory(W + 1, 25);
    expect(evaluateHints(state, { prosperityHistory: hist })).toEqual(['t2']);
  });

  it('T2：空置容量低于阈值不触发', () => {
    state.level = 2;
    state.maxLevel = 2;
    // 先建 1 座食肆隔离 T1
    const e = findSpot(state, null, 1, 1);
    placeBuilding(state, 'eatery', e.x, e.y);
    // 建 2 间茅舍（容量 4），住满 4 户 → 空置 0
    for (let i = 0; i < 2; i++) {
      const s = findSpot(state, null, 1, 1);
      placeBuilding(state, 'hut', s.x, s.y);
    }
    state.population.count = 4;
    expect(vacantCapacity(state)).toBe(0);
    const hist = flatHistory(W + 1, 25);
    expect(evaluateHints(state, { prosperityHistory: hist })).toEqual([]);
  });

  it('多条件同时满足时按 T1 > T2 > T0 优先级排序', () => {
    state.level = 2;
    state.maxLevel = 2;
    state.tick = UI_HINTS.t0Tick;
    // 空置容量 0（不触发 T2），但 T1（无食肆+停滞）与 T0（零建筑）都满足——T1 优先
    const hist = flatHistory(W + 1, 25);
    expect(evaluateHints(state, { prosperityHistory: hist })).toEqual(['t1', 't0']);

    // 建满民居让空置也超阈值 → 三条都满足，顺序 T1 > T2 > T0
    for (let i = 0; i < 4; i++) {
      const s = findSpot(state, null, 1, 1);
      placeBuilding(state, 'hut', s.x, s.y);
    }
    expect(evaluateHints(state, { prosperityHistory: hist })).toEqual(['t1', 't2']);
    expect(HINT_ORDER).toEqual(['t1', 't2', 't0']);
  });
});

describe('辅助谓词与文案', () => {
  it('eateryCount / vacantCapacity 只读计算', () => {
    expect(eateryCount(state)).toBe(0);
    state.level = 2;
    state.maxLevel = 2; // 食肆 unlockLevel 2，先解锁
    const s1 = findSpot(state, null, 1, 1);
    placeBuilding(state, 'eatery', s1.x, s1.y);
    expect(eateryCount(state)).toBe(1);

    const s2 = findSpot(state, null, 1, 1);
    placeBuilding(state, 'hut', s2.x, s2.y);
    expect(vacantCapacity(state)).toBe(2); // 1 间茅舍 capacity 2 − 0 户
  });

  it('hintText：T2 带实时户数/容量；未知 id 返回空串', () => {
    const s = findSpot(state, null, 1, 1);
    placeBuilding(state, 'hut', s.x, s.y);
    state.population.count = 1;
    expect(hintText('t2', state)).toContain('户数 1/容量 2'); // 户数 1 / 容量 2
    expect(hintText('t1', state)).toContain('食肆');
    expect(hintText('t0', state)).toContain('农田');
    expect(hintText('nope', state)).toBe('');
  });

  it('hints 纯函数不写 state（只读观察者）', () => {
    const before = JSON.stringify(state);
    evaluateHints(state, { prosperityHistory: flatHistory(W + 1, 20) });
    hintText('t2', state);
    isStagnant(flatHistory(W + 1, 20));
    expect(JSON.stringify(state)).toBe(before);
  });
});
