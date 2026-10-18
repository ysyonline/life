// 离线回放：直接调用生产代码的谓词（isStagnant / isSlowGrowth / evaluateHints）跑 11 局遥测。
// ⚠ 口径声明：samples 为 30 tick 粒度，本脚本按 30 tick 线性插值还原逐 tick 序列 —— 属【结构近似】，
//    只判「会/不会触发 + 大致时机」，不得替代真人实测（纪律 13）。level / eatery 用阶梯取值。
// 用途：a) 标定 growthDelta  b) 验证「P4/P5 会触发、快玩家不误触发」
// 用法：node scratch/replay-hints.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createInitialState } from '../src/core/state.js';
import { isStagnant, isSlowGrowth, evaluateHints, pushProsperity } from '../src/core/hints.js';
import { UI_HINTS } from '../src/config/uiHints.js';

const DIR = 'production/playtests';

// 30 tick 采样 → 逐 tick 线性插值（level / eatery 阶梯）
function tickSeries(samples) {
  const out = [];
  if (!samples.length) return out;
  const s0 = samples[0];
  out.push({ tick: s0.tick, prosperity: s0.prosperity, level: s0.level, eatery: s0.buildingBreakdown?.eatery ?? 0 });
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const span = cur.tick - prev.tick;
    for (let k = 1; k <= span; k++) {
      out.push({
        tick: prev.tick + k,
        prosperity: prev.prosperity + (cur.prosperity - prev.prosperity) * (k / span),
        level: cur.level,
        eatery: cur.buildingBreakdown?.eatery ?? 0,
      });
    }
  }
  return out;
}

// 用生产谓词回放：逐 tick 推入缓冲（走 pushProsperity，与装配层同一路径），记录 T1 首次触发
function replayT1(series, { useGrowth }) {
  const buf = [];
  const state = createInitialState();
  for (const s of series) {
    state.level = s.level;
    state.tick = s.tick;
    pushProsperity(buf, s.prosperity);
    // 无食肆：用样本里的 buildingBreakdown.eatery 判定（与 eateryCount 等价）
    const noEatery = s.eatery === 0;
    if (s.level < 2 || !noEatery) continue;
    const hit = useGrowth ? isStagnant(buf) || isSlowGrowth(buf) : isStagnant(buf);
    if (hit) return s.tick;
  }
  return null;
}

// 徘徊窗口内最小窗口 Δ（误伤裕度）
function minDelta(series, from, to, w = UI_HINTS.stagnationWindow) {
  let min = Infinity;
  let at = null;
  for (let i = w; i < series.length; i++) {
    const s = series[i];
    if (s.tick < from) continue;
    if (s.tick > to) break;
    const d = s.prosperity - series[i - w].prosperity;
    if (d < min) { min = d; at = s.tick; }
  }
  return { min, at };
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const rows = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const series = tickSeries(j.samples ?? []);
  if (!series.length) continue;
  const ms = j.milestones ?? {};
  const actual = (j.hints ?? []).find((h) => h.id === 't1' && h.action === 'shown')?.tick ?? null;
  const oldT = replayT1(series, { useGrowth: false });
  const newT = replayT1(series, { useGrowth: true });
  const margin = ms.lv2 != null && ms.lv3 != null ? minDelta(series, ms.lv2, ms.lv3) : null;
  rows.push({
    id: f.replace('playtest-session-', '').replace('.json', ''),
    profile: j.playerProfile ?? '?',
    lv2: ms.lv2 ?? null, lv3: ms.lv3 ?? null,
    wander: ms.lv2 != null && ms.lv3 != null ? ms.lv3 - ms.lv2 : null,
    actual, oldT, newT, margin,
  });
}

const p = (v, n) => String(v ?? '—').padStart(n);
console.log(`\n=== 参数：growthWindow=${UI_HINTS.growthWindow} / growthDelta=${UI_HINTS.growthDelta}（停滞 ${UI_HINTS.stagnationWindow}/${UI_HINTS.stagnationDelta}）===\n`);
console.log('file\t\t\tprofile\tlv2\tlv3\t徘徊\t实测T1\t旧口径\t新口径\tminΔ60');
for (const r of rows) {
  console.log([r.id.padEnd(22), String(r.profile).padEnd(7), p(r.lv2, 4), p(r.lv3, 4), p(r.wander, 5), p(r.actual, 6), p(r.oldT, 6), p(r.newT, 6), r.margin ? r.margin.min.toFixed(1) : '—'].join('\t'));
}

const long = rows.filter((r) => (r.wander ?? 0) > 120);
const short = rows.filter((r) => r.wander != null && r.wander <= 120);
console.log(`\n=== 汇总 ===`);
console.log(`长徘徊局（>120 tick，应触发）：新口径触发 ${long.filter((r) => r.newT != null).length}/${long.length}，旧口径 ${long.filter((r) => r.oldT != null).length}/${long.length}`);
console.log(`短徘徊局（≤120 tick，不应触发）：新口径误触发 ${short.filter((r) => r.newT != null).length}/${short.length}${short.filter((r) => r.newT != null).map((r) => ' → ' + r.id + '(' + r.wander + 'tk)').join('')}`);
console.log(`短徘徊局最小窗口 Δ = ${Math.min(...short.map((r) => r.margin?.min ?? Infinity)).toFixed(1)}（阈值 ${UI_HINTS.growthDelta}，裕度 ${(Math.min(...short.map((r) => r.margin?.min ?? Infinity)) - UI_HINTS.growthDelta).toFixed(1)}）`);
console.log(`\n=== 触发提前量（实测 T1 → 新口径，仅对已触发局）===`);
for (const r of rows) {
  if (r.actual == null || r.newT == null) continue;
  console.log(`${r.id}  实测 ${r.actual} → 新口径 ${r.newT}  提前 ${r.actual - r.newT} tick`);
}
console.log(`\n⚠ 外推提示（非实测）：P4 实测「T1 shown → Lv3」= 72 tick。若该时延不随触发提前而缩短，
则新口径 P4 Lv3 ≈ 90+72=162，徘徊 ≈126 tick，仍 >100 线 —— 回放无法回答此问题，须由真人复测（d）裁定。`);
