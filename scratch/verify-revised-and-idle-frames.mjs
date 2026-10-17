// 两项增量核查（T-P6-08 后续，quality-lead；只读 src/，不写 src/ 与 tests/）
// A. 用「真人实测数据」独立验证 design-strategist 的模拟结论「P-1′ 的 Lv3→Lv4 窗口 93.1% 的帧无任何稀缺约束」
//    —— 他那个数来自 L* 模拟路线，这里用第 2 轮真人 JSON 直接算，两个口径互相印证。
// B. 修订后的 P-1′（恒计分封顶 24 + Lv3 60 + Lv4 150 + **迁入维持 5**）对验收 Gate 的冲击
//    —— 我上一轮的边界扫描用的是「迁入 8」版本，方案改了必须重跑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialState } from '../src/core/state.js';
import { placeBuilding } from '../src/core/grid.js';
import { tick, housingCapacity, computeLevel } from '../src/core/simulation.js';
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const line = (s = '') => console.log(s);

// ===================== A. 真人数据里的「无稀缺帧」占比 =====================
const FILES = {
  'R2-S3': 'production/playtests/playtest-session-20261017-152802.json',
  'R2-S4': 'production/playtests/playtest-session-20261017-153413.json',
  'R1-S1': 'production/playtests/playtest-session-20261017-110719.json',
  'R1-S2': 'production/playtests/playtest-session-20261017-111509.json',
};

// 「该帧是否存在任何绑定约束」的判据（全部满足 = 无任何稀缺）：
//   ① 劳力不缺：laborDemand <= households
//   ② 食不卡迁入：food > 安全线 10（且 > 0）
//   ③ 木可继续建：wood > 0
//   ④ 粮不为零：grain > 0
//   ⑤ 钱够再建一座：money >= 15（农田/林场造价，最低门槛）
//   ⑥ 该帧前 30 tick 内无 chainBreak 事件
function frameIsFree(f, breaks) {
  const recentBreak = breaks.some((b) => b.tick > f.tick - 30 && b.tick <= f.tick);
  const reasons = [];
  if (f.laborDemand > f.households) reasons.push('缺劳力');
  if (!(f.food > 10)) reasons.push(f.food <= 0 ? '断食' : '食≤安全线10');
  if (!(f.wood > 0)) reasons.push('木为零');
  if (!(f.grain > 0)) reasons.push('粮为零');
  if (!(f.money >= 15)) reasons.push('钱不足再建');
  if (recentBreak) reasons.push('近30tick内有断链');
  return { free: reasons.length === 0, reasons };
}

line('# A. 真人实测数据中的「无任何稀缺约束」帧占比（独立验证设计侧的 93.1% 模拟结论）');
line('');
line('判据：同时满足「劳力不缺 + 食 > 安全线10 + 木>0 + 粮>0 + 钱≥15 + 近30tick无断链」= 该帧无任何绑定约束。');
line('');
for (const [name, rel] of Object.entries(FILES)) {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const m = s.milestones;
  const pts = [...s.samples];
  // 只看 Lv3→Lv4 窗口（与 design-strategist 同口径）
  const win = pts.filter((f) => f.tick > m.lv3 && f.tick <= m.lv4);
  const rows = win.map((f) => ({ f, r: frameIsFree(f, s.chainBreaks) }));
  const freeN = rows.filter((x) => x.r.free).length;
  line(`## ${name}　Lv3→Lv4 窗口 = (${m.lv3}, ${m.lv4}]，采样帧 ${rows.length} 帧`);
  line('');
  line('| 帧 tick | 劳力缺? | 食 | 木 | 粮 | 钱 | 近30tick断链 | 无稀缺? | 若有约束，是 |');
  line('|---|---|---|---|---|---|---|---|---|');
  for (const { f, r } of rows) {
    line(
      `| ${f.tick} | ${f.laborDemand > f.households ? '缺' + (f.laborDemand - f.households) : '否'} | ${f.food.toFixed(1)} | ${f.wood} | ${f.grain} | ${f.money.toFixed(0)} | ${s.chainBreaks.filter((b) => b.tick > f.tick - 30 && b.tick <= f.tick).length} | ${r.free ? '**是**' : '否'} | ${r.reasons.join('、') || '—'} |`
    );
  }
  line('');
  line(`⇒ **无稀缺帧占比 = ${freeN}/${rows.length} = ${((freeN / rows.length) * 100).toFixed(1)}%**`);
  line('');
}

// 追加：全窗口（Lv1→Lv4）口径，看整体
line('## 全窗口（Lv1→Lv4）口径');
line('');
line('| 局 | 采样帧 | 无稀缺帧 | 占比 |');
line('|---|---|---|---|');
for (const [name, rel] of Object.entries(FILES)) {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const rows = s.samples.map((f) => frameIsFree(f, s.chainBreaks));
  const freeN = rows.filter((x) => x.free).length;
  line(`| ${name} | ${rows.length} | ${freeN} | ${((freeN / rows.length) * 100).toFixed(1)}% |`);
}
line('');

// ===================== B. 修订版 P-1′ 对验收 Gate 的冲击 =====================
// ---- 与验收用例逐字一致的 tryPlace / botBuild（源：tests/verification/progression.test.js:12-59，只读）----
function tryPlace(state, type) {
  const def = BUILDINGS[type];
  for (let y = 0; y <= 32 - def.size[1]; y++)
    for (let x = 0; x <= 32 - def.size[0]; x++)
      if (placeBuilding(state, type, x, y).ok) return true;
  return false;
}
const countType = (state, t) => state.buildings.filter((b) => b.type === t).length;
function botBuild(state) {
  const lvl = state.level, cap = housingCapacity(state), pop = state.population.count, c = countType;
  const wants = [];
  if (cap - pop < 2) wants.push(lvl >= 3 && state.money > 120 ? 'house' : 'hut');
  if (state.resources.food < 20 && c(state, 'mill') < 6) wants.push('mill');
  if (state.resources.grain < 20 && c(state, 'farm') < 6) wants.push('farm');
  if (state.resources.wood < 20 && c(state, 'forest') < 12) wants.push('forest');
  if (c(state, 'farm') < 2) wants.push('farm');
  if (c(state, 'forest') < 2) wants.push('forest');
  if (c(state, 'mill') < 2) wants.push('mill');
  if (lvl >= 2 && c(state, 'eatery') < 3) wants.push('eatery');
  if (lvl >= 2 && c(state, 'granary') < 1) wants.push('granary');
  if (lvl >= 3 && c(state, 'carpenter') < 2) wants.push('carpenter');
  if (lvl >= 4 && c(state, 'grocer') < 4) wants.push('grocer');
  if (c(state, 'farm') < 4) wants.push('farm');
  if (c(state, 'mill') < 3) wants.push('mill');
  if (c(state, 'forest') < 6) wants.push('forest');
  if (lvl >= 2 && c(state, 'eatery') < 6) wants.push('eatery');
  if (lvl >= 3 && c(state, 'carpenter') < 6) wants.push('carpenter');
  if (lvl >= 4 && c(state, 'grocer') < 8) wants.push('grocer');
  if (cap - pop < 4) wants.push(lvl >= 3 ? 'house' : 'hut');
  for (const t of wants) if (tryPlace(state, t)) return t;
  return null;
}
function prosperityCapped(state, cap) {
  const c = RULES.prosperityCoef;
  let working = 0, housingScore = 0, housingCap = 0, passive = 0;
  for (const b of state.buildings) {
    const def = BUILDINGS[b.type];
    if (def.capacity > 0) { housingScore += def.score; housingCap += def.capacity; }
    else if (b.type === 'farm' || b.type === 'forest' || b.type === 'granary') passive += def.score;
    else working += def.score * (b.idle ? c.idle : c.active);
  }
  const occ = housingCap > 0 ? Math.min(1, state.population.count / housingCap) : 0;
  return Math.min(passive, cap) + working + housingScore * occ;
}
function play(state, maxTicks, capPassive) {
  const levelAt = { 2: null, 3: null, 4: null };
  let maxP = 0;
  for (let i = 0; i < maxTicks; i++) {
    botBuild(state);
    tick(state);
    if (capPassive != null) {
      state.prosperity = prosperityCapped(state, capPassive);
      state.level = computeLevel(state.prosperity);
      state.maxLevel = Math.max(state.maxLevel ?? state.level, state.level);
    }
    maxP = Math.max(maxP, state.prosperity);
    for (const lv of [2, 3, 4]) if (levelAt[lv] == null && state.level >= lv) levelAt[lv] = state.tick;
    if (state.level >= 4) break;
  }
  return { levelAt, maxP, buildings: state.buildings.length, pop: state.population.count };
}
function snapshot() { return { t: [...RULES.unlockThresholds], m: RULES.moveInInterval }; }
function restore(s) { RULES.unlockThresholds.splice(0, 4, ...s.t); RULES.moveInInterval = s.m; }
// ---- 逐字搬运结束 ----

line('# B. 修订版 P-1′（封顶24 + Lv3 60 + Lv4 150 + **迁入维持 5**）对验收 Gate 的冲击');
line('');
line('> 说明：上一轮边界扫描用的是「迁入 8」版本，方案已移除迁入改动 ⇒ 必须重跑。');
line('> 预算与验收用例一致：2000 tick。校准：现网基线应复现 12/315/515。');
line('');
line('| 配置 | Lv2 | Lv3 | Lv4 | 最高繁荣度 | 建筑 | 户 | 验收断言 |');
line('|---|---|---|---|---|---|---|---|');
const cases = [
  { label: '现网基线（校准项）', th: [0, 20, 50, 100], mv: 5, cp: null },
  { label: '仅封顶 24', th: [0, 20, 50, 100], mv: 5, cp: 24 },
  { label: '仅阈值 60/150', th: [0, 20, 60, 150], mv: 5, cp: null },
  { label: '**修订版 P-1′（封顶24 + 60/150 + 迁入5）**', th: [0, 20, 60, 150], mv: 5, cp: 24 },
  { label: '（对照）旧版 P-1′ 含迁入8', th: [0, 20, 60, 150], mv: 8, cp: 24 },
];
const failed = [];
for (const c of cases) {
  const bak = snapshot();
  RULES.unlockThresholds.splice(0, 4, ...c.th);
  RULES.moveInInterval = c.mv;
  const r = play(createInitialState(), 2000, c.cp);
  restore(bak);
  const ok = r.levelAt[4] != null;
  if (!ok) failed.push(c.label);
  line(`| ${c.label} | ${r.levelAt[2]} | ${r.levelAt[3]} | ${r.levelAt[4] ?? '**未到达**'} | ${r.maxP.toFixed(1)} | ${r.buildings} | ${r.pop} | ${ok ? '✅ PASS' : '❌ **FAIL**'} |`);
}
line('');

// 修订版 P-1′ 的阈值边界（迁入 5）
line('## 修订版 P-1′ 口径（封顶 24 + 迁入 5）下的 Lv4 阈值边界');
line('');
line('| Lv4 阈值 | bot 到 Lv4 | 建筑 | 户 | 最高繁荣度 | 验收 |');
line('|---|---|---|---|---|---|');
for (const lv4 of [100, 120, 130, 140, 150, 175, 200]) {
  const bak = snapshot();
  RULES.unlockThresholds.splice(0, 4, 0, 20, 60, lv4);
  RULES.moveInInterval = 5;
  const r = play(createInitialState(), 2000, 24);
  restore(bak);
  line(`| ${lv4} | ${r.levelAt[4] ?? '**未到达**'} | ${r.buildings} | ${r.pop} | ${r.maxP.toFixed(1)} | ${r.levelAt[4] != null ? '✅ PASS' : '❌ FAIL'} |`);
}
line('');
line(`> 诊断结论：修订版 P-1′ 的 Lv4=150 **${failed.some((f) => f.includes('修订版')) ? '仍越界（bot 到不了）' : '可通过'}**。`);
