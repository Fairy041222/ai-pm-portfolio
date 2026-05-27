import type { Message, ReportData } from '@/types';
import { isReportTriggerContent } from '@/utils/conversationUtils';

const PLACEHOLDER_CONTENT = /^报告已生成好/;

/** 根据报告数据与用户问题生成介绍句（与后端逻辑保持一致） */
export function buildReportIntroText(
  report: ReportData,
  userQuestion?: string,
): string {
  const q = (userQuestion ?? '').trim();
  const modelNames = report.models.map((m) => m.name).join('、');
  const caseSummary = report.testCaseSummary || `${report.testCaseCount} 个测试用例`;

  if (q && !isReportTriggerContent(q)) {
    const qDisplay = q.length > 100 ? `${q.slice(0, 100)}…` : q;
    return (
      `好的，我已根据您的问题完成需求梳理与多模型对比评测。\n\n` +
      `您关注的内容：「${qDisplay}」\n\n` +
      `本次共执行 ${caseSummary}，对比了 ${report.models.length} 个模型（${modelNames}）。` +
      `综合表现最佳的是 ${report.bestModel}。` +
      `${report.recommendationReason}\n\n` +
      `请点击下方报告查看各模型详细表现与用例结果。`
    );
  }

  return (
    `好的，我已完成本次多模型性能对比评测。\n\n` +
    `共执行 ${caseSummary}，参与对比的模型包括：${modelNames}。` +
    `综合推荐 ${report.bestModel}。${report.recommendationReason}\n\n` +
    `请点击下方报告查看完整评测结果。`
  );
}

/** 从消息中解析介绍句（兼容旧数据仅含占位文案的情况） */
export function getReportIntroText(message: Message): string {
  const content = message.content?.trim() ?? '';
  if (content && !PLACEHOLDER_CONTENT.test(content)) {
    return content;
  }
  if (message.reportData) {
    return buildReportIntroText(message.reportData);
  }
  return '好的，我已完成多模型对比评测，请点击下方报告查看详细结果。';
}
