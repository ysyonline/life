// 试玩数据自动采集（playtest-protocol@1.3）：纯逻辑记录器，零 DOM 依赖
// 分层纪律：本模块属 core/，不碰 DOM/Canvas/localStorage；持久化由 ui/main 层的适配器完成。
// 采集数据存模块内独立对象，不进 state —— 避免污染存档序列化（save.js serialize 只取 state 白名单字段，
// 但独立存放更保险，也让「重开新局」时 reset 语义清晰）。
// 设计原则：只读观察者 —— 只读 state，绝不写 state；不改动任何模拟行为。
import { BUILDINGS } from '../config/buildings.js';
import { RULES } from '../config/rules.js';
import {
  housingCapacity as housingCapacityOf,
  laborDemand as laborDemandOf,
  taxIncome as taxIncomeOf,
  commerceIncome as commerceIncomeOf,
} from './simulation.js';

// 里程碑阈值：从 RULES.unlockThresholds 派生（单一真源）。
// 调阈值时遥测口径自动跟随，杜绝「同源不同步」——此前硬编码 {20,50,100}，
// 若阈值改动而此处不跟，M2/M3 打点会静默错位（见 docs/tech/02-p1-implementation-impact.md §6）。
const MILESTONE_THRESHOLDS = {
  lv2: RULES.unlockThresholds[1],
  lv3: RULES.unlockThresholds[2],
  lv4: RULES.unlockThresholds[3],
};
// 采样间隔（tick）：与自动存档同节奏，30 tick 一条快照
const SAMPLE_INTERVAL = 30;

// ---------- 模块内数据（reset() 清空） ----------
const data = {
  milestones: { lv2: null, lv3: null, lv4: null },
  chainBreaks: [], // { tick, buildingType, kind } —— 每建筑实例只记首次 idle
  scarcity: { materialTicks: [], laborTicks: [] }, // D-N2-4：逐帧稀缺标记（出现该稀缺的 tick 号；空转帧 = 两数组并集之外的 tick）
  samples: [], // { tick, money, wood, grain, food, goods, households, housingCapacity, laborDemand, prosperity, level, buildingCount, buildingBreakdown }
  finalSnapshot: null, // Lv4 到达瞬间全量快照（同 samples 字段 + taxIncome / commerceIncome）
  speedChanges: [], // { tick, to }
  hints: [], // UX-3：提示事件 { tick, id, action: shown/dismissed/resolved }（additive 超集字段，先例：samples）
};

// 已记录过首次 idle 的建筑实例 id 集合（保证「同一建筑只记第一次」）
const recordedBreakIds = new Set();

// 当前采样窗口（30 tick）内的稀缺帧计数：随 sample 落盘后清零。瞬态不入 serialize（恢复后从 0 重计，窗口可能短于 30，可接受）
let windowScarcityMaterial = 0;
let windowScarcityLabor = 0;

function initMilestones() {
  data.milestones = { lv2: null, lv3: null, lv4: null };
}

// ---------- 采集 API（main.js afterTick 每 tick 调用一次） ----------
// 记录里程碑：繁荣度首次 ≥ unlockThresholds[1..3]（现 20/60/145，O6′）的精确 tick。
// 幂等：已记录的里程碑不覆盖（首次性）。
function recordMilestones(state) {
  const p = state.prosperity;
  for (const [key, th] of Object.entries(MILESTONE_THRESHOLDS)) {
    if (data.milestones[key] == null && p >= th) data.milestones[key] = state.tick;
  }
}

// 记录断链：每个建筑实例首次 idle 的 { tick, buildingType, kind }。
// 读 b.idle / b.idleReason（由 core/simulation.js 每 tick 维护），只观察不修改。
// 字段名对齐 playtest-protocol@1.3 §4.2：buildingType（建筑类型 id）。
function recordChainBreaks(state) {
  for (const b of state.buildings) {
    if (b.idle && !recordedBreakIds.has(b.id)) {
      recordedBreakIds.add(b.id);
      data.chainBreaks.push({
        tick: state.tick,
        buildingType: b.type,
        kind: b.idleReason === 'material' ? 'material' : 'labor',
      });
    }
  }
}

// D-N2-4 逐帧稀缺标记：本 tick 是否存在缺料/缺人建筑（读 b.idle/idleReason，只观察不修改）
function recordScarcity(state) {
  let mat = false;
  let lab = false;
  for (const b of state.buildings) {
    if (!b.idle) continue;
    if (b.idleReason === 'material') mat = true;
    else if (b.idleReason === 'labor') lab = true;
    if (mat && lab) break;
  }
  if (mat) { data.scarcity.materialTicks.push(state.tick); windowScarcityMaterial += 1; }
  if (lab) { data.scarcity.laborTicks.push(state.tick); windowScarcityLabor += 1; }
}

// 采样：每 SAMPLE_INTERVAL tick 一条快照（tick 为 SAMPLE_INTERVAL 整数倍时记录）
function recordSample(state, derived) {
  if (state.tick % SAMPLE_INTERVAL !== 0) return;
  data.samples.push(
    snapshotOf(state, {
      housingCapacity: derived?.housingCapacity ?? housingCapacityOf(state),
      laborDemand: derived?.laborDemand ?? laborDemandOf(state),
    })
  );
  windowScarcityMaterial = 0;
  windowScarcityLabor = 0;
}

function snapshotOf(state, derived) {
  return {
    tick: state.tick,
    money: state.money,
    wood: state.resources.wood,
    grain: state.resources.grain,
    food: state.resources.food,
    goods: state.resources.goods,
    households: state.population.count,
    housingCapacity: derived.housingCapacity,
    laborDemand: derived.laborDemand,
    prosperity: state.prosperity,
    level: state.level,
    buildingCount: state.buildings.length,
    // 各类型建筑计数（协议 v1.1 预留字段；samples 也带上，分析侧可看建筑结构演变）
    buildingBreakdown: buildingBreakdownOf(state),
    scarcityMaterial: windowScarcityMaterial, // 本采样窗口（30 tick）缺料帧数（D-N2-4）
    scarcityLabor: windowScarcityLabor, // 本采样窗口缺人帧数
  };
}

// 各类型建筑计数：{ mill: 2, hut: 5, ... }
function buildingBreakdownOf(state) {
  const bd = {};
  for (const b of state.buildings) bd[b.type] = (bd[b.type] ?? 0) + 1;
  return bd;
}

// 终局快照：Lv4 到达瞬间（milestones.lv4 首次被记录的那个 tick）调用一次。
// 含 taxIncome / commerceIncome（core/simulation.js 已导出，本模块直接调用）。
function recordFinalSnapshot(state) {
  data.finalSnapshot = {
    ...snapshotOf(state, {
      housingCapacity: housingCapacityOf(state),
      laborDemand: laborDemandOf(state),
    }),
    taxIncome: taxIncomeOf(state),
    commerceIncome: commerceIncomeOf(state),
  };
}

// ---------- 变速事件（speed 是 main.js 局部变量，由 onSpeed 回调处调用） ----------
// 字段名对齐 playtest-protocol@1.3 §4.2：to（目标档位）
function recordSpeedChange(to, tick) {
  data.speedChanges.push({ tick: tick ?? null, to });
}

// ---------- UX-3 提示事件（由装配层在提示 shown / dismissed / resolved 时调用） ----------
// action：shown（首次展示）/ dismissed（玩家手动 ✕ 关闭）/ resolved（条件消失自动消解）。
function recordHint(id, action, tick) {
  data.hints.push({ tick: tick ?? null, id, action });
}

// ---------- 统一入口：main.js afterTick 每 tick 调用 ----------
// derived 可选：{ housingCapacity, laborDemand }（main.js 可复用 HUD 已算的值；缺省时本模块自算）
function collect(state, derived) {
  recordMilestones(state);
  recordChainBreaks(state);
  recordScarcity(state);
  recordSample(state, derived);
  // Lv4 首达瞬间记终局快照（只记一次）
  if (data.milestones.lv4 === state.tick && data.finalSnapshot == null) {
    recordFinalSnapshot(state);
  }
}

// usedFastForward：本局是否用过 2×（由 speedChanges 派生）
function usedFastForwardOf() {
  return data.speedChanges.some((c) => c.to >= 2);
}

// ---------- 导出数据 ----------
// 返回采集数据的深拷贝（防止外部误改模块内部状态）
export function getTelemetryData() {
  return {
    milestones: { ...data.milestones },
    chainBreaks: data.chainBreaks.map((c) => ({ ...c })),
    scarcity: { materialTicks: [...data.scarcity.materialTicks], laborTicks: [...data.scarcity.laborTicks] },
    samples: data.samples.map((s) => ({ ...s, buildingBreakdown: { ...s.buildingBreakdown } })),
    finalSnapshot: data.finalSnapshot
      ? { ...data.finalSnapshot, buildingBreakdown: { ...data.finalSnapshot.buildingBreakdown } }
      : null,
    speedChanges: data.speedChanges.map((c) => ({ ...c })),
    hints: data.hints.map((h) => ({ ...h })),
    usedFastForward: usedFastForwardOf(),
  };
}

// ---------- 重置（新局时清空） ----------
export function reset() {
  initMilestones();
  data.chainBreaks = [];
  data.scarcity = { materialTicks: [], laborTicks: [] };
  windowScarcityMaterial = 0;
  windowScarcityLabor = 0;
  data.samples = [];
  data.finalSnapshot = null;
  data.speedChanges = [];
  data.hints = [];
  recordedBreakIds.clear();
}

// ---------- 持久化（供 ui/main 层的 localStorage 适配器使用；本模块不碰 storage） ----------
// 序列化内部全量状态（含 recordedBreakIds，恢复后「首次性」语义不丢）
export function serialize() {
  return {
    milestones: { ...data.milestones },
    chainBreaks: data.chainBreaks.map((c) => ({ ...c })),
    scarcity: { materialTicks: [...data.scarcity.materialTicks], laborTicks: [...data.scarcity.laborTicks] },
    samples: data.samples.map((s) => ({ ...s })),
    finalSnapshot: data.finalSnapshot ? { ...data.finalSnapshot } : null,
    speedChanges: data.speedChanges.map((c) => ({ ...c })),
    hints: data.hints.map((h) => ({ ...h })),
    recordedBreakIds: [...recordedBreakIds],
  };
}

// 从持久化数据恢复（中途刷新后继续采集）。数据非法时返回 false 并保持现状（不半恢复）。
export function restore(saved) {
  if (!saved || typeof saved !== 'object') return false;
  const { milestones, chainBreaks, scarcity, samples, finalSnapshot, speedChanges, hints, recordedBreakIds: savedIds } = saved;
  if (
    !milestones ||
    typeof milestones.lv2 !== 'number' && milestones.lv2 !== null ||
    typeof milestones.lv3 !== 'number' && milestones.lv3 !== null ||
    typeof milestones.lv4 !== 'number' && milestones.lv4 !== null ||
    !Array.isArray(chainBreaks) ||
    !Array.isArray(samples) ||
    !Array.isArray(speedChanges) ||
    !Array.isArray(savedIds)
  ) {
    return false;
  }
  // D-N2-4 scarcity：容忍缺失（旧档 v1.1/v1.2 无此字段，缺省为空数组，保证 localStorage 旧遥测可恢复）；
  // 存在则必须 { materialTicks: 数组, laborTicks: 数组 }，否则视为非法数据拒绝恢复。
  if (scarcity != null) {
    if (
      typeof scarcity !== 'object' ||
      !Array.isArray(scarcity.materialTicks) ||
      !Array.isArray(scarcity.laborTicks)
    ) {
      return false;
    }
  }
  data.milestones = {
    lv2: milestones.lv2,
    lv3: milestones.lv3,
    lv4: milestones.lv4,
  };
  data.chainBreaks = chainBreaks.map((c) => ({ tick: c.tick, buildingType: c.buildingType, kind: c.kind }));
  data.scarcity = {
    materialTicks: scarcity ? [...scarcity.materialTicks] : [],
    laborTicks: scarcity ? [...scarcity.laborTicks] : [],
  };
  windowScarcityMaterial = 0;
  windowScarcityLabor = 0;
  data.samples = samples.map((s) => ({ ...s }));
  data.finalSnapshot = finalSnapshot ? { ...finalSnapshot } : null;
  data.speedChanges = speedChanges.map((c) => ({ ...c }));
  data.hints = Array.isArray(hints) ? hints.map((h) => ({ ...h })) : [];
  recordedBreakIds.clear();
  for (const id of savedIds) recordedBreakIds.add(id);
  return true;
}

// ---------- 导出 JSON 契约（playtest-protocol@1.3 §4.2：扁平结构，无 session 包装层） ----------
// playerProfile / paceVerdict / notes 由 UI 面板收集（主观项），exportedAt 由调用方传入 ISO 串（导出时刻）。
// gameBuildDirty：构建时工作区是否有未提交改动（true = 该 build 号不对应任何干净 commit，
// 分析期应降级为「不可精确定位」）。由 ui/main 层传入（构建期常量，core 不读环境变量）。
export function buildExportPayload({
  gameBuild,
  gameBuildDirty = false,
  exportedAt,
  playerProfile = null,
  paceVerdict = null,
  notes = '',
}) {
  const d = getTelemetryData();
  return {
    protocol: 'playtest-protocol@1.3',
    gameBuild,
    gameBuildDirty: gameBuildDirty === true,
    exportedAt,
    playerProfile,
    paceVerdict,
    notes,
    milestones: d.milestones,
    chainBreaks: d.chainBreaks,
    scarcity: d.scarcity,
    samples: d.samples,
    finalSnapshot: d.finalSnapshot,
    speedChanges: d.speedChanges,
    hints: d.hints,
    usedFastForward: d.usedFastForward,
  };
}

// 供测试与面板摘要使用：里程碑 tick → 分钟（1× 等效，tick/60）
export function tickToMinutes(tick) {
  return tick == null ? null : Math.round((tick / 60) * 10) / 10;
}

// 面板摘要：Lv2/Lv3/Lv4 到达 tick 与换算分钟、终局户数/建筑数
export function buildSummary() {
  const d = getTelemetryData();
  return {
    milestones: {
      lv2: { tick: d.milestones.lv2, minutes: tickToMinutes(d.milestones.lv2) },
      lv3: { tick: d.milestones.lv3, minutes: tickToMinutes(d.milestones.lv3) },
      lv4: { tick: d.milestones.lv4, minutes: tickToMinutes(d.milestones.lv4) },
    },
    finalHouseholds: d.finalSnapshot?.households ?? null,
    finalBuildingCount: d.finalSnapshot?.buildingCount ?? null,
    chainBreakCount: d.chainBreaks.length,
    usedFastForward: d.usedFastForward,
  };
}

// 建筑类型 → 中文名（面板展示用；BUILDINGS 来自 config，core 内引用 config 合法）
export function buildingName(type) {
  return BUILDINGS[type]?.name ?? type;
}

export { collect, recordSpeedChange, recordHint, SAMPLE_INTERVAL };
