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

// 缓冲容量 = 两个判定窗口的较大者 + 1。
// ⚠ 增速口径新增后必须取 max：若仍按 stagnationWindow 裁剪，growthWindow 更大时
//    历史永远凑不满样本 → 增速判定静默永不触发（不报错、看起来"改了但没效果"）。
export function historyCapacity(opts = {}) {
  const w = Math.max(
    opts.stagnationWindow ?? UI_HINTS.stagnationWindow,
    opts.growthWindow ?? UI_HINTS.growthWindow,
  );
  return w + 1;
}

// 环形缓冲推入 + 按 historyCapacity 裁剪（装配层唯一入口，避免各处硬编码窗口长度）
export function pushProsperity(buf, value, opts = {}) {
  buf.push(value);
  const cap = historyCapacity(opts);
  while (buf.length > cap) buf.shift();
  return buf;
}

// 窗口内繁荣度增量。采样不足（需 window+1 个采样才能测「window tick 的 Δ」）时返回 null，
// 由各判定自行处理（一律不判，避免开局误触发）。
function windowDelta(prosperityHistory, window) {
  if (!Array.isArray(prosperityHistory)) return null;
  const n = prosperityHistory.length;
  if (n < window + 1) return null;
  return prosperityHistory[n - 1] - prosperityHistory[n - 1 - window];
}

// 繁荣度是否停滞：trailing window tick 内 Δprosperity < delta。
// 窗口取值对标熟练玩家徘徊段 57~64 tick，仅框定「真卡住」的判定时长（07 草案 C-3 修正）。
export function isStagnant(prosperityHistory, opts = {}) {
  const window = opts.window ?? UI_HINTS.stagnationWindow;
  const delta = opts.delta ?? UI_HINTS.stagnationDelta;
  const d = windowDelta(prosperityHistory, window);
  return d == null ? false : d < delta;
}

// 繁荣度是否「增速不足」：trailing window tick 内 Δ 低于 growthDelta（但未必为 0）。
// 针对缓慢爬升型新手——他们的 Δ 恒 ≥1.0，停滞口径永远抓不到（A4 报告 §3.1）。
// 注意：本口径**比停滞更宽**（growthDelta > stagnationDelta），两者是 OR 关系，不可互相替代。
export function isSlowGrowth(prosperityHistory, opts = {}) {
  const window = opts.window ?? UI_HINTS.growthWindow;
  const delta = opts.delta ?? UI_HINTS.growthDelta;
  const d = windowDelta(prosperityHistory, window);
  return d == null ? false : d < delta;
}

// ---------- 各提示触发条件（纯谓词） ----------

// T1 商业缺失：Lv2 及以上 + 无食肆 + （停滞 OR 增速不足）
// 双口径是 A4 修订的核心：停滞抓「完全不动」（P5 型），增速不足抓「在动但没用」（P4 型）。
function t1Condition(state, history) {
  if (state.level < 2) return false;
  if (eateryCount(state) > 0) return false;
  return isStagnant(history) || isSlowGrowth(history);
}

// T2 空屋过度：Lv2 及以上 + 空置容量超阈值 + 繁荣度停滞
// ⚠ 刻意只保留停滞口径：T2 没有「无食肆」这道护城河，套用增速口径会在正常建房期误弹。
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
      // A4 修订 a：补「恒计分 vs 运转计分」区分——回应 P5 原话「没有粮，也能提升繁荣度，不懂机制」。
      // 迭代方向是「区分」而非「因果」：因果句（运转才计分）原已在文案中（A4 报告 §5）。
      return '食肆已解锁。繁荣度分两类：农田/林场/粮仓「建好就计分」（封顶 26），食肆要「运转」才计分——所以没粮也涨分，但很快就卡住。食从哪来？农田 → 磨坊。';
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
