// 模拟循环：tick 推进、生产链结算、人口、繁荣度
// 每 tick 结算顺序固定（保证确定性）：
//   1. 建筑产出/消耗（食链优先分劳力 → 其余建筑，同优先级按建造顺序；再验原料）
//   2. 市税（按在城户数，不受运转系数影响）
//   3. 人口（耗食 → 迁入/迁出，迁出受保底人口下限约束）
//   4. 繁荣度与解锁等级
import { BUILDINGS } from '../config/buildings.js';
import { RULES } from '../config/rules.js';

// 存储容量：基础值 + 粮仓加成（粮仓为被动建筑，闲置也生效）
export function computeCaps(state) {
  const caps = { grain: RULES.baseCaps.grain, food: RULES.baseCaps.food };
  const granaries = state.buildings.filter((b) => b.type === 'granary').length;
  caps.grain += granaries * RULES.granaryBonus.grain;
  caps.food += granaries * RULES.granaryBonus.food;
  return caps;
}

export function housingCapacity(state) {
  return state.buildings.reduce((sum, b) => sum + (BUILDINGS[b.type].capacity ?? 0), 0);
}

export function laborDemand(state) {
  return state.buildings.reduce((sum, b) => sum + (BUILDINGS[b.type].workers ?? 0), 0);
}

function addResource(state, caps, res, amount) {
  const cap = caps[res];
  const next = state.resources[res] + amount;
  state.resources[res] = cap != null ? Math.min(next, cap) : next;
}

// 结算优先级：维系人口存续的食物链排在最前（产粮 → 产食），
// 其余加工/商业排在其后。避免劳力紧张时商业（如食肆）抢先占人导致磨坊停产、
// 食断供又诱发人口流失的死锁。同优先级内按建造先后结算，保证确定性。
function settlePriority(def) {
  const outs = def.outputs ?? {};
  if ('grain' in outs) return 0;
  if ('food' in outs) return 1;
  return 2;
}

function settlementOrder(state) {
  return state.buildings
    .map((b, index) => ({ b, index }))
    .sort((x, y) => {
      const d = settlePriority(BUILDINGS[x.b.type]) - settlePriority(BUILDINGS[y.b.type]);
      return d !== 0 ? d : x.index - y.index;
    })
    .map((e) => e.b);
}

// 步骤 1：建筑产出/消耗
function settleProduction(state) {
  const caps = computeCaps(state);
  let laborPool = state.population.count;

  for (const b of settlementOrder(state)) {
    const def = BUILDINGS[b.type];
    b.idle = false;
    b.idleReason = null;

    // 民居/粮仓无生产，恒为正常
    if (def.workers === 0 && Object.keys(def.inputs).length === 0 && Object.keys(def.outputs).length === 0)
      continue;

    // 先分劳力：劳力不足 → 停产（黄）
    if (def.workers > 0) {
      if (laborPool >= def.workers) {
        laborPool -= def.workers;
      } else {
        b.idle = true;
        b.idleReason = 'labor';
        continue;
      }
    }

    // 再验原料：原料不足 → 停产（红），已占用的劳力不返还（本 tick 空转）
    const lacks = Object.entries(def.inputs).filter(([res, n]) => state.resources[res] < n);
    if (lacks.length > 0) {
      b.idle = true;
      b.idleReason = 'material';
      continue;
    }

    for (const [res, n] of Object.entries(def.inputs)) state.resources[res] -= n;
    for (const [res, n] of Object.entries(def.outputs)) {
      if (res === 'money') state.money += n;
      else addResource(state, caps, res, n);
    }
  }
}

// 市税：每户每 tick 的保底收入。
// 计税基数 = 在城户数（state.population.count），不是民居空置容量：空置民居不计税，
// 否则「建空茅舍 = 印钞机」，经济被压平。
// 不受运转系数（正常 1.0 / 闲置 0）影响：建筑停产也照常按户收税，
// 这条收入是「铜钱耗尽」不可恢复态的唯一逃生通道。
export function taxIncome(state) {
  return state.population.count * RULES.tax.perHouseholdPerTick;
}

// 商业收入：食肆/杂货摊等产钱建筑本 tick 实际产出的铜钱（停产则不计）
export function commerceIncome(state) {
  return state.buildings.reduce((sum, b) => {
    if (b.idle) return sum; // 缺料/缺人停产，本 tick 未产钱
    return sum + (BUILDINGS[b.type].outputs?.money ?? 0);
  }, 0);
}

// 步骤 2：市税结算（基数取本 tick 初的在城户数）
function settleTax(state) {
  state.money += taxIncome(state); // 浮点累计，显示层负责向下取整
}

// 步骤 3：人口耗食与迁入迁出
function settlePopulation(state) {
  const pop = state.population;
  const res = state.resources;

  // 每户每 tick 消耗 0.1 食
  if (pop.count > 0) {
    res.food = Math.max(0, res.food - pop.count * RULES.foodPerHouseholdPerTick);
  }

  // 食耗尽计时
  if (res.food <= 0 && pop.count > 0) pop.starveTicks += 1;
  else if (res.food > 0) pop.starveTicks = 0;

  // 迁入：有空房且食库存 > 安全线，每 5 tick 1 户
  const vacant = housingCapacity(state) - pop.count;
  if (
    state.tick % RULES.moveInInterval === 0 &&
    vacant > 0 &&
    res.food > RULES.foodSafetyLine
  ) {
    pop.count += 1;
  }

  // 迁出：食耗尽持续超过宽限 tick，每 5 tick 1 户；但不得低于保底人口
  if (
    pop.count > RULES.minPopulation &&
    pop.starveTicks >= RULES.starveGraceTicks &&
    state.tick % RULES.moveOutInterval === 0
  ) {
    pop.count -= 1;
  }
}

// 步骤 4：繁荣度（单一公式，透明可算；02-pacing-tuning.md P1/P2）
//   繁荣度 = Σ[非民居建筑：基础分 × 运转系数（正常 1.0 / 闲置 0）]
//          + Σ[民居基础分] × min(1, 在城户数 / 民居总容量)   // 容量为 0 时入住率按 0
// 设计意图：繁荣度只奖励「活着的城市」——断链/闲置建筑不计分（P1）、空屋按入住率折算（P2），
// 堵死「用铜钱直接购买繁荣度」的两个刷分口。农田/林场本就不会闲置、粮仓为被动建筑，维持恒计分。
export function computeProsperity(state) {
  const c = RULES.prosperityCoef;
  let working = 0; // 非民居（生产/存储/原料）：运转才计分
  let housingScore = 0; // 民居（茅舍/瓦屋）基础分合计
  let housingCap = 0;
  for (const b of state.buildings) {
    const def = BUILDINGS[b.type];
    if (def.capacity > 0) {
      housingScore += def.score;
      housingCap += def.capacity;
    } else {
      working += def.score * (b.idle ? c.idle : c.active);
    }
  }
  const occupancy = housingCap > 0 ? Math.min(1, state.population.count / housingCap) : 0;
  return working + housingScore * occupancy;
}

export function computeLevel(prosperity) {
  let level = 1;
  RULES.unlockThresholds.forEach((th, i) => {
    if (prosperity >= th) level = i + 1;
  });
  return level;
}

// 解锁判定等级（P3 解锁粘性）：瞬时等级与历史最高等级（maxLevel，只升不降）取大者。
// core 放置校验与 UI 建造菜单统一以此为准（core 是规则唯一权威）；
// 繁荣度进度条/HUD 仍显示瞬时 state.level。
export function unlockedLevel(state) {
  return Math.max(state.level, state.maxLevel ?? state.level);
}

// 推进一个 tick。tick 计数先自增，所有周期判断基于自增后的值。
export function tick(state) {
  state.tick += 1;
  settleProduction(state);
  settleTax(state);
  settlePopulation(state);
  state.prosperity = computeProsperity(state);
  state.level = computeLevel(state.prosperity);
  // 解锁粘性（P3）：maxLevel 只升不降。断链/人口流失导致的繁荣度回落只影响
  // 进度条数值，不回收已解锁内容——杜绝「刚解锁又锁回去」的体验回退。
  state.maxLevel = Math.max(state.maxLevel ?? state.level, state.level);
}
