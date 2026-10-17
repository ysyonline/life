// Canvas 灰盒绘制：地形、网格线、建筑色块+缩写、警示边框、放置预览
import { BUILDINGS } from '../config/buildings.js';
import { RULES } from '../config/rules.js';
import { TILE, screenToWorld } from './camera.js';
import { TERRAIN, cellKey, canPlace, canAfford } from '../core/grid.js';

const TERRAIN_COLORS = {
  [TERRAIN.PLAIN]: '#4a4e57',
  [TERRAIN.FERTILE]: '#5d7a3a',
  [TERRAIN.WOODLAND]: '#2e4d2a',
};

export function render(ctx, state, cam, canvas) {
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#33363d';
  ctx.fillRect(0, 0, width, height);

  const scale = TILE * cam.zoom;
  const size = RULES.mapSize;

  // 只绘制可见范围
  const tl = screenToWorld(cam, 0, 0);
  const br = screenToWorld(cam, width, height);
  const x0 = Math.max(0, Math.floor(tl.x));
  const y0 = Math.max(0, Math.floor(tl.y));
  const x1 = Math.min(size - 1, Math.ceil(br.x));
  const y1 = Math.min(size - 1, Math.ceil(br.y));

  ctx.save();
  ctx.translate(cam.x, cam.y);
  ctx.scale(scale, scale);

  // 地形
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cell = state.grid.get(cellKey(x, y));
      if (!cell) continue;
      ctx.fillStyle = TERRAIN_COLORS[cell.terrain];
      ctx.fillRect(x, y, 1, 1);
    }
  }

  // 网格线
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1 / scale;
  ctx.beginPath();
  for (let x = x0; x <= x1 + 1; x++) {
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1 + 1);
  }
  for (let y = y0; y <= y1 + 1; y++) {
    ctx.moveTo(x0, y);
    ctx.lineTo(x1 + 1, y);
  }
  ctx.stroke();

  // 建筑色块 + 缩写
  for (const b of state.buildings) {
    const def = BUILDINGS[b.type];
    const [w, h] = def.size;
    if (b.anchorX + w < x0 || b.anchorX > x1 || b.anchorY + h < y0 || b.anchorY > y1) continue;

    ctx.fillStyle = def.color;
    ctx.fillRect(b.anchorX + 0.05, b.anchorY + 0.05, w - 0.1, h - 0.1);

    // 断链警示：缺料红框、缺人黄框
    if (b.idle) {
      ctx.strokeStyle = b.idleReason === 'labor' ? '#ffd600' : '#ff1744';
      ctx.lineWidth = 3 / scale;
      ctx.strokeRect(b.anchorX + 0.08, b.anchorY + 0.08, w - 0.16, h - 0.16);
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 1 / scale;
      ctx.strokeRect(b.anchorX + 0.05, b.anchorY + 0.05, w - 0.1, h - 0.1);
    }

    // 选中高亮
    if (state.ui.selectedBuildingId === b.id) {
      ctx.strokeStyle = '#40c4ff';
      ctx.lineWidth = 3 / scale;
      ctx.strokeRect(b.anchorX - 0.04, b.anchorY - 0.04, w + 0.08, h + 0.08);
    }

    ctx.fillStyle = '#fff';
    ctx.font = `${0.45}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.abbr, b.anchorX + w / 2, b.anchorY + h / 2);
  }

  // 放置预览：半透明绿=可放，红=不可放
  const { placingType, hoverCell } = state.ui;
  if (placingType && hoverCell) {
    const def = BUILDINGS[placingType];
    const [w, h] = def.size;
    const ok = canPlace(state, placingType, hoverCell.x, hoverCell.y).ok && canAfford(state, placingType);
    ctx.fillStyle = ok ? 'rgba(76, 175, 80, 0.5)' : 'rgba(244, 67, 54, 0.5)';
    ctx.fillRect(hoverCell.x, hoverCell.y, w, h);
    ctx.fillStyle = '#fff';
    ctx.font = `${0.45}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.abbr, hoverCell.x + w / 2, hoverCell.y + h / 2);
  }

  ctx.restore();
}
