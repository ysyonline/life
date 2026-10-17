// 建造菜单：列出全部建筑，按繁荣度等级解锁；点击进入放置模式
// UI 只读 state，选中意图通过 onSelect 派发给 main.js
import { BUILDINGS } from '../config/buildings.js';
import { canAfford } from '../core/grid.js';

export function createBuildMenu(root, { onSelect }) {
  const el = document.createElement('div');
  el.id = 'build-menu';

  const items = new Map();
  for (const [id, def] of Object.entries(BUILDINGS)) {
    const item = document.createElement('div');
    item.className = 'item';
    item.dataset.type = id;
    item.innerHTML = `
      <div class="swatch" style="background:${def.color}"></div>
      <div class="bname">${def.name}</div>
      <div class="cost">钱${def.cost.money} 木${def.cost.wood}</div>
      <div class="lock"></div>
    `;
    item.addEventListener('click', () => {
      if (item.classList.contains('locked')) return;
      onSelect(id);
    });
    el.appendChild(item);
    items.set(id, item);
  }
  root.appendChild(el);

  function update(state) {
    for (const [id, def] of Object.entries(BUILDINGS)) {
      const item = items.get(id);
      const locked = def.unlockLevel > state.level;
      item.classList.toggle('locked', locked);
      item.classList.toggle('selected', state.ui.placingType === id);
      item.classList.toggle('poor', !locked && !canAfford(state, id));
      item.querySelector('.lock').textContent = locked ? `Lv${def.unlockLevel} 解锁` : '';
      item.title = locked
        ? `${def.name}：繁荣度 Lv${def.unlockLevel} 解锁`
        : `${def.name}（${def.category}）｜占地 ${def.size[0]}×${def.size[1]}｜劳力 ${def.workers}`;
    }
  }

  return { update };
}
