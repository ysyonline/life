// 选中建筑详情面板：名称、类型、运转状态（正常/缺料/缺人）、投入产出、拆除
// 拆除返还 50% 造价，数值与 core/grid.js 同源（RULES.demolishRefundRate）
import { BUILDINGS } from '../config/buildings.js';
import { RESOURCES } from '../config/resources.js';
import { RULES } from '../config/rules.js';

const STATUS = {
  material: { text: '缺料·停产', cls: 'warn-material' },
  labor: { text: '缺人·停产', cls: 'warn-labor' },
};

function resName(res) {
  return res === 'money' ? '铜钱' : (RESOURCES[res]?.name ?? res);
}

export function createInfoPanel(root, { onDemolish, onClose }) {
  const el = document.createElement('div');
  el.id = 'info-panel';
  root.appendChild(el);

  // 事件委托：innerHTML 每次 update 重建，监听器挂在容器上
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.act === 'demolish') onDemolish(Number(btn.dataset.id));
    else if (btn.dataset.act === 'close') onClose();
  });

  function update(state) {
    const b = state.buildings.find((x) => x.id === state.ui.selectedBuildingId);
    if (!b) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';

    const def = BUILDINGS[b.type];
    const st = b.idle ? STATUS[b.idleReason] : { text: '运转正常', cls: 'ok' };

    const io = [
      ...Object.entries(def.inputs).map(([res, n]) => `耗 ${resName(res)} ${n}`),
      ...Object.entries(def.outputs).map(([res, n]) => `产 ${resName(res)} ${n}`),
    ];

    const refundMoney = Math.floor(def.cost.money * RULES.demolishRefundRate);
    const refundWood = Math.floor(def.cost.wood * RULES.demolishRefundRate);
    const extra = def.capacity > 0 ? `｜容纳 ${def.capacity} 户` : '';
    const terrainTip = def.terrain
      ? `｜地形 ${def.terrain === 'fertile' ? '沃土' : '林地'}`
      : '';

    el.innerHTML = `
      <h3>${def.name}</h3>
      <div>类型 ${def.category}｜占地 ${def.size[0]}×${def.size[1]}${terrainTip}</div>
      <div>状态 <span class="${st.cls}">${st.text}</span></div>
      <div>${io.length ? io.join('｜') : '无投入产出（被动建筑）'}</div>
      <div>劳力 ${def.workers}${extra}</div>
      <div>坐标 (${b.anchorX}, ${b.anchorY})</div>
      <button data-act="demolish" data-id="${b.id}" class="danger">拆除（返还 钱${refundMoney} 木${refundWood}）</button>
      <button data-act="close">关闭</button>
    `;
  }

  return { update };
}
