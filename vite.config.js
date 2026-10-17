import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// ---------- 构建指纹（遥测 gameBuild 字段的注入源） ----------
// B3 修复：此前 src/main.js 直接回退到硬编码的 '3338e97'，导致所有局的导出 JSON
// 版本号完全相同，遥测丧失版本区分能力。指纹改为构建期从 git 实读。
// 纪律：只在 vite.config.js（构建期，Node 环境）执行 git；客户端代码绝不跑 git 命令。
function git(args) {
  try {
    return execSync(`git ${args}`, {
      stdio: ['ignore', 'pipe', 'pipe'], // 不继承 stdio：git 报错不污染构建输出
      windowsHide: true, // Windows 下不闪控制台窗口
      timeout: 5000, // 极端情况（大仓库/网络盘）不得把构建挂死
    })
      .toString()
      .trim();
  } catch {
    return null; // git 缺失 / 不在仓库 / 命令抛错：一律降级，不让构建失败
  }
}

// 降级值必须是「一眼看出不可用」的哨兵（'unknown'），绝不能用看起来像真 commit 的字符串：
// 一个看起来合法的假值比明显的错误值危险得多（B3 正是栽在这里）。
function resolveBuildFingerprint() {
  const rev = git('rev-parse --short HEAD');
  if (!rev) return { build: 'unknown', dirty: false };

  const porcelain = git('status --porcelain');
  // 拿不到工作区状态时按「脏」处理：宁可多报一次，也不能把可能的未提交改动标成干净。
  const dirty = porcelain == null || porcelain.length > 0;
  return { build: dirty ? `${rev}-dirty` : rev, dirty };
}

const { build: GAME_BUILD, dirty: GAME_BUILD_DIRTY } = resolveBuildFingerprint();
if (!process.env.VITEST) {
  console.log(`[vite] gameBuild = ${GAME_BUILD}（dirty=${GAME_BUILD_DIRTY}）`);
}

export default defineConfig({
  base: './',
  // 双通道注入：① import.meta.env.VITE_GAME_BUILD（语义清晰，dev/build 均生效）；
  // ② __GAME_BUILD__/__GAME_BUILD_DIRTY__（普通标识符，兜底防某个通道未替换）。
  define: {
    'import.meta.env.VITE_GAME_BUILD': JSON.stringify(GAME_BUILD),
    'import.meta.env.VITE_GAME_BUILD_DIRTY': JSON.stringify(GAME_BUILD_DIRTY),
    __GAME_BUILD__: JSON.stringify(GAME_BUILD),
    __GAME_BUILD_DIRTY__: JSON.stringify(GAME_BUILD_DIRTY),
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // tests/verification/ 是独立验收基准（重复校验设计案原始数值，单独维护），
    // 不进默认 test 命令；如需运行：npx vitest run tests/verification
    exclude: ['**/node_modules/**', 'tests/verification/**'],
  },
});
