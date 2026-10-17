// 试玩数据自动采集（playtest-protocol@1.1）：纯逻辑记录器，零 DOM 依赖
// 分层纪律：本模块属 core/，不碰 DOM/Canvas/localStorage；持久化由 ui/main 层的适配器完成。
// 采集数据存模块内独立对象，不进 state —— 避免污染存档序列化（save.js serialize 只取 state 白名单字段，
// 但独立存放更保险，也让「重开新局」时 reset 语义清晰）。
// 设计原则：只读观察者 —— 只读 state，绝不写 state；不改动任何模拟行为。
import { BUILDINGS } from '../config/buildings.js';
import {
  housingCapacity as housingCapacityOf,
  laborDemand as laborDemandOf,
  taxIncome as taxIncomeOf,
  commerceIncome as commerceIncomeOf,
} from './simulation.js';

// 里程碑阈值（与 rules.unlockThresholds 同源，但固定语义：Lv2=20 / Lv3=50 / Lv4=100）
const MILESTONE_THRESHOLDS = { lv2: 20, lv3: 50, lv4: 100 };
// 采样间隔（tick）：与自动存档同节奏，30 tick 一条快照
const SAMPLE_INTERVAL = 30;

// ---------- 模块内数据（reset() 清空） ----------
const data = {
  milestones: { lv2: null, lv3: null, lv4: null },
  chainBreaks: [], // { tick, buildingType, kind } —— 每建筑实例只记首次 idle
  samples: [], // { tick, money, wood, grain, food, goods, households, housingCapacity, laborDemand, prosperity, level, buildingCount, buildingBreakdown }
  finalSnapshot: null, // Lv4 到达瞬间全量快照（同 samples 字段 + taxIncome / commerceIncome）
  speedChanges: [], // { tick, to }
};

// 已记录过首次 idle 的建筑实例 id 集合（保证「同一建筑只记第一次」）
const recordedBreakIds = new Set();

function initMilestones() {
  data.milestones = { lv2: null, lv3: null, lv4: null };
}

// ---------- 采集 API（main.js afterTick 每 tick 调用一次） ----------
// 记录里程碑：繁荣度首次 ≥20 / ≥50 / ≥100 的精确 tick。
// 幂等：已记录的里程碑不覆盖（首次性）。
function recordMilestones(state) {
  const p = state.prosperity;
  for (const [key, th] of Object.entries(MILESTONE_THRESHOLDS)) {
    if (data.milestones[key] == null && p >= th) data.milestones[key] = state.tick;
  }
}

// 记录断链：每个建筑实例首次 idle 的 { tick, buildingType, kind }。
// 读 b.idle / b.idleReason（由 core/simulation.js 每 tick 维护），只观察不修改。
// 字段名对齐 playtest-protocol@1.1 §4.2：buildingType（建筑类型 id）。
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

// 采样：每 SAMPLE_INTERVAL tick 一条快照（tick 为 SAMPLE_INTERVAL 整数倍时记录）
function recordSample(state, derived) {
  if (state.tick % SAMPLE_INTERVAL !== 0) return;
  data.samples.push(
    snapshotOf(state, {
      housingCapacity: derived?.housingCapacity ?? housingCapacityOf(state),
      laborDemand: derived?.laborDemand ?? laborDemandOf(state),
    })
  );
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
// 字段名对齐 playtest-protocol@1.1 §4.2：to（目标档位）
function recordSpeedChange(to, tick) {
  data.speedChanges.push({ tick: tick ?? null, to });
}

// ---------- 统一入口：main.js afterTick 每 tick 调用 ----------
// derived 可选：{ housingCapacity, laborDemand }（main.js 可复用 HUD 已算的值；缺省时本模块自算）
function collect(state, derived) {
  recordMilestones(state);
  recordChainBreaks(state);
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
    samples: data.samples.map((s) => ({ ...s, buildingBreakdown: { ...s.buildingBreakdown } })),
    finalSnapshot: data.finalSnapshot
      ? { ...data.finalSnapshot, buildingBreakdown: { ...data.finalSnapshot.buildingBreakdown } }
      : null,
    speedChanges: data.speedChanges.map((c) => ({ ...c })),
    usedFastForward: usedFastForwardOf(),
  };
}

// ---------- 重置（新局时清空） ----------
export function reset() {
  initMilestones();
  data.chainBreaks = [];
  data.samples = [];
  data.finalSnapshot = null;
  data.speedChanges = [];
  recordedBreakIds.clear();
}

// ---------- 持久化（供 ui/main 层的 localStorage 适配器使用；本模块不碰 storage） ----------
// 序列化内部全量状态（含 recordedBreakIds，恢复后「首次性」语义不丢）
export function serialize() {
  return {
    milestones: { ...data.milestones },
    chainBreaks: data.chainBreaks.map((c) => ({ ...c })),
    samples: data.samples.map((s) => ({ ...s })),
    finalSnapshot: data.finalSnapshot ? { ...data.finalSnapshot } : null,
    speedChanges: data.speedChanges.map((c) => ({ ...c })),
    recordedBreakIds: [...recordedBreakIds],
  };
}

// 从持久化数据恢复（中途刷新后继续采集）。数据非法时返回 false 并保持现状（不半恢复）。
export function restore(saved) {
  if (!saved || typeof saved !== 'object') return false;
  const { milestones, chainBreaks, samples, finalSnapshot, speedChanges, recordedBreakIds: savedIds } = saved;
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
  data.milestones = {
    lv2: milestones.lv2,
    lv3: milestones.lv3,
    lv4: milestones.lv4,
  };
  data.chainBreaks = chainBreaks.map((c) => ({ tick: c.tick, buildingType: c.buildingType, kind: c.kind }));
  data.samples = samples.map((s) => ({ ...s }));
  data.finalSnapshot = finalSnapshot ? { ...finalSnapshot } : null;
  data.speedChanges = speedChanges.map((c) => ({ ...c }));
  recordedBreakIds.clear();
  for (const id of savedIds) recordedBreakIds.add(id);
  return true;
}

// ---------- 导出 JSON 契约（playtest-protocol@1.1 §4.2：扁平结构，无 session 包装层） ----------
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
    protocol: 'playtest-protocol@1.1',
    gameBuild,
    gameBuildDirty: gameBuildDirty === true,
    exportedAt,
    playerProfile,
    paceVerdict,
    notes,
    milestones: d.milestones,
    chainBreaks: d.chainBreaks,
    samples: d.samples,
    finalSnapshot: d.finalSnapshot,
    speedChanges: d.speedChanges,
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

export { collect, recordSpeedChange, SAMPLE_INTERVAL };
