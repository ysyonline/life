// HUD：资源栏、户数/劳力/食趋势、繁荣度进度条、变速、保存
import { RESOURCES } from '../config/resources.js';
import { BUILDINGS } from '../config/buildings.js';
import { RULES } from '../config/rules.js';
import {
  computeCaps,
  housingCapacity,
  laborDemand,
  taxIncome,
  commerceIncome,
} from '../core/simulation.js';

// 铜钱显示：内部浮点累计，展示一律向下取整（Math.floor），
// 保证「显示 N 钱」时真实余额必 ≥ N，不会出现「显示有钱却买不起」。
export function formatMoney(n) {
  return String(Math.floor(n));
}

// 铜钱栏文案：余额 + 两个收入来源（市税 / 商业），让玩家看清收入结构
export function moneyLabel(state) {
  return `铜钱 ${formatMoney(state.money)}（市税 +${taxIncome(state).toFixed(2)} 商业 +${formatMoney(commerceIncome(state))}）`;
}

export function createHud(root, { onSpeed, onSave, onRestart, onTelemetry }) {
  const el = document.createElement('div');
  el.id = 'hud';
  el.innerHTML = `
    <span class="res" data-r="money"></span>
    <span class="res" data-r="wood"></span>
    <span class="res" data-r="grain"></span>
    <span class="res" data-r="food"></span>
    <span class="res" data-r="goods"></span>
    <span class="res" data-r="pop"></span>
    <div class="prosperity">
      <span data-r="level"></span>
      <div class="barcol">
        <div class="bar"><div data-r="bar"></div></div>
        <div class="hint">断链/闲置建筑不计繁荣度</div>
      </div>
      <span data-r="next"></span>
    </div>
    <button data-speed="0">暂停</button>
    <button data-speed="1" class="active">1×</button>
    <button data-speed="2">2×</button>
    <button data-act="save">保存</button>
    <button data-act="restart" class="danger">重开新局</button>
    <button data-act="telemetry">试玩数据</button>
  `;
  root.appendChild(el);

  el.querySelectorAll('[data-speed]').forEach((btn) => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('[data-speed]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      onSpeed(Number(btn.dataset.speed));
    });
  });
  el.querySelector('[data-act="save"]').addEventListener('click', onSave);
  el.querySelector('[data-act="restart"]').addEventListener('click', onRestart);
  el.querySelector('[data-act="telemetry"]').addEventListener('click', onTelemetry);

  let prevFood = null;

  function update(state) {
    const caps = computeCaps(state);
    const fmt = (n) => Math.floor(n);
    el.querySelector('[data-r="money"]').textContent = moneyLabel(state);
    el.querySelector('[data-r="wood"]').textContent = `木材 ${fmt(state.resources.wood)}`;
    el.querySelector('[data-r="grain"]').textContent = `粮 ${fmt(state.resources.grain)}/${caps.grain}`;
    const food = state.resources.food;
    let arrow = '—';
    if (prevFood != null) arrow = food > prevFood ? '↑' : food < prevFood ? '↓' : '—';
    prevFood = food;
    el.querySelector('[data-r="food"]').textContent = `食 ${fmt(food)}/${caps.food} ${arrow}`;
    el.querySelector('[data-r="goods"]').textContent = `器 ${fmt(state.resources.goods)}`;
    el.querySelector('[data-r="pop"]').textContent =
      `户数 ${state.population.count}/${housingCapacity(state)} 劳力 ${laborDemand(state)}`;

    const p = state.prosperity;
    const level = state.level;
    el.querySelector('[data-r="level"]').textContent = `Lv${level} 繁荣 ${p.toFixed(1)}`;
    const ths = RULES.unlockThresholds;
    if (level < ths.length) {
      const next = ths[level];
      const prev = ths[level - 1];
      const pct = Math.min(100, ((p - prev) / (next - prev)) * 100);
      el.querySelector('[data-r="bar"]').style.width = `${pct}%`;
      const unlocking = Object.values(BUILDINGS)
        .filter((d) => d.unlockLevel === level + 1)
        .map((d) => d.name)
        .join('、');
      el.querySelector('[data-r="next"]').textContent = `下级 ${next} 解锁：${unlocking}`;
    } else {
      el.querySelector('[data-r="bar"]').style.width = '100%';
      el.querySelector('[data-r="next"]').textContent = '已达最高等级';
    }
  }

  return { update };
}
