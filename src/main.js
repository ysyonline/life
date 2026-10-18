// 入口：初始化 state、加载存档、启动渲染循环（rAF）与固定步长 tick 累加器、挂载 UI
// 分层纪律：本文件只做装配，state 变更一律通过 core/ 的意图函数
import './style.css';
import { RULES } from './config/rules.js';
import { BUILDINGS } from './config/buildings.js';
import { createInitialState } from './core/state.js';
import { tick } from './core/simulation.js';
import { placeBuilding, demolishBuilding, buildingAt, canAfford } from './core/grid.js';
import { hasSave, loadGame, saveGame, clearSave } from './core/save.js';
import {
  collect as collectTelemetry,
  recordSpeedChange,
  recordHint,
  reset as resetTelemetry,
  serialize as serializeTelemetry,
  restore as restoreTelemetry,
} from './core/telemetry.js';
import { createCamera, attachCameraControls, screenToWorld, TILE } from './render/camera.js';
import { render } from './render/renderer.js';
import { createHud } from './ui/hud.js';
import { createBuildMenu } from './ui/buildMenu.js';
import { createInfoPanel } from './ui/infoPanel.js';
import { createTelemetryPanel } from './ui/telemetryPanel.js';
import { createHintBar } from './ui/hintBar.js';
import { evaluateHints, HINT_ORDER, pushProsperity } from './core/hints.js';

// 构建标识：试玩数据导出契约的 gameBuild 字段。
// 由 vite.config.js 在构建期用 git（rev-parse + status --porcelain）注入，dev 与 build 均生效。
// 降级链：define 常量 __GAME_BUILD__ → import.meta.env.VITE_GAME_BUILD → 'unknown'。
// 兜底值刻意用 'unknown' 而非任何看起来像 commit 的字符串：假的真值比明显的错误值更危险
// （B3 教训：硬编码 '3338e97' 让四局遥测版本号完全相同，无法区分玩家跑的是不是新代码）。
// typeof 保护：define 未生效时也不会抛 ReferenceError，游戏照常启动。
const GAME_BUILD =
  (typeof __GAME_BUILD__ === 'string' && __GAME_BUILD__) ||
  import.meta.env?.VITE_GAME_BUILD ||
  'unknown';
// dirty = 构建时工作区有未提交改动（改动尚未进 commit，导出的版本号不对应任何干净 commit）。
// 独立布尔字段供分析脚本机读，避免去解析 gameBuild 字符串后缀。
const GAME_BUILD_DIRTY =
  typeof __GAME_BUILD_DIRTY__ === 'boolean'
    ? __GAME_BUILD_DIRTY__
    : /-dirty$/.test(GAME_BUILD);

// telemetry 防丢失加固：独立 key，不与存档混用；「重开新局」时一并清除
const TELEMETRY_KEY = 'songtown-telemetry-v1';

function telemetryStorageAvailable() {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function persistTelemetry() {
  if (!telemetryStorageAvailable()) return;
  try {
    localStorage.setItem(TELEMETRY_KEY, JSON.stringify(serializeTelemetry()));
  } catch {
    // 隐私模式/配额满：静默降级（内存数据仍在，导出面板照常工作）
  }
}

// 中途刷新后恢复采集（与存档续玩配套）。数据损坏/缺失时返回 false → 调用方按新局处理。
function loadPersistedTelemetry() {
  if (!telemetryStorageAvailable()) return false;
  try {
    const raw = localStorage.getItem(TELEMETRY_KEY);
    if (!raw) return false;
    return restoreTelemetry(JSON.parse(raw));
  } catch {
    return false;
  }
}

function clearPersistedTelemetry() {
  if (!telemetryStorageAvailable()) return;
  try {
    localStorage.removeItem(TELEMETRY_KEY);
  } catch {
    // 同上，静默
  }
}

const canvas = document.getElementById('game');
const uiRoot = document.getElementById('ui');
const toast = document.getElementById('toast');
const ctx = canvas.getContext('2d');

// ---------- 画布尺寸：逻辑尺寸给渲染用，物理尺寸按 dpr 放大 ----------
const view = { width: 0, height: 0 };
function resize() {
  const dpr = window.devicePixelRatio || 1;
  view.width = window.innerWidth;
  view.height = window.innerHeight;
  canvas.width = Math.floor(view.width * dpr);
  canvas.height = Math.floor(view.height * dpr);
  canvas.style.width = `${view.width}px`;
  canvas.style.height = `${view.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// ---------- state ----------
// telemetry 与存档同生命周期：载入存档续玩 → 恢复采集；开新局 → 清空采集
function initState() {
  if (hasSave() && window.confirm('检测到存档，继续上次进度？\n（取消则开新局）')) {
    const loaded = loadGame(createInitialState);
    if (loaded) {
      if (!loadPersistedTelemetry()) resetTelemetry(); // 存档在而采集数据缺失/损坏：从现在开始采
      return loaded;
    }
    // 版本不符或损坏：静默开新局
  }
  resetTelemetry();
  clearPersistedTelemetry();
  return createInitialState();
}
const state = initState();

// ---------- 相机 ----------
const cam = createCamera();
const camCtl = attachCameraControls(canvas, cam);
// 开局把地图居中
cam.x = (view.width - RULES.mapSize * TILE * cam.zoom) / 2;
cam.y = (view.height - RULES.mapSize * TILE * cam.zoom) / 2;

// ---------- UI ----------
let uiDirty = true;
function markDirty() {
  uiDirty = true;
}

let toastTimer = 0;
function showToast(msg, { grand = false } = {}) {
  toast.textContent = msg;
  toast.classList.toggle('grand', grand); // UX-2：Lv4 通关 toast 强化样式
  toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.style.display = 'none';
    toast.classList.remove('grand');
  }, grand ? 4000 : 2000);
}

// 建造失败原因 → 中文提示。core 返回结构化 reason（便于程序判定），本地化在展示层做
function buildFailMessage(r) {
  switch (r.reason) {
    case 'locked':
      return `需 Lv${r.needLevel} 解锁`;
    case '超出边界':
      return '超出地图边界';
    case '格子被占用':
      return '此处已有建筑';
    case '需建在沃土上':
      return '农田/沃土类建筑只能建在沃土上';
    case '需建在林地上':
      return '林场只能建在林地上';
    case '铜钱或木材不足':
      return '铜钱或木材不足';
    default:
      return '无法建造'; // 未知建筑等兜底，绝不把英文 reason 直接吐给用户
  }
}

const hud = createHud(uiRoot, {
  onSpeed: (s) => {
    recordSpeedChange(s, state.tick); // 采集：变速事件（tick 为当前游戏内时间）
    speed = s;
    acc = 0; // 变速时丢弃残余，避免暂停后补帧暴冲
  },
  onSave: () => {
    showToast(saveGame(state) ? '已保存' : '当前环境不支持存档');
  },
  onRestart: () => {
    // 重开新局：清存档 + 清采集数据（含 localStorage 加固副本）+ 刷新页面
    if (!window.confirm('确定重开新局？当前进度与试玩采集数据将被清除。')) return;
    clearSave();
    resetTelemetry();
    clearPersistedTelemetry();
    window.location.reload();
  },
  onTelemetry: () => {
    // 关闭后可从 HUD「试玩数据」按钮重开；面板数据每次 show 时从记录器实时取
    telemetryPanel.show();
  },
});

const telemetryPanel = createTelemetryPanel(uiRoot, {
  gameBuild: GAME_BUILD,
  gameBuildDirty: GAME_BUILD_DIRTY,
});

// UX-3：繁荣度环形缓冲（评估停滞窗口）+ 提示一次性/消解状态（存内存，不进存档，07 草案 R4）
const prosperityHistory = [];
const hintConsumed = new Set(); // 已展示（shown）过的提示 id，本局不再复发
let activeHintId = null; // 当前正在展示的提示 id（条件持续满足时不重复 shown）

// UX-3 提示条：HUD 下方非模态横幅。
const hintBar = createHintBar(uiRoot, {
  onDismiss: (id) => {
    activeHintId = null; // 玩家手动关闭：不随后记录「resolved」
    recordHint(id, 'dismissed', state.tick);
  },
});

const buildMenu = createBuildMenu(uiRoot, {
  onSelect: (type) => {
    state.ui.placingType = state.ui.placingType === type ? null : type;
    state.ui.selectedBuildingId = null;
    // UX-2：玩家选中高亮建筑即视为已注意到，撤掉高亮
    if (state.ui.highlightType === type) state.ui.highlightType = null;
    markDirty();
  },
});

const infoPanel = createInfoPanel(uiRoot, {
  onDemolish: (id) => {
    const b = state.buildings.find((x) => x.id === id);
    const r = demolishBuilding(state, id);
    if (r.ok && b) showToast(`已拆除 ${BUILDINGS[b.type].name}`);
    markDirty();
  },
  onClose: () => {
    state.ui.selectedBuildingId = null;
    markDirty();
  },
});

// ---------- 输入 ----------
function cellFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const w = screenToWorld(cam, e.clientX - rect.left, e.clientY - rect.top);
  return { x: Math.floor(w.x), y: Math.floor(w.y) };
}

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < RULES.mapSize && y < RULES.mapSize;
}

canvas.addEventListener('pointermove', (e) => {
  const { x, y } = cellFromEvent(e);
  state.ui.hoverCell = inBounds(x, y) ? { x, y } : null;
});
canvas.addEventListener('pointerleave', () => {
  state.ui.hoverCell = null;
});

canvas.addEventListener('click', (e) => {
  if (!camCtl.isClick()) return; // 拖拽平移不算点击
  const { x, y } = cellFromEvent(e);
  if (!inBounds(x, y)) return;

  if (state.ui.placingType) {
    const type = state.ui.placingType;
    if (!canAfford(state, type)) {
      showToast('铜钱或木材不足');
      return;
    }
    const r = placeBuilding(state, type, x, y);
    if (!r.ok) {
      showToast(buildFailMessage(r));
      return;
    }
    showToast(`已建造 ${BUILDINGS[type].name}`);
  } else {
    const b = buildingAt(state, x, y);
    state.ui.selectedBuildingId = b ? b.id : null;
  }
  markDirty();
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  state.ui.placingType = null;
  state.ui.selectedBuildingId = null;
  markDirty();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    state.ui.placingType = null;
    state.ui.selectedBuildingId = null;
    markDirty();
  }
});

// ---------- 循环：固定步长累加器 + rAF 渲染 ----------
let speed = 1; // 0 暂停 / 1 / 2
let acc = 0;
let last = performance.now();
// P3 解锁粘性：升级 toast 跟踪 maxLevel（只升不降），瞬时繁荣度回落再回升不重复弹
let prevMaxLevel = state.maxLevel ?? state.level;
let lastAutosaveTick = state.tick;

function afterTick() {
  // 采集：每 tick 只读观察（milestones / chainBreaks / samples / finalSnapshot）
  collectTelemetry(state);

  // UX-3：繁荣度环形缓冲（用于停滞 / 增速不足双口径判定）
  // 裁剪上限由 historyCapacity 统一派生（max(stagnationWindow, growthWindow) + 1），
  // 勿在此硬编码窗口长度——否则新增窗口大于旧窗口时增速判定会静默永不触发。
  pushProsperity(prosperityHistory, state.prosperity);

  // UX-3：驱动提示条
  const active = evaluateHints(state, { prosperityHistory });
  // 当前正在展示的提示若条件已不满足 → 记录消解并隐藏（玩家手动关闭的 dismissed 不在此列）
  if (activeHintId != null && !active.includes(activeHintId)) {
    recordHint(activeHintId, 'resolved', state.tick);
    activeHintId = null;
    hintBar.hide();
  }
  // 取优先级最高的未消费且当前满足条件的提示 → 展示（每局每 id 至多一次）
  const candidate = HINT_ORDER.find((id) => active.includes(id) && !hintConsumed.has(id));
  if (candidate && candidate !== activeHintId) {
    hintConsumed.add(candidate);
    activeHintId = candidate;
    hintBar.show(candidate, state);
    recordHint(candidate, 'shown', state.tick);
  }

  if (state.maxLevel > prevMaxLevel) {
    const names = Object.values(BUILDINGS)
      .filter((d) => d.unlockLevel === state.maxLevel)
      .map((d) => d.name)
      .join('、');
    if (state.maxLevel >= 4) {
      // UX-2：Lv4 达成 toast 强化 + 建造菜单高亮杂货摊
      showToast(`繁华大成——${names}已解锁`, { grand: true });
      state.ui.highlightType = 'grocer';
    } else {
      showToast(`市井渐兴——解锁【${names}】`);
    }
    prevMaxLevel = state.maxLevel;
    // Lv4 通关 toast 时自动弹出试玩数据面板（玩家零负担：数据已自动采好）
    if (state.maxLevel >= 4) telemetryPanel.show();
  }
  if (state.tick - lastAutosaveTick >= RULES.autosaveInterval) {
    lastAutosaveTick = state.tick;
    saveGame(state);
    persistTelemetry(); // 与自动存档同节奏持久化，防中途刷新丢失
  }
  markDirty();
}

// 离开页面前兜底持久化（beforeunload 时同步写，防最后一段未到自动存档间隔的数据丢失）
window.addEventListener('beforeunload', persistTelemetry);

function frame(now) {
  const dt = Math.min(now - last, 250); // 切标签页回来时钳制，避免补帧暴冲
  last = now;

  if (speed > 0) {
    acc += dt * speed;
    while (acc >= RULES.tickMs) {
      acc -= RULES.tickMs;
      tick(state);
      afterTick();
    }
  }

  render(ctx, state, cam, view);

  if (uiDirty) {
    hud.update(state);
    buildMenu.update(state);
    infoPanel.update(state);
    uiDirty = false;
  }

  requestAnimationFrame(frame);
}

hud.update(state);
buildMenu.update(state);
infoPanel.update(state);
uiDirty = false;
requestAnimationFrame(frame);
