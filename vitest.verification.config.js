// 独立验收套件专用配置：验收基准与开发自测分离，互不污染。
// 用法：npx vitest run --config vitest.verification.config.js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/verification/**/*.test.js'],
  },
});
