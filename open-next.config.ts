import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// Minimal config: umami 的页面几乎全是动态 SSR（build 日志里 117 路由全部 ƒ），
// 用不到增量缓存，先不挂 R2。若将来出现 ISR/SSG 需求，再加：
//   import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache';
//   incrementalCache: r2IncrementalCache,
// OpenNext 默认会执行 `pnpm build`（含 check-db 连库、build-geo 下 ~63MB mmdb），不适合 Workers。
// 覆盖 buildCommand，改跑 CF 安全构建：只生成 prisma client + tracker/recorder + next build。
export default {
  ...defineCloudflareConfig({}),
  buildCommand: 'pnpm run build:cf-app',
};
