/** 为 true 时使用本地 mock，不请求后端 */
export const USE_MOCK_API =
  import.meta.env.VITE_USE_MOCK_API === 'true' ||
  import.meta.env.VITE_USE_MOCK_API === '1';

/** API 基路径（开发环境通常 /api，由 Vite 代理到 FastAPI） */
export const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';
