// 检查「上界证明」用例（progression.test.js:77-105）在 P-1′ 恒计分封顶下是否仍成立
import { BUILDINGS } from '../src/config/buildings.js';
import { RULES } from '../src/config/rules.js';
const budget = RULES.initialMoney;
function bestWith(cap) {
  let best = 0, arg = null;
  for (let hut = 0; hut <= 24; hut++)
    for (let farm = 0; farm <= 16; farm++)
      for (let forest = 0; forest <= 16; forest++)
        for (let mill = 0; mill <= 8; mill++) {
          const money = hut*10 + farm*15 + forest*15 + mill*30;
          if (money > budget) continue;
          const raw = hut*1 + farm*2 + forest*2 + mill*4;
          const passive = farm*2 + forest*2;
          const s = cap == null ? raw : Math.min(passive, cap) + hut*1 + mill*4;
          if (s > best) { best = s; arg = {hut,farm,forest,mill,money}; }
        }
  return { best, arg };
}
const lv2 = RULES.unlockThresholds[1];
console.log('Lv2 阈值 =', lv2, '｜初始铜钱预算 =', budget);
for (const cap of [null, 24, 20]) {
  const { best, arg } = bestWith(cap);
  console.log(`封顶 ${cap ?? '无'} → 上界 = ${best}（最优解 ${JSON.stringify(arg)}）｜断言 best >= ${lv2} → ${best >= lv2 ? 'PASS' : 'FAIL'}`);
}
