// telemetry 记录器单测：里程碑精确性、断链首次性、采样间隔、reset 清空、导出契约
// 纪律：telemetry 是只读观察者，所有用例同时断言「不污染 state」
import { describe, it, expect, beforeEach } from 'vitest';
import { createInitialState } from '../src/core/state.js';
import { tick, computeProsperity } from '../src/core/simulation.js';
import { placeBuilding } from '../src/core/grid.js';
import {
  collect,
  recordSpeedChange,
  recordHint,
  getTelemetryData,
  reset,
  restore,
  serialize,
  buildExportPayload,
  buildSummary,
  tickToMinutes,
  buildingName,
  SAMPLE_INTERVAL,
} from '../src/core/telemetry.js';
import { findSpot } from './helpers.js';
import { RULES } from '../src/config/rules.js';

let state;

beforeEach(() => {
  reset();
  state = createInitialState();
});

function runTicks(n) {
  for (let i = 0; i < n; i++) {
    tick(state);
    collect(state);
  }
}

describe('里程碑（M1~M3）', () => {
  it('繁荣度首次过阈值时记录精确 tick，且只记首次', () => {
    // 直接构造繁荣度：瓦屋（3 分）×7 = 21 ≥ 20 → Lv2。先补足资源绕过造价限制
    state.level = 3; // 解锁瓦屋（placeBuilding 校验 unlockLevel）
    state.money = 1000;
    state.resources.wood = 500;
    for (let i = 0; i < 7; i++) {
      const spot = findSpot(state, null, 1, 1);
      placeBuilding(state, 'house', spot.x, spot.y);
    }
    state.population.count = 28; // P2：民居按入住率计分，住满（容量 7×4）才计全额
    expect(computeProsperity(state)).toBe(21);
    runTicks(3); // tick 1 时繁荣度即 21 ≥ 20 → lv2 应记 tick 1
    const d = getTelemetryData();
    expect(d.milestones.lv2).toBe(1);
    expect(d.milestones.lv3).toBeNull();
    expect(d.milestones.lv4).toBeNull();
  });

  it('繁荣度回落再回升不覆盖已记录的里程碑（首次性）', () => {
    state.prosperity = 20;
    collect(state); // tick 0 记 lv2
    state.prosperity = 15;
    collect(state); // 回落
    state.prosperity = 25;
    collect(state); // 再回升
    expect(getTelemetryData().milestones.lv2).toBe(0);
  });

  it('Lv4 首达瞬间记录 finalSnapshot（含税/商业收入），且只记一次', () => {
    state.prosperity = RULES.unlockThresholds[3];
    state.level = 4;
    state.population.count = 10;
    collect(state);
    let d = getTelemetryData();
    expect(d.milestones.lv4).toBe(0);
    expect(d.finalSnapshot).not.toBeNull();
    expect(d.finalSnapshot.households).toBe(10);
    expect(d.finalSnapshot.taxIncome).toBeCloseTo(0.5, 5); // 10 户 × 0.05
    expect(d.finalSnapshot.commerceIncome).toBe(0); // 无产钱建筑
    expect(d.finalSnapshot.buildingCount).toBe(0);

    // 后续 tick 不再覆盖
    state.tick = 50;
    state.prosperity = RULES.unlockThresholds[3] + 20;
    collect(state);
    d = getTelemetryData();
    expect(d.finalSnapshot.tick).toBe(0);
  });

  it('未通关时 finalSnapshot 为 null', () => {
    runTicks(10);
    expect(getTelemetryData().finalSnapshot).toBeNull();
  });
});

describe('断链（chainBreaks）', () => {
  it('建筑首次 idle 记录 { tick, buildingType, kind }，同一实例只记第一次', () => {
    const spot = findSpot(state, null, 2, 2);
    const mill = placeBuilding(state, 'mill', spot.x, spot.y).building;
    state.population.count = 0; // 无劳力 → labor
    state.resources.grain = 10;

    runTicks(5);
    let d = getTelemetryData();
    expect(d.chainBreaks).toHaveLength(1);
    expect(d.chainBreaks[0]).toEqual({ tick: 1, buildingType: 'mill', kind: 'labor' });

    // 持续 idle 不重复记录
    runTicks(10);
    d = getTelemetryData();
    expect(d.chainBreaks).toHaveLength(1);

    // 恢复后再次 idle：同一实例仍不重复记录
    state.population.count = 4;
    runTicks(3);
    state.population.count = 0;
    runTicks(3);
    d = getTelemetryData();
    expect(d.chainBreaks).toHaveLength(1);
    expect(mill.idle).toBe(true); // 确认当前确实处于 idle（记录器没漏采）
  });

  it('缺料记 material，缺人记 labor，不同实例分别记录', () => {
    const s1 = findSpot(state, null, 2, 2);
    placeBuilding(state, 'mill', s1.x, s1.y); // 缺料（grain=0）
    const s2 = findSpot(state, null, 2, 2);
    placeBuilding(state, 'mill', s2.x, s2.y);
    state.population.count = 1; // 只够 1 座磨坊的劳力 → 第二座缺人
    state.resources.grain = 0;

    runTicks(2);
    const d = getTelemetryData();
    expect(d.chainBreaks).toHaveLength(2);
    const kinds = d.chainBreaks.map((c) => c.kind).sort();
    expect(kinds).toEqual(['labor', 'material']);
    expect(d.chainBreaks.every((c) => c.buildingType === 'mill')).toBe(true);
  });
});

describe('采样（samples）', () => {
  it(`每 ${SAMPLE_INTERVAL} tick 一条快照，字段齐全`, () => {
    runTicks(SAMPLE_INTERVAL * 3 + 5); // tick 30 / 60 / 90 三条
    const d = getTelemetryData();
    expect(d.samples).toHaveLength(3);
    expect(d.samples.map((s) => s.tick)).toEqual([30, 60, 90]);
    const keys = [
      'tick', 'money', 'wood', 'grain', 'food', 'goods',
      'households', 'housingCapacity', 'laborDemand',
      'prosperity', 'level', 'buildingCount', 'buildingBreakdown',
      'scarcityMaterial', 'scarcityLabor',
    ];
    for (const s of d.samples) {
      for (const k of keys) expect(s).toHaveProperty(k);
    }
  });

  it('快照值与 state 一致（只读观察者，不写 state）', () => {
    const spot = findSpot(state, null, 1, 1);
    placeBuilding(state, 'hut', spot.x, spot.y);
    state.population.count = 2;
    runTicks(SAMPLE_INTERVAL);
    const s = getTelemetryData().samples[0];
    expect(s.buildingCount).toBe(1);
    expect(s.households).toBe(2);
    expect(s.housingCapacity).toBe(2); // 茅舍 capacity 2
    expect(s.laborDemand).toBe(0);
    expect(s.buildingBreakdown).toEqual({ hut: 1 });
    expect(state.tick).toBe(SAMPLE_INTERVAL); // state 未被记录器篡改
  });
});

describe('变速（speedChanges）', () => {
  it('记录 { tick, to } 并推导 usedFastForward', () => {
    recordSpeedChange(0, 10); // 暂停
    recordSpeedChange(1, 15);
    const d = getTelemetryData();
    expect(d.speedChanges).toEqual([
      { tick: 10, to: 0 },
      { tick: 15, to: 1 },
    ]);
    expect(d.usedFastForward).toBe(false);

    recordSpeedChange(2, 100);
    expect(getTelemetryData().usedFastForward).toBe(true);
  });
});

describe('逐帧稀缺标记（D-N2-4）', () => {
  it('缺料/缺人 tick 分别记入 materialTicks/laborTicks，无稀缺 tick 不记', () => {
    const a = findSpot(state, null, 2, 2);
    placeBuilding(state, 'mill', a.x, a.y); // 拿到劳力但缺料 → material
    const b = findSpot(state, null, 2, 2);
    placeBuilding(state, 'mill', b.x, b.y); // 无劳力 → labor
    state.population.count = 1;
    state.resources.grain = 0;
    runTicks(2);
    const d = getTelemetryData();
    expect(d.scarcity.materialTicks).toEqual([1, 2]);
    expect(d.scarcity.laborTicks).toEqual([1, 2]);
  });

  it('无稀缺的 tick 不记录（空转帧 = 并集之外）', () => {
    const s = findSpot(state, 'fertile', 2, 2);
    placeBuilding(state, 'farm', s.x, s.y); // 恒计分建筑不闲置
    state.population.count = 2;
    runTicks(3);
    const d = getTelemetryData();
    expect(d.scarcity.materialTicks).toEqual([]);
    expect(d.scarcity.laborTicks).toEqual([]);
  });

  it('samples 附带窗口内稀缺计数，且落盘后清零', () => {
    const a = findSpot(state, null, 2, 2);
    placeBuilding(state, 'mill', a.x, a.y);
    state.population.count = 0; // 持续缺人
    state.resources.grain = 10;
    runTicks(SAMPLE_INTERVAL); // 30 tick 全缺人
    expect(getTelemetryData().samples[0].scarcityLabor).toBe(SAMPLE_INTERVAL);
    expect(getTelemetryData().samples[0].scarcityMaterial).toBe(0);
    // 下一窗口无稀缺 → 计数归零
    state.population.count = 4;
    runTicks(SAMPLE_INTERVAL);
    expect(getTelemetryData().samples[1].scarcityLabor).toBe(0);
  });

  it('serialize → restore 往返保留 scarcity；旧档缺失 scarcity 字段可恢复（缺省空数组）', () => {
    const a = findSpot(state, null, 2, 2);
    placeBuilding(state, 'mill', a.x, a.y);
    state.population.count = 0;
    runTicks(5);
    const saved = serialize();
    reset();
    expect(restore(JSON.parse(JSON.stringify(saved)))).toBe(true);
    expect(getTelemetryData().scarcity.materialTicks).toEqual([]);
    expect(getTelemetryData().scarcity.laborTicks).toEqual([1, 2, 3, 4, 5]);

    // 旧档（v1.1/v1.2 无 scarcity）：剔除字段后仍可恢复，缺省空数组
    reset();
    const legacy = JSON.parse(JSON.stringify(saved));
    delete legacy.scarcity;
    expect(restore(legacy)).toBe(true);
    expect(getTelemetryData().scarcity).toEqual({ materialTicks: [], laborTicks: [] });

    // scarcity 存在但格式非法 → 拒绝
    reset();
    const bad = JSON.parse(JSON.stringify(saved));
    bad.scarcity = { materialTicks: 'x', laborTicks: [] };
    expect(restore(bad)).toBe(false);
  });

  it('reset 清空 scarcity', () => {
    const a = findSpot(state, null, 2, 2);
    placeBuilding(state, 'mill', a.x, a.y);
    state.population.count = 0;
    runTicks(2);
    reset();
    const d = getTelemetryData();
    expect(d.scarcity).toEqual({ materialTicks: [], laborTicks: [] });
  });
});

describe('UX-3 提示事件（hints）', () => {
  it('recordHint 记录 { tick, id, action }，getTelemetryData 深拷贝', () => {
    recordHint('t1', 'shown', 100);
    recordHint('t1', 'resolved', 130);
    recordHint('t2', 'dismissed', 140);
    const d = getTelemetryData();
    expect(d.hints).toEqual([
      { tick: 100, id: 't1', action: 'shown' },
      { tick: 130, id: 't1', action: 'resolved' },
      { tick: 140, id: 't2', action: 'dismissed' },
    ]);
    // 深拷贝：改外部结果不影响内部
    d.hints[0].tick = 999;
    expect(getTelemetryData().hints[0].tick).toBe(100);
  });

  it('hints 进入导出契约（additive 超集字段）', () => {
    recordHint('t0', 'shown', 20);
    const payload = buildExportPayload({ gameBuild: 'x', exportedAt: 'y' });
    expect(payload.hints).toEqual([{ tick: 20, id: 't0', action: 'shown' }]);
  });

  it('serialize → restore 往返保留 hints；旧档缺失 hints 字段可恢复（缺省空数组）', () => {
    recordHint('t1', 'shown', 50);
    const saved = serialize();
    reset();
    expect(restore(JSON.parse(JSON.stringify(saved)))).toBe(true);
    expect(getTelemetryData().hints).toEqual([{ tick: 50, id: 't1', action: 'shown' }]);

    // 旧档（无 hints 字段）：剔除后仍可恢复，缺省空数组（07 草案 C-6）
    reset();
    const legacy = JSON.parse(JSON.stringify(saved));
    delete legacy.hints;
    expect(restore(legacy)).toBe(true);
    expect(getTelemetryData().hints).toEqual([]);
  });

  it('reset 清空 hints', () => {
    recordHint('t1', 'shown', 1);
    reset();
    expect(getTelemetryData().hints).toEqual([]);
  });
});

describe('reset', () => {
  it('清空全部采集数据', () => {
    state.prosperity = 20;
    collect(state);
    recordSpeedChange(2, 5);
    runTicks(SAMPLE_INTERVAL);

    reset();
    const d = getTelemetryData();
    expect(d.milestones).toEqual({ lv2: null, lv3: null, lv4: null });
    expect(d.chainBreaks).toEqual([]);
    expect(d.samples).toEqual([]);
    expect(d.finalSnapshot).toBeNull();
    expect(d.speedChanges).toEqual([]);
    expect(d.usedFastForward).toBe(false);
  });

  it('reset 后断链首次性重新生效（新局的建筑重新可记录）', () => {
    const spot = findSpot(state, null, 2, 2);
    placeBuilding(state, 'mill', spot.x, spot.y);
    state.population.count = 0;
    runTicks(2);
    expect(getTelemetryData().chainBreaks).toHaveLength(1);

    reset();
    runTicks(2);
    // 同一实例在 reset 后重新记录（新局语义）
    expect(getTelemetryData().chainBreaks).toHaveLength(1);
  });
});

describe('导出契约（playtest-protocol@1.3 §4.2：扁平结构）', () => {
  it('buildExportPayload 顶层字段与协议对齐，无 session 包装层', () => {
    state.prosperity = RULES.unlockThresholds[3];
    state.level = 4;
    collect(state);
    recordSpeedChange(1, 0);
    const payload = buildExportPayload({
      gameBuild: '3338e97-dirty',
      gameBuildDirty: true,
      exportedAt: '2026-10-18T10:00:00.000Z',
      playerProfile: 'normal',
      paceVerdict: 'ok',
      notes: '测试备注',
    });
    expect(Object.keys(payload)).toEqual([
      'protocol', 'gameBuild', 'gameBuildDirty', 'exportedAt', 'playerProfile', 'paceVerdict',
      'notes', 'milestones', 'chainBreaks', 'scarcity', 'samples', 'finalSnapshot', 'speedChanges',
      'hints', 'usedFastForward',
    ]);
    expect(payload.protocol).toBe('playtest-protocol@1.3');
    expect(payload.gameBuild).toBe('3338e97-dirty');
    expect(payload.gameBuildDirty).toBe(true);
    expect(payload.exportedAt).toBe('2026-10-18T10:00:00.000Z');
    expect(payload.milestones.lv4).toBe(0);
    expect(payload.playerProfile).toBe('normal');
    expect(payload.paceVerdict).toBe('ok');
    expect(payload.notes).toBe('测试备注');
    expect(payload.session).toBeUndefined(); // 无嵌套包装
  });

  it('主观项缺省为 null/空串（可不选）', () => {
    const payload = buildExportPayload({ gameBuild: 'x', exportedAt: 'y' });
    expect(payload.playerProfile).toBeNull();
    expect(payload.paceVerdict).toBeNull();
    expect(payload.notes).toBe('');
  });

  it('gameBuildDirty：构建指纹的 dirty 标记可机读，缺省 false 且强制布尔', () => {
    // 缺省（调用方未传）→ false
    expect(buildExportPayload({ gameBuild: 'abc1234', exportedAt: 'y' }).gameBuildDirty).toBe(false);
    // 显式传 true → true
    expect(
      buildExportPayload({ gameBuild: 'abc1234-dirty', gameBuildDirty: true, exportedAt: 'y' })
        .gameBuildDirty
    ).toBe(true);
    // 非布尔真值一律收敛为布尔，避免分析脚本被字符串 'true' 坑到
    expect(
      buildExportPayload({ gameBuild: 'x', gameBuildDirty: 'yes', exportedAt: 'y' }).gameBuildDirty
    ).toBe(false);
  });

  it('finalSnapshot 含 taxIncome / commerceIncome / buildingBreakdown', () => {
    state.prosperity = RULES.unlockThresholds[3];
    state.level = 4;
    state.population.count = 10;
    const spot = findSpot(state, null, 1, 1);
    placeBuilding(state, 'hut', spot.x, spot.y);
    collect(state);
    const fs = getTelemetryData().finalSnapshot;
    expect(fs.taxIncome).toBeCloseTo(0.5, 5); // 10 户 × 0.05
    expect(fs.commerceIncome).toBe(0);
    expect(fs.buildingBreakdown).toEqual({ hut: 1 });
  });
});

describe('持久化往返（serialize / restore）', () => {
  it('serialize → restore 后数据一致，断链首次性保留', () => {
    const spot = findSpot(state, null, 2, 2);
    placeBuilding(state, 'mill', spot.x, spot.y);
    state.population.count = 0;
    runTicks(SAMPLE_INTERVAL + 5);
    recordSpeedChange(2, 40);
    state.prosperity = RULES.unlockThresholds[3];
    state.level = 4;
    collect(state);

    const before = getTelemetryData();
    const saved = serialize();

    reset();
    expect(restore(JSON.parse(JSON.stringify(saved)))).toBe(true);
    const after = getTelemetryData();
    expect(after).toEqual(before);

    // 恢复后同一实例再次 idle 仍不重复记录
    runTicks(3);
    expect(getTelemetryData().chainBreaks).toHaveLength(before.chainBreaks.length);
  });

  it('restore 非法数据返回 false 且保持现状', () => {
    runTicks(SAMPLE_INTERVAL);
    const before = getTelemetryData();
    expect(restore(null)).toBe(false);
    expect(restore({})).toBe(false);
    expect(restore({ milestones: { lv2: 'x', lv3: null, lv4: null }, chainBreaks: [], samples: [], speedChanges: [], recordedBreakIds: [] })).toBe(false);
    expect(getTelemetryData()).toEqual(before);
  });
});

describe('面板摘要辅助', () => {
  it('buildSummary：tick 换算分钟、终局户数/建筑数', () => {
    state.prosperity = RULES.unlockThresholds[3];
    state.level = 4;
    state.population.count = 12;
    const spot = findSpot(state, null, 1, 1);
    placeBuilding(state, 'hut', spot.x, spot.y);
    collect(state);
    const s = buildSummary();
    expect(s.milestones.lv4).toEqual({ tick: 0, minutes: 0 });
    expect(s.finalHouseholds).toBe(12);
    expect(s.finalBuildingCount).toBe(1);
    expect(s.usedFastForward).toBe(false);
  });

  it('tickToMinutes 与 buildingName', () => {
    expect(tickToMinutes(300)).toBe(5);
    expect(tickToMinutes(286)).toBe(4.8);
    expect(tickToMinutes(null)).toBeNull();
    expect(buildingName('mill')).toBe('磨坊');
    expect(buildingName('unknown-type')).toBe('unknown-type');
  });
});
