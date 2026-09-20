import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig(({ mode }) => {
  // .env 位于仓库根（apps/web 的上两级），显式指定 envDir 让 loadEnv 读取到 CSTUDIO_PORT
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const env = loadEnv(mode, repoRoot, '');
  // 端口单一来源：.env / 进程环境的 CSTUDIO_PORT，回退 3001（与 server env.ts 默认值一致）
  const apiPort = env.CSTUDIO_PORT || process.env.CSTUDIO_PORT || '3001';
  const apiTarget = `http://127.0.0.1:${apiPort}`;
  // Web dev 端口：.env 的 CSTUDIO_WEB_PORT，回退 5273（避开 Vite 默认 5173/5174 递增冲突链）
  const webPort = Number(env.CSTUDIO_WEB_PORT || process.env.CSTUDIO_WEB_PORT || '5273');

  return {
    plugins: [vue()],
    server: {
      // 独占端口：默认 5273（远离 Vite 5173/5174 常见冲突链），可用 CSTUDIO_WEB_PORT 覆盖；仅绑 IPv4 localhost
      host: '127.0.0.1',
      port: webPort,
      strictPort: true,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        '/socket.io': { target: apiTarget, ws: true },
      },
    },
  };
});
