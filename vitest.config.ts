import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    // エージェントランタイムは独自のvitest設定を持つ（amplify/agent/runtime/vitest.config.ts）
    exclude: ['**/node_modules/**', 'amplify/**'],
  },
});
