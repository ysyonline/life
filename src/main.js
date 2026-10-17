// 入口：初始化 state、加载存档、启动渲染循环（rAF）与固定步长 tick 累加器、挂载 UI
// 分层纪律：本文件只做装配，state 变更一律通过 core/ 的意图函数
import './style.css';
import { RULES } from './config/rules.js';
import { BUILDINGS } from './config/buildings.js';
import { createInitialState } from './core/state.js';
import { tick } from './core/simulation.js';
import { placeBuilding, demolishBuilding, buildingAt, canAfford } from './core/grid.js';
import { hasSave, loadGame, saveGame } from './core/save.js';
import { createCamera, attachCameraControls, screenToWorld, TILE } from './render/camera.js';
import { render } from './render/renderer.js';
import { createHud } from './ui/hud.js';
import { createBuildMenu } from './ui/buildMenu.js';
import { createInfoPanel } from './ui/infoPanel.js';

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
function initState() {
  if (hasSave() && window.confirm('检测到存档，继续上次进度？\n（取消则开新局）')) {
    const loaded = loadGame(createInitialState);
    if (loaded) return loaded;
    // 版本不符或损坏：静默开新局
  }
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
function showToast(msg) {
  toast.textContent = msg;
  toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.style.display = 'none';
  }, 2000);
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
    speed = s;
    acc = 0; // 变速时丢弃残余，避免暂停后补帧暴冲
  },
  onSave: () => {
    showToast(saveGame(state) ? '已保存' : '当前环境不支持存档');
  },
});

const buildMenu = createBuildMenu(uiRoot, {
  onSelect: (type) => {
    state.ui.placingType = state.ui.placingType === type ? null : type;
    state.ui.selectedBuildingId = null;
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
let prevLevel = state.level;
let lastAutosaveTick = state.tick;

function afterTick() {
  if (state.level > prevLevel) {
    const names = Object.values(BUILDINGS)
      .filter((d) => d.unlockLevel === state.level)
      .map((d) => d.name)
      .join('、');
    showToast(`市井渐兴——解锁【${names}】`);
    prevLevel = state.level;
  }
  if (state.tick - lastAutosaveTick >= RULES.autosaveInterval) {
    lastAutosaveTick = state.tick;
    saveGame(state);
  }
  markDirty();
}

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
