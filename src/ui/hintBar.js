// UX-3 提示条（hint bar）组件：HUD 下方非模态横幅。
// 呈现形态（07 草案 §2）：不锁操作、不遮挡画布、不暂停游戏；带 ✕ 可手动关闭；
// 条件消失时自动消失（由装配层按 evaluateHints 结果驱动）；同一提示每局至多一次（装配层维护）。
import { hintText } from '../core/hints.js';

export function createHintBar(root, { onDismiss }) {
  const el = document.createElement('div');
  el.id = 'hint-bar';
  el.style.display = 'none';
  el.innerHTML = `
    <span class="text"></span>
    <button class="dismiss" title="关闭提示">✕</button>
  `;
  root.appendChild(el);

  let currentId = null;

  el.querySelector('.dismiss').addEventListener('click', () => {
    if (currentId != null) onDismiss(currentId);
    hide();
  });

  // 显示某条提示；重复调用同 id 无副作用（幂等）
  function show(id, state) {
    if (id == null) { hide(); return; }
    currentId = id;
    el.querySelector('.text').textContent = hintText(id, state);
    el.style.display = 'block';
  }

  function hide() {
    currentId = null;
    el.style.display = 'none';
  }

  return { show, hide, isVisible: () => el.style.display !== 'none', current: () => currentId };
}
