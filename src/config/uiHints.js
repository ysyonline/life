// UX-3 新手引导提示（检查点式，非模态提示条）的触发参数。
// ⚠ 冻结令（06-slice-closeout-and-p2-kickoff.md §2）约束：本文件是 UX 专用配置，
//    与 RULES 完全分离、不进 RULES——任何既有数值（阈值/公式/造价/速率）零改动。
// 参数取值来源：07-ux3-onboarding-draft.md §2 / D-U1（2026-10-18 14:54 拍板）。
export const UI_HINTS = {
  // T1 商业缺失 / T2 空屋过度共用的「繁荣度停滞」判定口径（对标熟练玩家徘徊段 57~64 tick，
  // 60 tick 窗口仅用于框定「真卡住」的判定时长，见 07 草案 C-3 修正）。
  stagnationWindow: 60, // 环形缓冲长度（tick）
  stagnationDelta: 1.0, // 窗口内繁荣度 Δ 低于此值视为停滞

  // T1 专用「增速不足」口径（A4 修订 a+b，2026-10-18）。覆盖「缓慢爬升型」新手：
  // 他们持续铺农田/林场/磨坊，繁荣度以 6~8 分/60tick 慢爬，60 tick Δ 恒 ≥1.0，
  // 停滞口径在结构上永远抓不到，直到进入平台期才触发（P4 实测：Lv2@36 → T1@245）。
  // ⚠ 仅 t1Condition 使用（OR 叠加），t2Condition 仍走纯停滞口径——不可直接调 stagnationDelta，
  //    否则 T2 缺「无食肆」护城河会误弹（见 08 建议稿 §5 陷阱①）。
  // 标定依据 scratch/calibrate-hint-growth.mjs（11 局回放，30 tick 粒度结构近似）：
  //   慢爬型 ≤8/60tick；快玩家（徘徊 64~100 tick）最小窗口 Δ = 12.2/60tick。
  //   取 10 → 两侧各留 1.25 / 2.2 分裕度（取 12 时上侧裕度仅 0.2，过紧）。
  growthWindow: 60,
  growthDelta: 10,

  // T2 空屋过度：空置民居容量阈值（housingCapacity − population ≥ 6，约 3 间空茅舍当量）
  vacantCapacityThreshold: 6,

  // T0 开局引导：tick 达到此值且仍零建筑时触发（针对 P3-G1 开局静默 30+ tick）
  t0Tick: 20,

  // 提示条呈现节流：同一提示每局至多出现一次（关闭或消解后不复发）
  oncePerRun: true,
};
