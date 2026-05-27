import type { Conversation } from '@/types';

/** 无任何消息的空对话（用于复用，避免重复创建「新对话」） */
export function isEmptyNewConversation(conv: Conversation): boolean {
  return conv.messages.length === 0;
}

/** 是否为「生成报告」类触发语，不应用作历史对话标题 */
export function isReportTriggerContent(content: string): boolean {
  return /生成报告|测试模型|对比评测|模型对比|大模型性能对比|性能对比报告/i.test(
    content.trim(),
  );
}

/** 是否为应隐藏的历史对话（错误地将报告标题写入普通对话） */
export function isReportOnlyConversation(conv: Conversation): boolean {
  const title = conv.title.trim();
  if (/^大模型性能对比报告(\.pdf)?$/i.test(title)) return true;

  const userMessages = conv.messages.filter((m) => m.role === 'user');
  if (userMessages.length === 0) return false;

  const hasReportMessage = conv.messages.some((m) => m.type === 'report');
  const allUserMessagesAreReportTriggers = userMessages.every((m) =>
    isReportTriggerContent(m.content),
  );

  return hasReportMessage && allUserMessagesAreReportTriggers && userMessages.length <= 1;
}

/** 根据用户首条消息生成对话标题 */
export function deriveConversationTitle(content: string, fallback = '新对话'): string {
  const trimmed = content.trim();
  if (!trimmed || isReportTriggerContent(trimmed)) {
    return fallback;
  }
  return trimmed.length > 16 ? `${trimmed.slice(0, 16)}...` : trimmed;
}

/** 解析对话 date 字段（YYYY-MM-DD HH:mm）为时间戳 */
export function parseConversationDate(date: string): number {
  const s = date.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/.exec(s);
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
    ).getTime();
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * 历史对话排序：空对话（未发送消息）固定在最前，其余按 date 倒序（最新在上）。
 */
export function sortConversationsByRecency(conversations: Conversation[]): Conversation[] {
  const empties = conversations.filter(isEmptyNewConversation);
  const nonEmpty = conversations.filter((c) => !isEmptyNewConversation(c));
  const byDateDesc = (a: Conversation, b: Conversation) =>
    parseConversationDate(b.date) - parseConversationDate(a.date);
  return [...empties.sort(byDateDesc), ...nonEmpty.sort(byDateDesc)];
}

/** 左侧历史列表仅展示普通用户对话 */
export function filterHistoryConversations(conversations: Conversation[]): Conversation[] {
  return conversations.filter((c) => !isReportOnlyConversation(c));
}

/** 从列表中移除报告专用会话，并保留其 reportData 映射 */
export function stripReportOnlyConversations(conversations: Conversation[]): Conversation[] {
  return filterHistoryConversations(conversations);
}
