// 试玩数据面板：本局摘要 + 主观评价（画像/节奏/备注）+ 导出 JSON
// 分层纪律：ui/ 只读 state、通过意图函数改 state；本面板不持有游戏状态，
// 采集数据全部来自 core/telemetry.js 的导出函数，主观项（画像/节奏/备注）由面板控件收集。
// 下载（Blob + URL.createObjectURL）属浏览器 API，在 ui 层合法。
import {
  buildExportPayload,
  buildSummary,
  getTelemetryData,
  buildingName,
} from '../core/telemetry.js';

// 文件名：playtest-session-YYYYMMDD-HHMMSS.json
function sessionFileName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `playtest-session-${stamp}.json`;
}

function fmtTick(entry) {
  if (entry.tick == null) return '未到达';
  return `tick ${entry.tick}（约 ${entry.minutes} 分钟）`;
}

export function createTelemetryPanel(root, { gameBuild, gameBuildDirty = false }) {
  const el = document.createElement('div');
  el.id = 'telemetry-panel';
  el.style.display = 'none';
  el.innerHTML = `
    <h3>试玩数据</h3>
    <div class="summary" data-part="summary"></div>
    <div class="field">
      <label>玩家画像（可不选）</label>
      <div class="radios" data-part="profile">
        <label><input type="radio" name="tp-profile" value="skilled" /> 熟练</label>
        <label><input type="radio" name="tp-profile" value="normal" /> 普通</label>
        <label><input type="radio" name="tp-profile" value="novice" /> 新手</label>
      </div>
    </div>
    <div class="field">
      <label>节奏评价（可不选）</label>
      <div class="radios" data-part="pace">
        <label><input type="radio" name="tp-pace" value="too-fast" /> 太快</label>
        <label><input type="radio" name="tp-pace" value="ok" /> 适中</label>
        <label><input type="radio" name="tp-pace" value="too-slow" /> 太慢</label>
      </div>
    </div>
    <div class="field">
      <label>备注（最爽/最无聊的一段、异常等）</label>
      <textarea data-part="notes" rows="3" placeholder="例如：Lv2→Lv3 段等粮最无聊；食肆解锁后节奏明显加快"></textarea>
    </div>
    <div class="actions">
      <button data-act="export" class="primary">导出 JSON</button>
      <button data-act="close">关闭</button>
    </div>
  `;
  root.appendChild(el);

  function radioValue(name) {
    const checked = el.querySelector(`input[name="${name}"]:checked`);
    return checked ? checked.value : null;
  }

  function renderSummary() {
    const s = buildSummary();
    const d = getTelemetryData();
    const breaks = d.chainBreaks.length
      ? d.chainBreaks
          .slice(0, 5)
          .map((c) => `${buildingName(c.buildingType)}（${c.kind === 'material' ? '缺料' : '缺人'}）@ tick ${c.tick}`)
          .join('；') + (d.chainBreaks.length > 5 ? ` 等 ${d.chainBreaks.length} 次` : '')
      : '无';
    el.querySelector('[data-part="summary"]').innerHTML = `
      <div>构建：<code>${gameBuild}</code>${gameBuildDirty ? '（含未提交改动）' : ''}</div>
      <div>Lv2 到达：${fmtTick(s.milestones.lv2)}</div>
      <div>Lv3 到达：${fmtTick(s.milestones.lv3)}</div>
      <div>Lv4 到达（通关）：${fmtTick(s.milestones.lv4)}</div>
      <div>终局：户数 ${s.finalHouseholds ?? '—'}｜建筑 ${s.finalBuildingCount ?? '—'}｜用过 2×：${s.usedFastForward ? '是' : '否'}</div>
      <div>首次断链：${breaks}</div>
    `;
  }

  function exportJson() {
    const payload = buildExportPayload({
      gameBuild,
      gameBuildDirty,
      exportedAt: new Date().toISOString(), // 导出时刻（协议 v1.1 §4.2）
      playerProfile: radioValue('tp-profile'),
      paceVerdict: radioValue('tp-pace'),
      notes: el.querySelector('[data-part="notes"]').value.trim(),
    });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sessionFileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.act === 'export') exportJson();
    else if (btn.dataset.act === 'close') hide();
  });

  function show() {
    renderSummary();
    el.style.display = 'block';
  }

  function hide() {
    el.style.display = 'none';
  }

  return { show, hide, isVisible: () => el.style.display !== 'none' };
}
