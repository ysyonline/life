# 市井繁华 · 项目常驻说明

宋代市井题材城建经营模拟（HTML5 + Vite，纯静态，灰盒阶段无正式美术）。机制参照《满庭芳·宋上繁华》，**美术/文案/建筑名/数值全部原创**。
拍板权在用户（制作人）：agent 出建议与证据，**不代替拍板**。设计 / 技术 / QA 三个角色产出的判定需交叉复核后才入档。

## 红线（任何时候不许破）

1. **`core/` 是规则唯一权威**：任何玩法判定（解锁、计分、结算）落在 `src/core/`；`render/`、`ui/` 只读 state，通过意图函数改 state，禁碰 DOM/Canvas 以外的越层逻辑。
2. **验收套件不许改**：`tests/verification/` 是独立基准，禁止为了让自己的代码通过而改它（等于自己给自己判卷）。改验收 bot 必须走「用户授权 + 新旧并行 + 先复现基线」三条约束。
3. **改数值必过验收推演**：动 `src/config/` 后必跑 bot 通关推演 + V1 注入铜钱用例。本轮两条死锁都是"纸面合理但数学走不通"。
4. **降级/兜底值必须一眼可辨为假**（如 `unknown`）。一个看起来像真 commit 的兜底值，比明显错误更危险（B3 教训）。
5. **节奏数值冻结令（D-C1）生效中**：`rules.js`、`buildings.js` 的数值与造价冻结，例外需用户拍板。
6. **版权**：只借鉴机制，不引入《宋上繁华》任何资产。

## 读入纪律（省 token，也防用旧数当基线）

- **默认只读** `docs/HANDOVER.md` 的 §0 当前状态 + §5 阻塞项 + §6 下一步。**不要整篇读 HANDOVER**（全文读一次约 2~4 万 token，其中 70% 是已归档历史）。
- 需要历史：先 `grep docs/log/arc-log.md`，再按命中的路径打开**那一份**文档。
- **`docs/log/arc-log.md` 的「已废止读数」一节优先于任何旧文档**。旧文档里出现已废止读数时，以该节为准，不得直接引用。
- 长文档（`quality/n2-experiment-gate.md` 724 行、`design/03-pacing-postmortem-round2.md`）**不许整篇读**，除非用户点名。
- 引用任何读数必须带口径：**bot / 真人 · N=∞ / N=1 · 基线版本 · 准实现/结构近似/规则级近似**。裸引数字按错处理。

## 常用命令

```bash
npm run dev            # 试玩 → http://localhost:5173（⚠ 试玩前必须重启，见协议 v1.5 §2.1 硬前置）
npm run test           # 开发自测，当前 133/133（默认排除 tests/verification/）
npx vitest run --config vitest.verification.config.js   # 独立验收，当前 33/33
```

## 文档地图

| 文件 | 什么时候读 |
|---|---|
| `docs/HANDOVER.md` | **每次接手先读 §0 / §5 / §6**；其余按需 |
| `docs/log/arc-log.md` | 要查历史、要确认某读数是否已废止 |
| `docs/design/01-game-design.md` | 改玩法/阈值表时（总设计案，v0.3 定稿 + O6′ 同步） |
| `docs/design/03-pacing-postmortem-round2.md` | **动分值前必看** 附 2 §1b 边界表 |
| `docs/quality/playtest-protocol.md` | 做试玩前（现行 v1.5，含硬前置与判定带） |
| `docs/quality/*-judgment-*.md` | 某一轮判定的原始结论 |
| `src/config/rules.js` / `buildings.js` | 数值单一真源（冻结令覆盖） |
| `tests/config.test.js` | D10 配置快照——改数值它会红，**这是设计目的**，走「确认有意调整」流程更新 |

## 当前焦点

UX-3 新手引导已实施（`cb4d22d`），R1 误伤熟练玩家 PASS；**A4 主判据判定 FAIL**（2 位新玩家首局徘徊 281 / 358 tick），四条设计侧修订建议**待用户拍板**。
现行基线：新 bot @ O6′ → V2 `12/355/605`、V1 `211`，**余量仅 1.0 / 0.74 分，贴线型基准**，任何削分或抬阈值都极易翻红。
