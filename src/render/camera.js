// 相机：平移、缩放（鼠标锚点）、世界/屏幕坐标互转
import { RULES } from '../config/rules.js';

export const TILE = 32; // zoom=1 时每格像素

export function createCamera() {
  return { x: 0, y: 0, zoom: 1 };
}

export function screenToWorld(cam, sx, sy) {
  return {
    x: (sx - cam.x) / (TILE * cam.zoom),
    y: (sy - cam.y) / (TILE * cam.zoom),
  };
}

export function worldToScreen(cam, wx, wy) {
  return {
    x: wx * TILE * cam.zoom + cam.x,
    y: wy * TILE * cam.zoom + cam.y,
  };
}

// 滚轮缩放（以鼠标为锚点）+ 左键拖拽平移
export function attachCameraControls(canvas, cam) {
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const before = screenToWorld(cam, sx, sy);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    cam.zoom = Math.min(RULES.camera.maxZoom, Math.max(RULES.camera.minZoom, cam.zoom * factor));
    // 锚点不动：重算偏移
    cam.x = sx - before.x * TILE * cam.zoom;
    cam.y = sy - before.y * TILE * cam.zoom;
  }, { passive: false });

  let dragging = false;
  let moved = 0;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = 0;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    cam.x += dx;
    cam.y += dy;
    lastX = e.clientX;
    lastY = e.clientY;
  });
  canvas.addEventListener('pointerup', () => {
    dragging = false;
  });

  // 供 main.js 区分"点击"与"拖拽"
  return {
    isClick: () => moved < 5,
    resetClick: () => { moved = 0; },
  };
}
