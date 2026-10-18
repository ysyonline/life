// UX-3 提示纯函数单测：触发条件、停滞窗口、优先级、一次性（由装配层语义保证，此处验证谓词边界）
// 纪律：hints.js 是只读纯函数，所有用例同时断言「不写 state」。
import { describe, it, expect, beforeEach } from 'vitest';
import { createInitialState } from '../src/core/state.js';
import { placeBuilding } from '../src/core/grid.js';
import { tick } from '../src/core/simulation.js';
import {
  evaluateHints,
  isStagnant,
  isSlowGrowth,
  historyCapacity,
  pushProsperity,
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
const GW = UI_HINTS.growthWindow;
const G = UI_HINTS.growthDelta;

// 按「每 tick 固定增量」构造窗口历史：totalDelta 为 GW tick 窗口内的总增量
function rampHistory(len, start, perTick) {
  return Array.from({ length: len }, (_, i) => start + i * perTick);
}

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

describe('isSlowGrowth 增速不足判定（A4 修订 b）', () => {
  it('采样不足 window+1 时不判增速不足', () => {
    expect(isSlowGrowth([])).toBe(false);
    expect(isSlowGrowth(rampHistory(GW, 20, 0.1))).toBe(false); // 恰好 GW 个采样
  });

  it('窗口 Δ 低于 growthDelta 判增速不足（P4 缓慢爬升型 6/60tick）', () => {
    const hist = rampHistory(GW + 1, 20, 0.1); // 60 tick Δ = 6.0 < 10
    expect(isSlowGrowth(hist)).toBe(true);
    expect(isStagnant(hist)).toBe(false); // 停滞口径抓不到——这正是 A4 的盲区
  });

  it('窗口 Δ 达到 growthDelta 不判增速不足（快玩家边界）', () => {
    // Δ 恰好 = 阈值（不 < 阈值）→ 不触发。用整数构造，避开浮点累加的边界抖动
    const exact = flatHistory(GW + 1, 20);
    exact[exact.length - 1] = 20 + G;
    expect(isSlowGrowth(exact)).toBe(false);
    // 12/60tick 是 11 局回放中「快玩家」的最小窗口 Δ（12.2 量级），必须不触发
    const fast = flatHistory(GW + 1, 20);
    fast[fast.length - 1] = 32;
    expect(isSlowGrowth(fast)).toBe(false);
  });

  it('静止与下坡都算增速不足', () => {
    expect(isSlowGrowth(flatHistory(GW + 1, 25))).toBe(true);
    expect(isSlowGrowth(rampHistory(GW + 1, 40, -0.2))).toBe(true); // 断粮回落
  });
});

describe('环形缓冲容量（防「增速判定静默永不触发」）', () => {
  it('容量取两个窗口的较大者 +1', () => {
    expect(historyCapacity()).toBe(Math.max(W, GW) + 1);
    expect(historyCapacity({ stagnationWindow: 10, growthWindow: 30 })).toBe(31);
    expect(historyCapacity({ stagnationWindow: 30, growthWindow: 10 })).toBe(31);
  });

  it('pushProsperity 按容量裁剪，且裁剪后仍够两个窗口判定', () => {
    const buf = [];
    for (let i = 0; i < 500; i++) pushProsperity(buf, i);
    expect(buf.length).toBe(historyCapacity());
    expect(buf.length).toBeGreaterThanOrEqual(Math.max(W, GW) + 1); // 采样足够，不会静默失效
    expect(buf[buf.length - 1]).toBe(499); // 保留最新值
  });

  it('增长窗口大于停滞窗口时，缓冲必须按较大者裁剪', () => {
    const opts = { stagnationWindow: 10, growthWindow: 40 };
    const buf = [];
    for (let i = 0; i < 100; i++) pushProsperity(buf, i, opts);
    expect(buf.length).toBe(41);
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

  it('T1：快玩家（12/60tick）不触发——增速口径的上边界保护', () => {
    state.level = 2;
    state.maxLevel = 2;
    // 每 tick +0.2 → 60 tick Δ=12：停滞为假，且 12 > growthDelta(10) 故增速不足也为假
    // 该输入对应 11 局回放中「快玩家」的最小窗口 Δ（12.2 量级），是误伤保护的关键边界，勿放宽阈值到 ≥12
    const hist = Array.from({ length: W + 1 }, (_, i) => 25 + i * 0.2);
    expect(isStagnant(hist)).toBe(false);
    expect(isSlowGrowth(hist)).toBe(false);
    expect(evaluateHints(state, { prosperityHistory: hist })).toEqual([]);
  });

  it('T1：慢爬玩家（6/60tick）触发——A4 修订 b 的核心场景', () => {
    state.level = 2;
    state.maxLevel = 2;
    // P4 实测量级：繁荣度 24→40 以 6~8/60tick 爬升，停滞口径在结构上永远抓不到（A4 报告 §3.1）
    const hist = Array.from({ length: W + 1 }, (_, i) => 24 + i * 0.1);
    expect(isStagnant(hist)).toBe(false);
    expect(isSlowGrowth(hist)).toBe(true);
    expect(evaluateHints(state, { prosperityHistory: hist })).toEqual(['t1']);
  });

  it('T2 不受增速口径影响（只走停滞）—— 防误弹护城河', () => {
    state.level = 2;
    state.maxLevel = 2;
    // 先建 1 座食肆隔离 T1（否则 T1 会因无食肆而触发）
    const e = findSpot(state, null, 1, 1);
    placeBuilding(state, 'eatery', e.x, e.y);
    for (let i = 0; i < 4; i++) {
      const s = findSpot(state, null, 1, 1);
      placeBuilding(state, 'hut', s.x, s.y);
    }
    expect(vacantCapacity(state)).toBe(8);
    // 慢爬但未停滞：Δ=6 < growthDelta，但 > stagnationDelta
    const hist = Array.from({ length: W + 1 }, (_, i) => 24 + i * 0.1);
    expect(isSlowGrowth(hist)).toBe(true);
    // T2 若被增速口径连带触发，新手正常建房期会被反复打扰——本用例钉死该边界
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
    // A4 修订 a：T1 必须点明「恒计分 vs 运转计分」区分（回应 P5「没粮也涨分」困惑）
    expect(hintText('t1', state)).toContain('建好就计分');
    expect(hintText('t1', state)).toContain('封顶 26');
    expect(hintText('t1', state)).toContain('农田 → 磨坊');
    // A4 复测甲（D-甲）：T1 必须含「钱不够」恢复路径（攒市税 / 拆建返还五成）——
    // B 案例（触发时 8 钱 vs 食肆 50 钱）证明无恢复路径的处方不可执行
    expect(hintText('t1', state)).toContain('攒市税');
    expect(hintText('t1', state)).toContain('返还五成');
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
