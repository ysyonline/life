import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // tests/verification/ 是独立验收基准（重复校验设计案原始数值，单独维护），
    // 不进默认 test 命令；如需运行：npx vitest run tests/verification
    exclude: ['**/node_modules/**', 'tests/verification/**'],
  },
});
