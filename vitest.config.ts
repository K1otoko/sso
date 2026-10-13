import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: './test/global-setup.ts',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 集成 / e2e 共用远程测试库（sso_test），串行执行避免相互干扰
    fileParallelism: false,
  },
});
