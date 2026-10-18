// UX-3 新手引导提示：纯函数谓词 + 文案派生。
// 分层纪律：本模块属 core/，零 DOM、零 state 写入，与 telemetry 同纪律（只读观察者）。
// 触发参数单一真源在 config/uiHints.js（不进 RULES，冻结令零触碰）。
// 「一次性 / dismissed / resolved」属会话状态，由装配层（main.js）维护，不进本纯函数。
import { BUILDINGS } from '../config/buildings.js';
import { UI_HINTS } from '../config/uiHints.js';

// 提示 id（按优先级 T1 > T2 > T0 排序；同屏至多一条，装配层取首个尚未显示过的）
export const HINT_ORDER = ['t1', 't2', 't0'];

// 食肆（商业）计数：T1 主提示的对症判据
export function eateryCount(state) {
  return state.buildings.filter((b) => b.type === 'eatery').length;
}

// 空置民居容量 = housingCapacity − 在城户数（T2「建房优先」签名）
export function vacantCapacity(state) {
  const cap = state.buildings.reduce((s, b) => s + (BUILDINGS[b.type].capacity ?? 0), 0);
  return cap - state.population.count;
}

// 繁荣度是否停滞：trailing window tick 内 Δprosperity < delta。
// 窗口取值对标熟练玩家徘徊段 57~64 tick，仅框定「真卡住」的判定时长（07 草案 C-3 修正）；
// 采样不足（需 window+1 个采样才能测「window tick 的 Δ」）时不判停滞，避免开局误触发。
export function isStagnant(prosperityHistory, opts = {}) {
  const window = opts.window ?? UI_HINTS.stagnationWindow;
  const delta = opts.delta ?? UI_HINTS.stagnationDelta;
  if (!Array.isArray(prosperityHistory)) return false;
  const n = prosperityHistory.length;
  if (n < window + 1) return false;
  const oldest = prosperityHistory[n - 1 - window];
  const newest = prosperityHistory[n - 1];
  return newest - oldest < delta;
}

// ---------- 各提示触发条件（纯谓词） ----------

// T1 商业缺失：Lv2 及以上 + 无食肆 + 繁荣度停滞
function t1Condition(state, history) {
  if (state.level < 2) return false;
  if (eateryCount(state) > 0) return false;
  return isStagnant(history);
}

// T2 空屋过度：Lv2 及以上 + 空置容量超阈值 + 繁荣度停滞
function t2Condition(state, history) {
  if (state.level < 2) return false;
  if (vacantCapacity(state) < UI_HINTS.vacantCapacityThreshold) return false;
  return isStagnant(history);
}

// T0 开局引导：tick 达到阈值且仍零建筑
function t0Condition(state) {
  if (state.tick < UI_HINTS.t0Tick) return false;
  return state.buildings.length === 0;
}

// 返回当前满足触发条件的提示 id 列表（已按 T1 > T2 > T0 优先级排序）。
// ctx.prosperityHistory：最近 tick 的繁荣度序列（升序，装配层维护环形缓冲）。
export function evaluateHints(state, ctx = {}) {
  const history = ctx.prosperityHistory ?? [];
  const active = [];
  if (t1Condition(state, history)) active.push('t1');
  if (t2Condition(state, history)) active.push('t2');
  if (t0Condition(state, history)) active.push('t0');
  return active;
}

// 文案派生：T2 带实时户数/容量（把不可见的折算公式变成可读事实）。返回最终可展示文案。
export function hintText(id, state) {
  switch (id) {
    case 't1':
      return '食肆已解锁——它把食换成铜钱，运转中的商业才计繁荣度。食从哪来？农田 → 磨坊。';
    case 't2': {
      const n = state.population.count;
      const m = n + vacantCapacity(state); // 民居总容量
      return `空屋不住人——民居繁荣度按入住率折算。当前户数 ${n}/容量 ${m}，先让人住满再盖新房。`;
    }
    case 't0':
      return '从农田和林场开始——粮与木是一切的源头。';
    default:
      return '';
  }
}
