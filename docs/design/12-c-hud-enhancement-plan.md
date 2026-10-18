# c 条款实施方案 —— HUD 繁荣度区增强（形态甲 + 形态乙）

> 版本 v1.0 · 2026-10-20 · 设计策略师（文策渊） · **性质：实施方案，评审通过后才允许动代码**
> 依据：制作人已拍板 `11-c-stage-goal-guidance-eval.md` 的「变形立项」——形态甲（等级阶梯全景，Lv4 标通关）+ 形态乙（进度差额数字化），P-c2 按 `state.maxLevel` 高亮已通过级；形态丙转 backlog。
> 硬约束遵守声明：D-C1 数值冻结令（`src/config/rules.js` / `src/config/buildings.js` 一行不动）；零 core 改动、零遥测新字段、零协议升版；遵守「不提示最优解」设计边界（本方案只做信息展示，不做行动指向）。
> **本阶段禁止任何代码改动。** 本文档只描述改什么、改成什么样，供评审。

---

## 0. 一屏摘要

```markdown
改动面：src/ui/hud.js（~15 行）+ src/style.css（~15 行）。其他文件零改动。
形态甲：HUD 繁荣度区新增阶梯全景  Lv1●—Lv2●—Lv3○—Lv4○通关
        实心=曾到过（按 state.maxLevel），高亮=现在在这（按 state.level），Lv4 标「通关」。
形态乙：差额数字化  「下级 60 解锁：食肆、粮仓」→「下级 60（还差 23.6 分）解锁：食肆、粮仓」
测试影响：零既有用例需改（tests/ 无「下级/已达最高等级」断言，已逐一核对）。
验收：npm test 全绿 + verification 33/33 + git diff rules.js buildings.js 为空。
```

---

## 1. 现状定位（改动锚点）

### 1.1 `src/ui/hud.js`

| 锚点 | 现状 |
|---|---|
| L34–41 `createHud()` innerHTML | `.prosperity` 容器内含：`[data-r="level"]` 文本、`.barcol`（进度条 `.bar` + 小字 `.hint`「断链/闲置建筑不计繁荣度」）、`[data-r="next"]` 文本 |
| L79–96 `update()` 繁荣度段 | 读 `state.prosperity`→`p`、`state.level`→`level`；L82 读 `RULES.unlockThresholds`→`ths`；L83–92 未达顶级时算 `next/prev/pct`，写进度条宽度与「下级 ${next} 解锁：${unlocking}」；L93–95 达顶级写「已达最高等级」 |

### 1.2 `src/style.css`（样式文件唯一，无其他 css）

| 锚点 | 现状 |
|---|---|
| L27–39 `#hud` | 顶部单行 flex，`font-size:13px`，`padding:6px 12px` |
| L45–51 `#hud .prosperity` | `flex:1; display:flex; gap:8px; min-width:200px` |
| L68–80 `#hud .barcol` / `.hint` | 进度条列已是两行结构（条 + 10px 灰字 hint） |
| L270–288 `#hint-bar` | a 条款横幅：`max-width:min(640px, calc(100vw-24px))`、`font-size:13px`——**单行长度约束的来源** |

### 1.3 关键语义源

- `RULES.unlockThresholds = [0, 20, 60, 145]`（rules.js:17，**只读**，hud.js 现状已在读，本方案不新增任何写路径）。
- `state.maxLevel`：解锁粘性字段，只升不降（simulation.js:204）；`unlockedLevel()`（simulation.js:190–192）语义 = `Math.max(level, maxLevel ?? level)`。旧存档无该字段时以当前等级兜底（save.test.js:66–76 已验证此兼容）。
- 建筑解锁分布（只读引用）：Lv2 食肆、粮仓；Lv3 木匠铺、瓦屋；Lv4 杂货摊。

---

## 2. 精确改动规格（逐处）

### 改动 1 —— hud.js `createHud()` innerHTML（L34–41 区域）

在 `.prosperity` 容器内、`[data-r="level"]` **之前**，插入一个阶梯容器元素：

```text
<span class="ladder" data-r="ladder"></span>
```

- 选位理由：阶梯是"全局地图"，放繁荣度区最左端，阅读顺序为「阶梯全景 → 当前级数值 → 进度条 → 下一级」，与"从全局到局部"的认知顺序一致。
- 不放 `.barcol` 内（避免 HUD 增高）：HUD 增高会顶撞 `#hint-bar`/`#info-panel`/`#telemetry-panel` 的 `top:44px` 绝对定位（见 §6 风险 R1）。**主方案保持 HUD 单行高度不变。**

### 改动 2 —— hud.js `update()` 内新增阶梯渲染（L81 附近，读 `level` 之后）

伪代码（非 diff）：

```text
const ml = state.maxLevel ?? level            // 旧档兜底，与 unlockedLevel() 同纪律
const segs = ths.map((_, i) => {
  const lv = i + 1
  const isDone = lv <= ml                     // 曾到过 → 实心
  const isCur  = lv === level                 // 现在在这 → 高亮
  const text   = `Lv${lv}${isDone ? '●' : '○'}` + (lv === ths.length ? '通关' : '')
  return <span class={isDone?'done':'todo'} + (isCur?' cur':'')>text</span>
})
ladder元素.innerHTML = segs.join('<span class="sep">—</span>')
```

- 每 tick 重渲染，无缓存态（R-c2 信息过时风险结构性为零）。
- 节点数恒定 4 个 + 3 个连接符，无性能顾虑。
- `innerHTML` 内容全部来自代码内常量与整数，无注入面。

### 改动 3 —— hud.js L92 差额文案（形态乙）

```text
现状： `下级 ${next} 解锁：${unlocking}`
改为： `下级 ${next}（还差 ${Math.max(0, next - p).toFixed(1)} 分）解锁：${unlocking}`
```

- 精度取 `toFixed(1)`，与 L81「繁荣 xx.x」的显示精度一致，避免「繁荣 59.96 显示 60.0、还差显示 0 分」的口径打架。
- `Math.max(0, …)` 兜底：`p` 恰好等于/越过阈值的瞬时帧（本 tick 结算完 level 即升，但 update 时序上可能出现）不显示负数。
- L93–95「已达最高等级」分支**不动**。

### 改动 4 —— style.css 新增阶梯样式（追加在 `#hud .prosperity` 规则之后）

```text
#hud .ladder        { white-space:nowrap; font-size:11px; color:#9aa0ad; letter-spacing:0 }
#hud .ladder .done  { color:#ffca28 }                    /* 曾到过：琥珀实心，与进度条渐变同色系 */
#hud .ladder .cur   { color:#ffe082; font-weight:bold }  /* 当前所在级：加粗亮色 */
#hud .ladder .sep   { color:#555a66 }                    /* 连接符压暗，不抢信息 */
```

- 同时给 `[data-r="next"]` 补 `white-space:nowrap`（差额文案变长后禁止折行，超长宁可截断/挤压也不许换行撑高 HUD——换行会触发 R1 遮挡链）。
- 小屏兜底（媒体查询，宽度阈值建议 960px，评审可调）：窗口过窄时阶梯降为仅显示「当前Lv/4 + 通关标记」的紧凑形态，或整体隐藏差额括号段。具体阈值在评审时拍板。

### 不改清单（明确划出边界）

| 文件 | 为什么不改 |
|---|---|
| `src/core/**`（simulation.js / hints.js / telemetry.js …） | 零玩法判定新增，纯展示映射，分层纪律天然满足 |
| `src/config/rules.js` / `buildings.js` | D-C1 冻结令，`unlockThresholds`/`unlockLevel` 全部只读引用 |
| `src/core/telemetry.js`、存档协议 | 零遥测新字段、零协议升版 |
| `[data-r="level"]`「LvX 繁荣 xx.x」与 `.hint`「断链/闲置建筑不计繁荣度」 | 信息职责不重叠，保持原样 |

---

## 3. 文案定稿

### 3.1 阶梯全景（形态甲）

| 状态 | 呈现（class 着色见 §2 改动 4） |
|---|---|
| 开局（Lv1，maxLevel=1） | `Lv1●—Lv2○—Lv3○—Lv4○通关`（Lv1 加粗高亮） |
| Lv2 进行中（maxLevel=2） | `Lv1●—Lv2●—Lv3○—Lv4○通关`（Lv2 加粗高亮） |
| 回落中（level=1，maxLevel=3） | `Lv1●—Lv2●—Lv3●—Lv4○通关`（**Lv1 加粗高亮**，实心到 Lv3） |
| 通关（level=4） | `Lv1●—Lv2●—Lv3●—Lv4●通关`（全实心，Lv4 加粗高亮） |

- **Lv4 标注措辞：「通关」**，直接后缀在 `Lv4●/○` 之后，不加括号不加空格（省宽度）。
  - 备选「终点」：评审可换，但不推荐——「通关」是玩家既有词汇，「终点」需二次理解。
- 连接符用半角 `—`（em dash），不用 `→`：箭头带方向性暗示"必须逐级走"，与回落机制冲突。

### 3.2 差额文案（形态乙）

```text
下级 60（还差 23.6 分）解锁：食肆、粮仓
```

- 完整长度核算（最坏情况）：`下级 145（还差 120.0 分）解锁：杂货摊` ≈ 全角 13 字 + 半角 8 字 ≈ 220px @13px——`.prosperity` 为 `flex:1`，常规窗口下可容纳；配合 §2 改动 4 的 nowrap，**绝不折行**。
- 沿用 a 条款横幅单行教训：单行总字符预算 ≤ 24 字（全角折算），本文案最坏 21 字，达标。
- 措辞说明：「还差 N 分」语义中性——首次冲击与回落重回同一句式，不区分"还差"与"还差重回"，避免给回落贴惩罚标签（R-c3 缓解的一部分）。
- 「分」字保留：繁荣度单位在 HUD 其他处未命名，此处一个「分」字完成单位定义，成本最低。

---

## 4. maxLevel 高亮逻辑（P-c2 落地）

### 4.1 三态分离表达

| 视觉态 | 判定 | 表达含义 |
|---|---|---|
| 实心 ●（琥珀） | `lv <= state.maxLevel` | **曾经到过**——已解锁路径，只升不降 |
| 加粗高亮 | `lv === state.level` | **现在在哪儿**——瞬时繁荣度所在级 |
| 空心 ○（灰） | `lv > state.maxLevel` | 未到过 |

### 4.2 回落场景（B 案例 tick 300：Lv2 → 跌回 Lv1）

- 阶梯：实心保持到 `maxLevel`，高亮点移回低一级。玩家读到的是「我到过 Lv3，现在退回 Lv1 攒底子」，而非「我被惩罚回 Lv1」。
- 差额行：仍按**瞬时** `level` 计算「还差 N 分」（回答"差多少回去"），与阶梯的 maxLevel 语义各司其职。
- **已知遗留矛盾（不在本方案范围）**：回落时「下级 60 解锁：食肆、粮仓」中的建筑实际已因解锁粘性保持解锁（`docs/tech/02-p1-implementation-impact.md:165` 已记录此矛盾，P-1 时定为低优先级待拍板项）。本方案**不扩大也不掩盖**该矛盾；阶梯全景上线后，「● 已到过的级」与该文案并存，矛盾观感可能略增——评审时需确认接受，或将该文案修正单独立项。

### 4.3 旧存档兼容

`state.maxLevel ?? state.level` 兜底（与 simulation.js:191 同一写法）。save.js 侧已有旧档兼容逻辑（save.test.js:66–76 覆盖），hud 侧只读不新增任何迁移代码。

---

## 5. 测试影响清单

### 5.1 核对方法与结论

已 grep 整个 `D:/code/life/tests/`（模式：`下级`、`解锁`、`已达最高等级`、`maxLevel`、`hud`、`data-r="next"`、`繁荣`）：

| 测试文件 | 与本方案的关系 | 需改动？ |
|---|---|---|
| `tests/tax.test.js` | L7 `import { moneyLabel, formatMoney } from '../src/ui/hud.js'`；L183 用例「HUD 文案同时给出市税与商业两项」断言 `moneyLabel` 输出 | **否**——`moneyLabel`/`formatMoney` 不在改动面 |
| `tests/hints.test.js` | 多处 `state.maxLevel = 2`（构造 hints 判定输入） | **否**——测 core 判定，不碰 HUD 渲染 |
| `tests/save.test.js` L66–76 | maxLevel 存档往返 + 旧档兜底 | **否**——存档层不动 |
| `tests/simulation.test.js` L295–332 | maxLevel 只升不降、回落不重锁 | **否**——core 零改动 |
| `tests/grid.test.js` / `config.test.js` / `telemetry.test.js` | 解锁校验、RULES 常量、遥测字段 | **否**——全部不动 |
| `tests/verification/rules.test.js` | 33 条验收探针之一，解锁门槛 | **否**——冻结令零触碰 |
| `tests/verification/progression.test.js` | bot 爬升验收（基线 V2 `12/355/605`） | **否**——纯 UI 展示，bot 路径不经 HUD |

**结论：零既有用例需同步更新。** 没有任何用例断言「下级」「已达最高等级」或繁荣度区 DOM 结构，形态乙改文案、形态甲加元素均不触发既有断言。

### 5.2 建议新增（评审可选项，非本方案必需）

若评审希望给新展示加保险，可加 1~2 条轻量 DOM 用例（构造伪 state 调 `createHud().update()`，断言 `data-r="ladder"` 文本含「通关」、差额括号格式正确）。**但这会首次引入"测试断言 HUD 文案"的先例**——后续文案微调都要同步测试。建议：本迭代不加，把 HUD 文案视为可自由迭代的表层；若制作人要求加，再行评估。交给评审拍板。

---

## 6. 风险与回退

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | **样式遮挡链**：若阶梯/差额导致 HUD 增高或溢出，会顶撞 `#hint-bar`/`#info-panel`/`#telemetry-panel`（均 `top:44px` 绝对定位） | 中 | 主方案阶梯为行内 span、HUD 单行高度不变；差额行 nowrap 禁折行；实施后用 1280×720 与窄窗口各截一屏人工核对 |
| R2 | **文案超长**：最坏 21 字 + 阶梯 ~150px，小屏水平空间紧张 | 中 | §2 改动 4 媒体查询兜底（紧凑形态/隐藏括号段）；阈值 960px 待评审拍板 |
| R3 | **回落显化刺眼**（11 号文 R-c3 残留）：阶梯全景让"跌回 Lv1"更显眼 | 中低 | 已被 P-c2 设计抵消：实心到 maxLevel 把回落表达为"已知路径的回退"；差额措辞中性 |
| R4 | **旧存档无 maxLevel**：阶梯全空心错觉 | 低 | `?? level` 兜底，与 core 同写法；save.test.js 已有兼容用例背书 |
| R5 | **「不提示最优解」边界**：阶梯全景是否构成行动指向？ | 低 | 阶梯只陈述"世界有四级、第四级是通关"，不推荐任何建造顺序——与 T0「只讲机制因果」同纪律；形态丙（任务化）才是真正越界的形态，已转 backlog |

**回退方式**：改动面仅限 `hud.js` + `style.css` 两个文件、无 core/协议/存档污染，**回退 = `git revert` 单次提交**，零残留。

---

## 7. 验收标准（实施后逐条核）

1. `npm run test` 全绿（142 用例基线，零新增失败）。
2. `npx vitest run --config vitest.verification.config.js` **33/33 绿**。
3. `git diff src/config/rules.js src/config/buildings.js` **为空**（D-C1 冻结令验收行）。
4. `git diff --stat` 仅含 `src/ui/hud.js`、`src/style.css`（+ 可选的本方案新增测试，若评审批准 §5.2）。
5. 人工核对（无法自动化）：1280×720 下阶梯单行不折行、HUD 高度不变、hint-bar 无遮挡；Lv1→Lv4 各截一屏确认三态着色正确；人为注入回落（maxLevel=3、level=1）确认「实心到 Lv3、高亮在 Lv1」。

---

## 8. 待评审拍板项

| # | 决策点 | 本方案建议 |
|---|---|---|
| P-c4 | 阶梯在 `.prosperity` 内的位置 | 最左端（改动 1）；备选：并入 `.barcol` 第二行（需联动改 3 处 `top:44px`，不推荐） |
| P-c5 | Lv4 标注措辞 | 「通关」（备选「终点」，不推荐） |
| P-c6 | 小屏媒体查询阈值与降级形态 | 960px；降级为紧凑形态（仅当前级 + 通关标记） |
| P-c7 | 是否新增 HUD DOM 断言测试（§5.2） | 本迭代不加 |
| P-c8 | 回落时「下级 X 解锁：已解锁建筑」遗留矛盾是否单独立项 | 单独立项，不并入本方案（保持改动面最小） |
