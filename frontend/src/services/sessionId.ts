/** 浏览器持久会话 ID，供后端 [SECURITY] 日志关联。 */

const SESSION_KEY = 'aipm-bench-session-id';

export function getOrCreateSessionId(): string {
  try {
    const existing = localStorage.getItem(SESSION_KEY);
    if (existing?.trim()) return existing.trim();
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? `sess_${crypto.randomUUID()}`
        : `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(SESSION_KEY, id);
    return id;
  } catch {
    return `sess_fallback_${Date.now()}`;
  }
}
