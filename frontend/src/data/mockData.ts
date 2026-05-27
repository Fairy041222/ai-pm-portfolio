import type { Conversation, Message, Model, ReportData } from '@/types';

/** Mock 模式下初始无预置模型，由用户自行添加 */
export const initialModels: Model[] = [];

/** 格式化为当天日期时间 YYYY-MM-DD HH:mm */
function formatTodayDateTime(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 创建 demo 报告数据 */
export function createDemoReport(conversationId: string): ReportData {
  return {
    id: `report-${conversationId}`,
    conversationId,
    generatedAt: formatTodayDateTime(),
    testCaseCount: 12,
    testCaseSummary: '12 个测试用例',
    totalDuration: '约 45 秒',
    totalDurationSeconds: 45,
    bestModel: 'GPT-4o',
    recommendationReason:
      '在邮件分类、会议待办提取等任务上表现最佳，准确率最高，响应速度快。',
    models: [
      {
        id: 'gpt4o',
        name: 'GPT-4o',
        successRate: '95.8%',
        avgTime: '2.3s',
        cost: '$0.12',
        pros: ['准确率高', '理解能力强', '支持多语言'],
        cons: [{ text: '成本相对较高', level: 'warning' }],
        testCases: [
          {
            id: 'tc1',
            input: '将以下邮件分类：...',
            output: '工作邮件',
            time: '2.1s',
            status: 'success',
          },
          {
            id: 'tc2',
            input: '提取会议待办：...',
            output: '5项待办事项',
            time: '2.5s',
            status: 'success',
          },
        ],
      },
      {
        id: 'claude35',
        name: 'Claude 3.5 Sonnet',
        successRate: '91.7%',
        avgTime: '3.1s',
        cost: '$0.10',
        pros: ['安全性高', '推理能力强'],
        cons: [{ text: '偶尔拒绝回答', level: 'error' }],
        testCases: [],
      },
      {
        id: 'gpt35',
        name: 'GPT-3.5 Turbo',
        successRate: '83.3%',
        avgTime: '1.8s',
        cost: '$0.04',
        pros: ['响应快', '成本低'],
        cons: [{ text: '复杂任务准确率较低', level: 'error' }],
        testCases: [],
      },
    ],
  };
}

/** 创建带报告消息的对话（保留供其他场景使用，初始列表不再引用） */
export function createReportConversation(): Conversation {
  const conversationId = 'meeting-todo-extract';
  const report = createDemoReport(conversationId);
  const today = formatTodayDateTime();

  const reportMessage: Message = {
    id: 'msg-report-meeting',
    role: 'assistant',
    type: 'report',
    content: '报告已生成好，请点击查看',
    timestamp: today,
    reportData: report,
  };

  return {
    id: conversationId,
    title: '会议待办提取',
    date: today,
    recommendedModel: 'GPT-4o',
    messages: [reportMessage],
    relatedReportId: `report-${conversationId}`,
  };
}

/** 创建「产品需求整理」多轮对话 */
export function createPrdOrganizeConversation(): Conversation {
  const conversationId = 'prd-organize';
  const report = createDemoReport(conversationId);

  const messages: Message[] = [
    {
      id: 'msg-prd-user-1',
      role: 'user',
      type: 'text',
      content: '请帮我整理这份产品需求文档，提取核心功能点',
      timestamp: '2026-05-16 09:20',
    },
    {
      id: 'msg-prd-assistant-1',
      role: 'assistant',
      type: 'report',
      content:
        '好的，我已分析需求文档。核心功能点包括：1. 用户权限管理（角色分级、权限配置）；2. 数据看板（实时统计、图表展示）；3. 审批流程（多级审批、消息通知）；4. 报表导出（支持 Excel/PDF 格式）。是否需要我生成详细的模型对比报告？',
      reportData: report,
      timestamp: '2026-05-16 09:22',
    },
  ];

  return {
    id: conversationId,
    title: '产品需求整理',
    date: '2026-05-16 09:20',
    recommendedModel: 'GPT-4o',
    messages,
    relatedReportId: `report-${conversationId}`,
  };
}

/** 获取对话关联的报告（mock 静态映射） */
export function getReportForConversation(conversationId: string): ReportData | null {
  if (conversationId === 'prd-organize') {
    return createDemoReport(conversationId);
  }
  return null;
}

/** 初始对话列表 */
export function getInitialConversations(): Conversation[] {
  return [createPrdOrganizeConversation()];
}

/** 动态生成报告（用户触发评测后） */
export function generateMockReport(
  conversationId: string,
  modelNames?: string[],
): ReportData {
  const base = createDemoReport(conversationId);
  if (!modelNames?.length) return base;

  const filtered = base.models.filter((m) => modelNames.includes(m.name));
  const models =
    filtered.length > 0
      ? filtered
      : modelNames.map((name, i) => ({
          ...base.models[i % base.models.length],
          id: `model_${i}`,
          name,
          successRate: `${Math.round(70 + Math.random() * 25)}%`,
        }));

  const best = models.reduce((a, b) =>
    parseInt(a.successRate, 10) >= parseInt(b.successRate, 10) ? a : b,
  );

  return {
    ...base,
    id: `report-${Date.now()}`,
    conversationId,
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    models,
    bestModel: best.name,
    recommendationReason: `${best.name} 在本次评测中综合表现最优，推荐作为首选模型。`,
  };
}
