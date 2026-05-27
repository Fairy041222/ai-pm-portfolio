import type { Message } from '@/types';

/** 将各类时间戳统一为 24 小时制 HH:MM */
export function formatMessageTimestamp(timestamp: string): string {
  const t = timestamp.trim();
  const hm = t.match(/(\d{1,2}):(\d{2})/);
  if (hm) {
    return `${hm[1].padStart(2, '0')}:${hm[2]}`;
  }
  const parsed = Date.parse(t);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return t;
}

/** 助手消息底部模型提示文案 */
export function getAssistantModelLabel(message: Message): string | null {
  if (message.role !== 'assistant' || message.type === 'report') {
    return null;
  }
  const name = message.usedModelName?.trim();
  if (!name) return null;
  if (message.usedDefaultModel) {
    return `当前使用默认模型：${name}`;
  }
  return `使用模型：${name}`;
}
