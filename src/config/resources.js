// 资源定义：名称、初始量、是否入库显示
// 注意：铜钱(money)按技术方案存于 state.money，不在 resources 表内。
// 初始量由 rules.js 统一给出，此处不再重复维护数值。
import { RULES } from './rules.js';

export const RESOURCES = {
  grain: { name: '粮', initial: RULES.initialResources.grain, show: true },
  wood: { name: '木材', initial: RULES.initialResources.wood, show: true },
  food: { name: '食', initial: RULES.initialResources.food, show: true },
  goods: { name: '器', initial: RULES.initialResources.goods, show: true },
};

export const INITIAL_MONEY = RULES.initialMoney;
