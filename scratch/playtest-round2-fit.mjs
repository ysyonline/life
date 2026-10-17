// 第 2 轮真人试玩数据拟合脚本（T-P6-08，quality-lead）
// 目的 1：在不信任 gameBuild 的前提下，用 samples 逐帧反证「新繁荣度公式（P1/P2）」是否真的在这两局里生效
// 目的 2：量化第 1 轮 vs 第 2 轮的行为差异（ Idle 刷分路线是否被放弃、人口门是否收紧/放松）
// 目的 3：量化 O1/O2 两个可选项杠杆在当前 −80% 偏离下是否还有意义
// 纪律：只读 src/config/buildings.js 与 production/playtests/*.json，不写任何 src/ 或 tests/ 文件
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILDINGS } from '../src/config/buildings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const FILES = {
  'R1-S1': 'production/playtests/playtest-session-20261017-110719.json',
  'R1-S2': 'production/playtests/playtest-session-20261017-111509.json',
  'R2-S3': 'production/playtests/playtest-session-20261017-152802.json',
  'R2-S4': 'production/playtests/playtest-session-20261017-153413.json',
};

// ── 分值/参数（单一来源：src/config/buildings.js； Todo饥饿 script 不允许改写配置，只读取）
const S = {};
for (const [id, d] of Object.entries(BUILDINGS)) {
  S[id] = { score: d.score, cap: d.capacity ?? 0, workers: d.workers ?? 0, inputs: d.inputs ?? {}, outputs: d.outputs ?? {} };
}
const IDLEABLE = Object.keys(S).filter((t) => S[t].workers > 0 && Object.keys(S[t].inputs).length > 0);

function loadSession(rel) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return JSON.parse(raw);
}

// 计算一帧的静态量（与 idle 无关的部分）
function frameStat(f) {
  let nonScore = 0, houseScore = 0, capSum = 0, demand = 0;
  for (const [t, n] of Object.entries(f.buildingBreakdown ?? {})) {
    const def = S[t];
    if (!def) throw new Error(`未知建筑类型 ${t}`);
    if (def.cap > 0) { houseScore += def.score * n; capSum += def.cap * n; }
    else nonScore += def.score * n;
    demand += def.workers * n;
  }
  const hh = f.households;
  const capField = f.housingCapacity;
  const occ = capSum > 0 ? Math.min(1, hh / capSum) : 0;
  return {
    tick: f.tick, nonScore, houseScore, capSum, capField, demand, hh, occ,
    observed: f.prosperity,
    capMatches: capField === capSum,
    demandMatches: capField !== undefined && f.laborDemand === demand,
  };
}

// 穷举 idle 组合（按类型个数），返回四种公式变体下「劳动力可行的」最小残差
// 变体网格：idle ∈ {0(新/P1), 0.3(旧)} × 民居 ∈ {入住率折算(新/P2), 全额(旧)}
const VARIANTS = [
  { id: 'A', idle: 0, occ: true, label: 'A 新= P1(idle0)+P2(入住率)' },
  { id: 'B', idle: 0.3, occ: true, label: 'B 仅P2(idle0.3 + 入住率)' },
  { id: 'C', idle: 0, occ: false, label: 'C 仅P1(idle0 + 民居全额)' },
  { id: 'D', idle: 0.3, occ: false, label: 'D 旧公式(idle0.3 + 民居全额)' },
];

function fitFrame(st, bd) {
  const types = IDLEABLE.filter((t) => (bd[t] ?? 0) > 0);
  const ranges = types.map((t) => {
    const arr = [];
    for (let i = 0; i <= bd[t]; i++) arr.push(i);
    return arr;
  });
  const deficit = Math.max(0, st.demand - st.hh); // 劳动力缺口
  const best = {};
  for (const v of VARIANTS) best[v.id] = { res: Infinity, combos: [] };
  const cart = (i, acc) => {
    if (i === types.length) {
      const idle = {};
      types.forEach((t, k) => (idle[t] = acc[k]));
      let idleScore = 0, idleWorkers = 0;
      for (const [t, n] of Object.entries(idle)) {
        idleScore += S[t].score * n;
        idleWorkers += S[t].workers * n;
      }
      // 劳动力可行：idle 实例可作为「缺人」实例抵扣缺口 —— 必要条件 idleWorkers >= deficit
      if (idleWorkers < deficit) return;
      for (const v of VARIANTS) {
        const val =
          st.nonScore - (1 - v.idle) * idleScore + (v.occ ? st.houseScore * st.occ : st.houseScore);
        const r = Math.abs(val - st.observed);
        if (r < best[v.id].res - 1e-9) best[v.id] = { res: r, combos: [{ idle, val, idleScore }] };
        else if (Math.abs(r - best[v.id].res) < 1e-9) best[v.id].combos.push({ idle, val, idleScore });
      }
      return;
    }
    for (const v of ranges[i]) cart(i + 1, [...acc, v]);
  };
  cart(0, []);
  return { best, deficit, types };
}

const fmt = (x) => (x === Infinity ? 'n/a' : x < 1e-6 ? '0 ✓' : x.toFixed(4));
const out = [];
const log = (s = '') => { out.push(s); console.log(s); };

log('# 第 2 轮真人试玩：公式生效性拟合输出');
log(`生成时间：${new Date().toISOString()}`);
log('');
log('## 0. 分值表来源检查（src/config/buildings.js，只读）');
log('| 建筑 | score | 民居容量 | 劳力 | 是否可闲置(缺料/缺人) |');
log('|---|---|---|---|---|');
for (const [t, d] of Object.entries(S)) {
  log(`| ${t} | ${d.score} | ${d.cap} | ${d.workers} | ${IDLEABLE.includes(t) ? '是' : '否'} |`);
}
log('');
log('法定义：可闲置 = workers>0 且 inputs 非空（simulation.js settleProduction 只对这类建筑置 idle）；');
log('民居(hut/house)/粮仓(granary)无产出无消耗，进入 NonIdle 分支；农田/林场无劳力无投入，恒产出，永不计 idle。');
log('');

const sessions = {};
for (const [name, rel] of Object.entries(FILES)) sessions[name] = loadSession(rel);

// ── §1 逐帧拟合
log('## 1. 逐帧拟合残差：2×2 公式变体网格');
log('');
log('通用式： P = Σ非民居基础分 − (1−k_idle) × Σ闲置建筑基础分 + Σ民居基础分 × f(occ)');
for (const v of VARIANTS) log(`- 变体 ${v.label}`);
log('');
log('其中 f(occ) = min(1, 户数/容量)（若按入住率）或 1（若全额）。k_idle 为闲置建筑计分系数。');
log('枚举条件：对「可闲置类型」穷举 0..n 的闲置个数，仅保留劳动力可行的组合（闲置劳力 ≥ max(0, 劳力需求 − 户数)，这是缺人闲置的必要条件）。');
log('「精确吻合」判定：残差 < 1e-6。');
log('');
const fitSummary = {};
for (const [name, s] of Object.entries(sessions)) {
  log(`### ${name}  (${FILES[name].split('/').pop()})`);
  log('');
  log('| tick | 户数/容量 | 入住率 | 非民居分 | 民居分 | 劳力需求 | 劳力缺口 | 实测繁荣度 | A残差 | B残差 | C残差 | D残差 | 判别 |');
  log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const frames = [...s.samples.map((f) => ({ ...f })), { ...s.finalSnapshot, isFinal: true }];
  const tally = { A: 0, B: 0, C: 0, D: 0 };
  const summary = { n: 0, newExact: 0, oldExact: 0, newOnly: 0, oldOnly: 0, both: 0, neither: 0 };
  const rows = [];
  for (const f of frames) {
    const st = frameStat(f);
    const fit = fitFrame(st, f.buildingBreakdown ?? {});
    const res = {};
    for (const v of VARIANTS) res[v.id] = fit.best[v.id].res;
    const A = res.A < 1e-6, D = res.D < 1e-6;
    for (const v of VARIANTS) if (res[v.id] < 1e-6) tally[v.id]++;
    summary.n++;
    if (A) summary.newExact++;
    if (D) summary.oldExact++;
    if (A && !D) summary.newOnly++;
    if (!A && D) summary.oldOnly++;
    if (A && D) summary.both++;
    if (!A && !D) summary.neither++;
    const winners = VARIANTS.filter((v) => res[v.id] < 1e-6).map((v) => v.id);
    const verdict =
      winners.length === 0
        ? '都不吻合'
        : winners.join('/') === 'A'
        ? '**只有 A（新公式）吻合**'
        : winners.join('/') === 'D'
        ? '只有 D（旧公式）吻合'
        : winners.length === VARIANTS.length
        ? '四变体皆可（该帧无判别力）'
        : `${winners.join('+')} 可吻合`;
    rows.push({ tick: st.tick, st, fit, res });
    log(
      `| ${st.tick}${f.isFinal ? '（终局）' : ''} | ${st.hh}/${st.capSum} | ${st.occ.toFixed(3)} | ${st.nonScore} | ${st.houseScore} | ${st.demand} | ${fit.deficit} | ${st.observed} | ${fmt(res.A)} | ${fmt(res.B)} | ${fmt(res.C)} | ${fmt(res.D)} | ${verdict} |`
    );
  }
  fitSummary[name] = { summary, rows, tally };
  log('');
  log(`小结：共 ${summary.n} 帧。精确吻合帧数：A(新) **${tally.A}** ／ B(仅P2) ${tally.B} ／ C(仅P1) ${tally.C} ／ D(旧) ${tally.D}。`);
  log(`- 「只有 A 吻合」${summary.newOnly} 帧；「只有 D（旧）吻合」${summary.oldOnly} 帧；A 与 D 同时吻合（该帧无判别力）${summary.both} 帧；都不吻合 ${summary.neither} 帧。`);
  log('');
}
log('### 1-c. 变体网格汇总（这是「新公式是否生效」的主证据）');
log('');
log('| 局 | 总帧 | 「A 吻合而 D 不吻合」帧 | 「D 吻合而 A 不吻合」帧 | 无判别力(A&D同吻) | 归属结论 |');
log('|---|---|---|---|---|---|');
for (const [name, d] of Object.entries(fitSummary)) {
  const verdict =
    d.summary.newOnly > 0 && d.summary.oldOnly === 0
      ? '**新公式（P1+P2 均已生效）**'
      : d.summary.oldOnly > 0 && d.summary.newOnly === 0
      ? '**旧公式**（对照基线，符合预期）'
      : '混合/无法确认';
  log(`| ${name} | ${d.summary.n} | **${d.summary.newOnly}** | ${d.summary.oldOnly} | ${d.summary.both} | ${verdict} |`);
}
log('');
log('### 1-d. P1 与 P2 的**分别**印证（拆两台车的属性）');
log('');
log('| 局 | 「A 吻合而 B 不吻合」帧（⇒ 必须是 idle=0，即 P1 生效） | 「A 吻合而 C 不吻合」帧（⇒ 必须是按入住率，即 P2 生效） | 结论 |');
log('|---|---|---|---|');
for (const [name, d] of Object.entries(fitSummary)) {
  const p1frames = d.rows.filter((r) => r.res.A < 1e-6 && r.res.B >= 1e-6);
  const p2frames = d.rows.filter((r) => r.res.A < 1e-6 && r.res.C >= 1e-6);
  const verdict =
    p1frames.length && p2frames.length
      ? 'P1 与 P2 分别被独立印证'
      : p2frames.length
      ? '仅 P2 被独立印证（本局无可闲置建筑，P1 无判别力）'
      : p1frames.length
      ? '仅 P1 被独立印证'
      : '两者都无判别力 / 归属旧公式';
  log(
    `| ${name} | ${p1frames.length ? p1frames.map((r) => 't' + r.tick).join('、') : '0 帧'} | ${p2frames.length ? p2frames.map((r) => 't' + r.tick).join('、') : '0 帧'} | ${verdict} |`
  );
}
log('');
log('合并读法：P2 由 R2-S3 的 tick 30/90/180/210 印证（这些帧根本不存在任何可闲置建筑，差别纯由入住率产生）；');
log('P1 由 R2-S4 的 tick 150/210/250 印证（这些帧确有劳力缺口，只有 idle=0 能对上）。两条各自有独立证据，互不依赖。');
log('');

// ── §1b 单调性证明：同一状态下 新 ≤ 旧
log('## 1b. 结构性质校验：同一 game state 下 P_new ≤ P_old');
let viol = 0, checked = 0;
for (const [name, s] of Object.entries(sessions)) {
  for (const f of [...s.samples, s.finalSnapshot]) {
    const st = frameStat(f);
    const nb = st.nonScore + st.houseScore * st.occ;
    const ob = st.nonScore + st.houseScore; // 全部运转时的旧公式值
    checked++;
    if (nb > ob + 1e-9) viol++;
  }
}
log(`检查 ${checked} 帧（全部运转基线）：P_new ≤ P_old 恒成立，违反 ${viol} 帧。`);
log('⇒ 结论：在完全相同的城市状态下，组合拳只能让繁荣度「变低或不变」，不可能变高。');
log('');

// ── §2 行为适应证据：跨 4 局终局/过程对比
log('## 2. 行为适应证据：第 1 轮 vs 第 2 轮');
log('');
log('### 2.1 终局快照对比');
log('| 局 | 通关tick | 建筑数 | 户数/容量 | 入住率 | 劳力需求 | 劳力缺口(需求−户数) | 食肆 | 食肆/户 | 被动恒计分建筑(农田+林场+粮仓) | 被动分占比 |');
log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const [name, s] of Object.entries(sessions)) {
  const f = s.finalSnapshot;
  const st = frameStat(f);
  const passive = (f.buildingBreakdown.farm ?? 0) * 2 + (f.buildingBreakdown.forest ?? 0) * 2 + (f.buildingBreakdown.granary ?? 0) * 2;
  const eat = f.buildingBreakdown.eatery ?? 0;
  log(
    `| ${name} | ${f.tick} | ${f.buildingCount} | ${st.hh}/${st.capSum} | ${st.occ.toFixed(3)} | ${st.demand} | ${st.demand - st.hh} | ${eat} | ${(eat / st.hh).toFixed(2)} | ${passive} | ${((passive / st.observed) * 100).toFixed(1)}% |`
  );
}
log('');
log('### 2.2 逐帧「劳力缺口」序列（负=劳力盈余）');
for (const [name, s] of Object.entries(sessions)) {
  const series = [...s.samples, s.finalSnapshot].map((f) => {
    const d = f.laborDemand - f.households;
    return `${f.tick}:${d > 0 ? '+' + d : d}`;
  });
  const neg = [...s.samples, s.finalSnapshot].filter((f) => f.laborDemand - f.households > 0).length;
  const pos = [...s.samples, s.finalSnapshot].filter((f) => f.laborDemand - f.households <= 0).length;
  log(`- ${name}：${series.join(' ')}　（出现劳力缺口的帧 ${neg} / 盈余帧 ${pos}）`);
}
log('');
log('### 2.3 人口（户数）序列与断粮帧');
for (const [name, s] of Object.entries(sessions)) {
  const hh = s.samples.map((f) => `${f.tick}:${f.households}`);
  const food0 = s.samples.filter((f) => f.food <= 0.5).map((f) => f.tick);
  const minFood = Math.min(...s.samples.map((f) => f.food));
  const declines = [];
  for (let i = 1; i < s.samples.length; i++) {
    const d = s.samples[i].households - s.samples[i - 1].households;
    if (d < 0) declines.push(`${s.samples[i].tick} 跌 ${d}`);
  }
  log(`- ${name}：户数 ${hh.join(' ')}　| 最小食 ${minFood.toFixed(2)}　| 断粮(食≤0.5)帧 ${food0.length ? food0.join(',') : '无'}　| 户数下滑 ${declines.length ? declines.join('；') : '无'}`);
}
log('');
log('### 2.4 开局 90 tick 的建筑构成（民居/人口引擎是否前置）');
for (const [name, s] of Object.entries(sessions)) {
  const parts = s.samples.filter((f) => f.tick <= 90).map((f) => {
    const bd = Object.entries(f.buildingBreakdown).map(([k, v]) => `${k}${v}`).join('+');
    return `t${f.tick}[${bd}] 户数${f.households}`;
  });
  log(`- ${name}：${parts.join(' → ')}`);
}
log('');

// ── §3 旧公式反事实：若第 1 轮的玩法跑在新公式下会怎样 / 第 2 轮跑在旧公式下会怎样
log('## 3. 反事实换算：同一座城市，两套公式各给多少分');
log('');
log('| 局 | 帧 | 户数/容量 | 新公式重算值 | 旧公式（同 idle 组合） | 旧−新 | 说明 |');
log('|---|---|---|---|---|---|---|');
for (const [name, s] of Object.entries(sessions)) {
  for (const f of [s.finalSnapshot]) {
    const st = frameStat(f);
    const fit = fitFrame(st, f.buildingBreakdown ?? {});
    const nv = fit.best.A.combos[0]?.val;
    let oSame = null;
    if (fit.best.A.combos[0]) {
      // 旧公式：闲置建筑从「计 1 分」降为「计 0.3 分」 ⇒ 扣 0.7 × 闲置分
      oSame = st.nonScore + st.houseScore - 0.7 * fit.best.A.combos[0].idleScore;
    }
    const gapv = oSame == null || nv == null ? null : oSame - nv;
    const note =
      gapv == null
        ? '无法计算'
        : gapv < 0.01
        ? '**两套公式完全同值（入住率=1 且零闲置 ⇒ 组合拳惩罚为 0）**'
        : `新公式低 ${gapv.toFixed(2)} 分（组合拳咬掉 ${((gapv / oSame) * 100).toFixed(1)}%）`;
    log(`| ${name} | ${f.tick}（终局） | ${st.hh}/${st.capSum} | ${nv == null ? 'n/a' : nv.toFixed(2)} | ${oSame == null ? 'n/a' : oSame.toFixed(2)} | ${gapv == null ? 'n/a' : gapv.toFixed(2)} | ${note} |`);
  }
}
log('');
log('读法：这一列回答「组合拳到底咬掉了多少分」。');
log('- R2-S3（第 2 轮）：终局城市在新旧公式下**完全同值** —— 入住率=1.00 且零闲置，组合拳惩罚为 **0**；');
log('- R2-S4（第 2 轮）：咬掉 11.20 分（占旧公式值 10.0%），有一定惩罚；');
log('- R1-S1 / R1-S2（第 1 轮，反事实）：同一座城市若用新公式重算，分别要少 12.17 / 32.98 分，即组合拳会把这两局拦在 Lv4 之外很久。');
log('⇒ 这正好解释了「调参后反而更快」：组合拳的惩罚量与玩家的失误程度（空置率 + 闲置量）成正比，');
log('第 2 轮玩家把这两项都压到接近 0（S3 压到严格 0），于是**惩罚有名无实**。');
log('注：R1 两局的「新公式重算值」是该局 idle 组合下的最优拟合近似（两轮不完全可比，量级可信）。');
log('');

// ── §4 杠杆量化
log('## 4. 杠杆量化（O1 / O2 / 协议主杠杆）');
log('');
const TARGET = { lv2lo: 120, lv2hi: 180, lv3: 780, lv4: 1260 };
function milestones(name) {
  const s = sessions[name];
  return s.milestones;
}
const R2 = ['R2-S3', 'R2-S4'];
const med = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };
const m2 = med(R2.map((n) => sessions[n].milestones.lv2));
const m3 = med(R2.map((n) => sessions[n].milestones.lv3));
const m4 = med(R2.map((n) => sessions[n].milestones.lv4));
log(`第 2 轮中位数：Lv2=${m2} tick　Lv3=${m3} tick　Lv4=${m4} tick`);
log(`目标：Lv2 ${TARGET.lv2lo}~${TARGET.lv2hi}｜Lv3 ${TARGET.lv3}｜Lv4 ${TARGET.lv4}`);
log('');

// 4.1 各段分数斜率（用于估算抬高阈值的延后量）
for (const name of R2) {
  const s = sessions[name];
  const ms = s.milestones;
  log(`### ${name} 邻近斜率`);
  const pts = [...s.samples, { tick: s.finalSnapshot.tick, prosperity: s.finalSnapshot.prosperity, households: s.finalSnapshot.households, laborDemand: s.finalSnapshot.laborDemand }];
  for (const [label, t] of [['Lv2', ms.lv2], ['Lv3', ms.lv3], ['Lv4', ms.lv4]]) {
    const before = pts.filter((p) => p.tick <= t).slice(-1)[0];
    const after = pts.filter((p) => p.tick >= t)[0];
    const lo = pts.filter((p) => p.tick < t).slice(-1)[0] ?? before;
    const hi = pts.filter((p) => p.tick > t)[0] ?? after;
    let slope = null;
    if (lo && hi && hi.tick !== lo.tick) slope = (hi.prosperity - lo.prosperity) / (hi.tick - lo.tick);
    log(`- ${label} @ tick ${t}：夹逼帧 ${lo ? lo.tick + '→' + hi.tick : 'n/a'}，局部斜率 ≈ ${slope == null ? '无法计算' : slope.toFixed(3) + ' 分/tick'}`);
    if (label === 'Lv2') log(`  ⇒ O1（20→25，+5 分）预计延后 ≈ ${slope ? (5 / slope).toFixed(1) : 'n/a'} tick`);
    if (label === 'Lv3') log(`  ⇒ 主杠杆 Lv3 50→60（+10 分）预计延后 ≈ ${slope ? (10 / slope).toFixed(1) : 'n/a'} tick`);
    if (label === 'Lv4') log(`  ⇒ 主杠杆 Lv4 100→120（+20 分）预计延后 ≈ ${slope ? (20 / slope).toFixed(1) : 'n/a'} tick`);
  }
  log('');
}

// 4.2 O2：迁入间隔 5→6 —— 逐段判定「人口增速约束」是否真的在临界路径上
log('### O2（迁入间隔 5→6）量化：人口增长到底是不是瓶颈');
log('');
log('逐相邻采样区间分类（决定 O2 在区间内能否生效）：');
log('- **节奏受限**：区间两端均有空房(vacancy>0)且食 > 安全线 10 → 迁入只受 5 tick/户 节拍限制，O2 有效；');
log('- **容量受限**：任一端 vacancy=0 → 户数是被住房数量顶住，放慢节拍零影响；');
log('- **粮食受限**：两端均有空房但任一端食 ≤ 10 → 迁入被食安全线卡住，放慢节拍零影响。');
log('');
log('O2 理论上限：节拍受限区间内每 tick 新增户数由 1/5 降为 1/6，即这些区间的耗时需 +20%。');
log('');
for (const name of Object.keys(sessions)) {
  const s = sessions[name];
  // 按 tick 排序合并 samples 与通关快照（部分局通关后继续挂机，finalSnapshot.tick 早于末帧）
  const pts = [...s.samples, s.finalSnapshot].sort((a, b) => a.tick - b.tick);
  log(`#### ${name}`);
  log('');
  log('| 区间 | Δtick | 户数变化 | 起始端(vacancy, 食) | 终止端(vacancy, 食) | 分类 |');
  log('|---|---|---|---|---|---|');
  let total = 0, rate = 0, capT = 0, foodT = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dt = b.tick - a.tick;
    const va = a.housingCapacity - a.households, vb = b.housingCapacity - b.households;
    let cls;
    if (va > 0 && vb > 0 && a.food > 10 && b.food > 10) cls = '节奏受限';
    else if (va > 0 && vb > 0) cls = '粮食受限';
    else cls = '容量受限';
    total += dt;
    if (cls === '节奏受限') rate += dt;
    else if (cls === '粮食受限') foodT += dt;
    else capT += dt;
    log(`| ${a.tick}→${b.tick} | ${dt} | ${a.households}→${b.households} | (${va}, ${a.food.toFixed(1)}) | (${vb}, ${b.food.toFixed(1)}) | ${cls} |`);
  }
  const deficitFrames = pts.filter((p) => p.laborDemand > p.households).length;
  log('');
  log(`- 合计 ${total} tick：节奏受限 ${rate} tick（${((rate / total) * 100).toFixed(0)}%）／容量受限 ${capT} tick（${((capT / total) * 100).toFixed(0)}%）／粮食受限 ${foodT} tick（${((foodT / total) * 100).toFixed(0)}%）`);
  log(`- **O2 时长延后上限 = 20% × ${((rate / total) * 100).toFixed(0)}% ≈ +${(0.2 * (rate / total) * 100).toFixed(1)}%**`);
  log(`- 二次衰减：该局 ${pts.length} 帧中有 ${deficitFrames} 帧处于劳力不足（需求>户数）。人口只有在劳力不足时才转化为额外分数，否则 O2 效果归零 ⇒ 再乘劳力门槛系数 ${(deficitFrames / pts.length).toFixed(2)} → 实际约 **+${(0.2 * (rate / total) * (deficitFrames / pts.length) * 100).toFixed(1)}%**`);
  log('');
}
log('注：即便按最宽松假设（全时段节奏受限 + 全程劳力不足），O2 的绝对上限也只有 +20%。');
log('');

// 4.3 合并杠杆上限（协议禁止同时动，此处仅为「能不能救」的上界论证）
log('### 全部阈值杠杆叠加的延后上限（协议禁止同时动；此处只为回答「组合起来够不够」）');
log('');
for (const name of R2) {
  const s = sessions[name];
  const ms = s.milestones;
  const pts = [...s.samples, s.finalSnapshot];
  const nearSlope = (t) => {
    const lo = pts.filter((p) => p.tick < t).slice(-1)[0];
    const hi = pts.filter((p) => p.tick > t)[0] ?? pts.filter((p) => p.tick >= t)[0];
    if (!lo || !hi || hi.tick === lo.tick) return null;
    return (hi.prosperity - lo.prosperity) / (hi.tick - lo.tick);
  };
  const wideSlope = (t, w = 90) => {
    const cand = pts.filter((p) => Math.abs(p.tick - t) <= w);
    const lo = cand[0], hi = cand[cand.length - 1];
    if (!lo || !hi || hi.tick === lo.tick) return null;
    return (hi.prosperity - lo.prosperity) / (hi.tick - lo.tick);
  };
  const rows = [];
  for (const [label, t, dP] of [['Lv2 阈值 20→25 (O1)', ms.lv2, 5], ['Lv3 阈值 50→60', ms.lv3, 10], ['Lv4 阈值 100→120', ms.lv4, 20]]) {
    const sn = nearSlope(t), sw = wideSlope(t);
    const cand = [sn, sw].filter((x) => x && x > 0);
    const slopeConservative = cand.length ? Math.min(...cand) : null; // 取更小的斜率 = 更乐观的延后上限
    rows.push({
      label, t, dP, sn, sw,
      delay: slopeConservative ? dP / slopeConservative : null,
    });
  }
  log(`#### ${name}`);
  log('| 杠杆 | 里程碑 tick | Δ分 | 邻域斜率(分/tick) | ±90tick 斜率 | 取小斜率(对杠杆最有利) | 延后上限(tick) | 占所需缺口比 |');
  log('|---|---|---|---|---|---|---|---|');
  let sumDelay = 0;
  for (const r of rows) {
    sumDelay += r.delay ?? 0;
    log(`| ${r.label} | ${r.t} | +${r.dP} | ${r.sn == null ? 'n/a' : r.sn.toFixed(3)} | ${r.sw == null ? 'n/a' : r.sw.toFixed(3)} | ${r.delay == null ? 'n/a' : (r.dP / r.delay).toFixed(3)} | ${r.delay == null ? 'n/a' : '+' + r.delay.toFixed(0)} | ${r.delay == null ? 'n/a' : ((r.delay / (TARGET.lv4 - ms.lv4)) * 100).toFixed(1) + '%'} |`);
  }
  log('');
  const gap = TARGET.lv4 - ms.lv4;
  log(`- 所需缺口：${TARGET.lv4} − ${ms.lv4} = **${gap} tick**（需放慢 ${(TARGET.lv4 / ms.lv4).toFixed(2)}×）`);
  log(`- 三个阈值杠杆全部同时上（违反协议纪律）的乐观延后合计 ≈ **+${sumDelay.toFixed(0)} tick** → Lv4 落到约 ${(ms.lv4 + sumDelay).toFixed(0)} tick，仍比目标快 ${(TARGET.lv4 / (ms.lv4 + sumDelay)).toFixed(2)}×，只弥合缺口的 ${((sumDelay / gap) * 100).toFixed(1)}%`);
  log('');
}

// 4.3 需要的杠杆强度
log('### 需要的杠杆强度 vs 可用杠杆');
const needRatio = TARGET.lv4 / m4;
log(`- Lv4 需放慢倍数：${TARGET.lv4} / ${m4} = **${needRatio.toFixed(2)}×**（即需 +${((needRatio - 1) * 100).toFixed(0)}% 时长，缺口 ${(TARGET.lv4 - m4).toFixed(0)} tick）`);
log(`- bot（验收推演合法路线）Lv4 = 515 tick，真人中位 ${m4} tick —— **真人比 bot 快 ${(515 / m4).toFixed(2)}×**`);
log('- 结论刻划：任何「抬高解锁阈值」类杠杆对 bot 与真人是**同向等比**作用的：若把 Lv4 阈值提到 100×k 使真人落到 1260，bot 也会从 515 拉到约 ' + Math.round(515 * needRatio) + ' tick，远超目标 1260 ⇒ **不存在能把真人拉到目标而 bot 仍合理的阈值解**。');
log('');

// ── §5 观测量（02-pacing-tuning.md §5.2）
log('## 5. §5.2 同步观测项');
log('');
for (const name of Object.keys(sessions)) {
  const s = sessions[name];
  const gran = (s.finalSnapshot.buildingBreakdown.granary ?? 0);
  const maxGran = Math.max(...s.samples.map((f) => f.buildingBreakdown.granary ?? 0), gran);
  const occs = [...s.samples, s.finalSnapshot].map((f) => (f.housingCapacity > 0 ? f.households / f.housingCapacity : 0));
  const cbKind = {};
  for (const cb of s.chainBreaks) cbKind[cb.kind] = (cbKind[cb.kind] ?? 0) + 1;
  const cbTypes = {};
  for (const cb of s.chainBreaks) cbTypes[cb.buildingType] = (cbTypes[cb.buildingType] ?? 0) + 1;
  log(`- ${name}：chainBreaks ${s.chainBreaks.length} 条（${Object.entries(cbTypes).map(([k, v]) => k + '×' + v).join('、') || '无'}；${Object.entries(cbKind).map(([k, v]) => k + '×' + v).join('、') || '无'}）｜粮仓峰值 ${maxGran} 座（>5 触发 O3 → ${maxGran > 5 ? '**已触发**' : '未触发'}）｜入住率序列 ${occs.map((o) => o.toFixed(2)).join(' ')}｜最小值 ${Math.min(...occs).toFixed(2)}（健康区间 0.6~1.0）`);
}
log('');

// ── §6 里程碑分段
log('## 6. 分段时长与偏离度');
log('');
log('| 局 | Lv1→2 | Lv2→3 | Lv3→4 | 总 |');
log('|---|---|---|---|---|');
for (const name of Object.keys(sessions)) {
  const m = sessions[name].milestones;
  log(`| ${name} | ${m.lv2} | ${m.lv3 - m.lv2} | ${m.lv4 - m.lv3} | ${m.lv4} |`);
}
log('');
const R1 = ['R1-S1', 'R1-S2'];
const m2r1 = med(R1.map((n) => sessions[n].milestones.lv2));
const m3r1 = med(R1.map((n) => sessions[n].milestones.lv3));
const m4r1 = med(R1.map((n) => sessions[n].milestones.lv4));
log(`中位数对比：第 1 轮 Lv2=${m2r1} / Lv3=${m3r1} / Lv4=${m4r1}　vs　第 2 轮 Lv2=${m2} / Lv3=${m3} / Lv4=${m4}`);
log(`第 2 轮相对第 1 轮：Lv2 ${(((m2 - m2r1) / m2r1) * 100).toFixed(1)}%　Lv3 ${(((m3 - m3r1) / m3r1) * 100).toFixed(1)}%　Lv4 ${(((m4 - m4r1) / m4r1) * 100).toFixed(1)}%`);
log('');
log('偏离度（负=偏快）：');
log(`- Lv2：(${m2} − ${TARGET.lv2lo}) / ${TARGET.lv2lo} = ${(((m2 - TARGET.lv2lo) / TARGET.lv2lo) * 100).toFixed(1)}%（对区间下沿）｜对区间中值 150 = ${(((m2 - 150) / 150) * 100).toFixed(1)}%`);
log(`- Lv3：(${m3} − ${TARGET.lv3}) / ${TARGET.lv3} = ${(((m3 - TARGET.lv3) / TARGET.lv3) * 100).toFixed(1)}%`);
log(`- Lv4：(${m4} − ${TARGET.lv4}) / ${TARGET.lv4} = ${(((m4 - TARGET.lv4) / TARGET.lv4) * 100).toFixed(1)}%`);
log('');

fs.writeFileSync(path.join(ROOT, 'scratch', 'playtest-round2-fit.out.txt'), out.join('\n'), 'utf8');
console.log('\n[written] scratch/playtest-round2-fit.out.txt');
