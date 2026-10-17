# 技术架构方案 —— 核心循环竖切片

> 作者：柯桥良（技术总监）
> 目标：快速验证"建造 + 资源生产链 + 人口/繁荣度"核心循环，方案务实、清晰、可扩展，不上 ECS / 服务端 / 热更。

## 1. 技术选型

### 1.1 渲染方案：原生 Canvas 2D，不引入游戏引擎

| 候选 | 结论 | 理由 |
|---|---|---|
| **原生 Canvas 2D** | ✅ 采用 | 竖切片只画色块、网格线、少量文字，Canvas 2D 完全够用；零依赖、零学习成本；网格 + 相机的绘制逻辑自己动手可控性最强 |
| Phaser / PixiJS | ❌ | 引擎的场景管理、资源加载、物理等能力本轮全部用不到，反而引入约束和体积；后续若上美术资源再评估 PixiJS（WebGL 批渲染）迁移，成本可控 |
| WebGL 原生 | ❌ | 开发成本高，色块渲染用不上 GPU 能力 |

**关键决策**：渲染层与模拟层严格解耦（见 5.2），未来换 PixiJS/WebGL 只改 `render/` 目录。

### 1.2 构建工具：Vite

- 理由：秒级冷启动 + HMR，策划改数值配置（纯数据文件）时即时刷新，调参体验好；
- 产出为纯静态文件，可部署到任意静态托管，符合"即开即玩、易分享"；
- 代价几乎为零（一个 `vite.config.js`，零配置起步）。

### 1.3 语言：JavaScript（ESM），不上 TypeScript

- 理由：竖切片阶段 2-3 人协作、代码量小（预估 < 3000 行），TS 的类型收益不抵配置和心智成本；
- 用 JSDoc + 编辑器类型推断兜底关键数据结构（地块、建筑定义、资源定义）；
- **预留后路**：全部代码用 ESM 模块化 + 纯数据配置分离，若 P2 阶段规模上来，可渐进迁移 TS（Vite 原生支持，改后缀即可）。

## 2. 工程目录结构

```
life/
├── index.html                  # 入口页，挂载 canvas + UI 根节点
├── package.json
├── vite.config.js
├── public/                     # 静态资源（本轮几乎为空，仅 favicon）
├── src/
│   ├── main.js                 # 入口：初始化 state、启动循环、挂载 UI
│   ├── config/                 # 数据驱动配置（策划可改，纯数据无逻辑）
│   │   ├── buildings.js        # 建筑定义：占地、成本、产出/消耗、解锁条件
│   │   ├── resources.js        # 资源定义：名称、初始量、是否入库显示
│   │   └── rules.js            # 全局规则：tick 时长、繁荣度系数、初始资金等
│   ├── core/                   # 模拟层（纯逻辑，不碰 DOM/Canvas，可单测）
│   │   ├── state.js            # 单一 state 树定义与初始化
│   │   ├── grid.js             # 网格系统：地块数据、坐标换算、放置校验
│   │   ├── simulation.js       # 模拟循环：tick 推进、生产链结算、人口/繁荣度
│   │   └── save.js             # 存档：序列化/反序列化、localStorage 读写
│   ├── render/                 # 渲染层（只读 state，不改 state）
│   │   ├── camera.js           # 相机：平移、缩放、世界/屏幕坐标互转
│   │   └── renderer.js         # Canvas 绘制：网格、建筑色块、悬停高亮
│   └── ui/                     # UI 层（HTML DOM）
│       ├── hud.js              # 资源面板（顶部条）
│       ├── buildMenu.js        # 建造菜单（选择建筑、进入放置模式）
│       └── infoPanel.js        # 选中建筑详情面板
├── tests/                      # 核心逻辑最小单测（vitest，只测 core/）
└── docs/
    └── tech/
        └── 01-architecture.md  # 本文档
```

**职责边界**：`core/` 不 import `render/`、`ui/`；`render/` 与 `ui/` 只读 state 并通过派发"意图"（如 `placeBuilding(type, x, y)`）让 `core/` 改 state。

## 3. 核心模块划分

### 3.1 网格系统（`core/grid.js`）

- **数据结构**：`grid = Map<"x,y", cell>`。`cell = { terrain, buildingId? }`。用 Map 而非二维数组，支持不规则边界且稀疏友好；竖切片地图不大（32×32），也可随时换成扁平数组。
- **建筑占地**：每个建筑实例记录锚点 + 宽高（如民居 1×1、作坊 2×2），占用多格时所有格子存同一 `buildingId`。
- **坐标换算**：世界坐标（格）↔ 屏幕坐标（像素）由 `render/camera.js` 统一处理；网格系统只认整数格坐标，不关心像素。
- **放置校验**：`canPlace(type, x, y)` 检查边界、占用、地形（如农田只能放平地），返回布尔 + 原因。

### 3.2 游戏模拟循环（`core/simulation.js`）

- **固定步长 tick**：逻辑 tick 每 1000ms 一次（1 tick = 1 秒，`rules.js` 可配；设计案全部数值按此基准配置），用累加器模式与渲染帧（requestAnimationFrame）解耦：
  ```
  acc += dt; while (acc >= TICK) { tick(state); acc -= TICK; }
  ```
- **每 tick 结算内容**（顺序固定，保证确定性）：
  1. 建筑产出/消耗：按 `buildings.js` 配置的 `inputs/outputs` 结算原料→加工→消费链（如农田产粮→磨坊磨面→居民消费）；原料不足则停产并标记 `idle`。
  2. 人口：有空置民居容量且食库存 > 安全线（10）则每 5 tick 迁入 1 户；食库存耗尽（= 0）且持续 10 tick，则每 5 tick 迁出 1 户。
  3. 繁荣度：`繁荣度 = Σ 建筑基础分 × 运转系数`（正常运转 = 1.0，缺料/缺人 = 0.3），驱动解锁。
- **时间加速**：提供 1×/2×/暂停三档，只改累加器速率，模拟逻辑不变。

### 3.3 数据驱动设计（`config/`）

- 所有数值进配置，代码中不出现魔法数字。建筑定义示例：

```js
// config/buildings.js
export const BUILDINGS = {
  farm: {
    name: '农田',
    size: [2, 2],
    cost: { money: 15, wood: 10 },
    inputs: {},
    outputs: { grain: 2 },      // 每 tick 产出
    workers: 1,
    color: '#7cb342',           // 灰盒色块颜色也进配置
  },
  mill: {
    name: '磨坊',
    size: [2, 2],
    cost: { money: 30, wood: 20 },
    inputs: { grain: 2 },
    outputs: { flour: 1 },
    workers: 2,
    color: '#ffb300',
  },
  // ...
};
```

- 策划改产出、成本、尺寸只需改这一个文件，Vite HMR 即时生效，无需重启。
- 配置加载时做一次校验（字段完整性、资源名拼写是否存在于 `resources.js`），错误尽早暴露。

### 3.4 渲染层（`render/`）

- **灰盒绘制**：`renderer.js` 每帧清空 → 画网格线 → 遍历建筑画色块矩形 + 名称缩写文字 → 画悬停/放置预览（半透明绿色=可放、红色=不可放）。
- **相机**：`camera.js` 维护 `{ x, y, zoom }`，滚轮缩放（0.5×–3×，以鼠标为锚点）、拖拽平移；提供 `screenToWorld / worldToScreen` 两个函数，UI 点击放置全靠它换算。
- **性能**：32×32 网格 + 数百建筑，Canvas 2D 每帧全量重绘即可（实测远低于 16ms 预算），本轮不做脏矩形优化；若后续地块扩大，再引入离屏缓存。

### 3.5 UI 层（HTML DOM，不画进画布）

- **取舍**：HUD（资源面板）、建造菜单、建筑详情面板全部用 HTML DOM + CSS 实现，覆盖在 canvas 上方。
- 理由：
  - 文本排版、按钮、滚动列表是 DOM 的主场，Canvas 内自绘成本高且难维护；
  - 竖切片 UI 交互简单，DOM 开发速度远快；
  - Canvas 只负责游戏世界，UI 与渲染天然解耦，后续换引擎 UI 不用动。
- 数据流：UI 订阅 state 变更（简单发布订阅，每 tick 后通知一次），点击按钮派发意图函数（`startPlacing('farm')` / `placeBuilding(x, y)`）。

### 3.6 存档（`core/save.js`）

- **本轮需要**：最小可用存档——单槽位、自动保存（每 30 tick）+ 手动保存按钮。
- 方案：`JSON.stringify(state)` 存 `localStorage['songtown-save-v1']`；启动时检测并存档则询问是否继续。
- 关键约束：state 树**只放可序列化数据**（无函数、无 Map 实例——grid 序列化时转数组），版本号 `v1` 前缀为后续存档格式演进留口子。

## 4. 状态管理

单一 state 树 + 模拟器，无第三方状态库：

```js
state = {
  tick: 0,                    // 当前 tick 数
  money: 100,
  resources: { grain: 20, wood: 50, flour: 0, ... },
  population: { count: 0 },
  prosperity: 0,
  grid: Map,                  // 见 3.1（存档时序列化为数组）
  buildings: [ { id, type, anchorX, anchorY, workers, idle } ],
  ui: { placingType: null, hoverCell: null, selectedBuildingId: null },
}
```

- **唯一写入口**：所有 state 变更发生在 `simulation.tick()` 或意图函数（`placeBuilding`、`demolish`、`hire` 等）内，渲染层与 UI 层只读。
- 无状态库理由：代码量小，发布订阅 + 意图函数已足够；引入 Redux/MobX 是过度工程化。

## 5. 构建与本地运行

```bash
# 环境：Node.js ≥ 18
npm create vite@latest life -- --template vanilla   # 初始化（一次性）
cd life
npm install
npm install -D vitest                                # 可选，核心逻辑单测
npm run dev        # 本地开发，http://localhost:5173
npm run build      # 产出 dist/，任意静态托管即玩
npm run preview    # 本地预览构建产物
npm run test       # 跑 core/ 单测
```

## 6. 风险点与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **模拟与渲染耦合** | 换渲染方案/加测试时伤筋动骨 | 强制分层：`core/` 禁 import DOM/Canvas API；单测只测 `core/` |
| **tick 性能退化** | 建筑数上千后单 tick 结算变慢 | 生产结算走扁平数组遍历，避免每 tick 建临时对象；tick 固定 1000ms 留出充足预算；必要时分帧结算（本轮不做） |
| **Canvas 全量重绘压力** | 大地图 + 高缩放时掉帧 | 本轮规模内无压力；预留离屏缓存/脏矩形优化空间，不动架构 |
| **数值失衡拖慢验证** | 玩法验证卡在调参 | 全部数值配置化 + HMR 即时生效 + 存档可改 `money` 初始值快速跳中期 |
| **存档格式变更** | 旧存档失效 | key 带版本号（`v1`），加载时校验 `version` 字段，不匹配则提示重开 |
| **多人协作冲突** | 配置与逻辑互相踩 | 目录边界即责任边界：`config/` 归策划侧改，`core/` 归程序侧改 |
| **后续想上 TypeScript/引擎** | 推翻重来 | ESM 模块化 + 分层解耦保证渐进迁移：TS 改后缀即可，换引擎只重写 `render/` |

## 7. 明确不做（本轮范围外）

- ECS 架构、服务端/联机、热更新、资源加载器（灰盒无美术资源）
- 寻路、市民个体模拟（本轮人口是数值，不是实体）
- 声音、动画、粒子
