/**
 * NFR-M2：前端报告预览布局模板（与 ReportDetail 渲染解耦）
 * 修改本文件即可调整预览区结构/文案，无需改动组件内业务逻辑。
 */

export interface ReportViewField {
  id: string;
  label: string;
  reportKey: 'generatedAt' | 'testCaseSummary' | 'totalDuration' | 'bestModel';
}

export interface ReportViewSection {
  id: string;
  type: 'overview_grid' | 'recommendation' | 'model_accordion' | 'actions';
  title?: string;
  fields?: ReportViewField[];
}

export const REPORT_VIEW_TEMPLATE = {
  pageTitle: '大模型性能对比报告',
  backLabel: '返回对话',
  sections: [
    {
      id: 'overview',
      type: 'overview_grid',
      fields: [
        { id: 'generated_at', label: '生成时间', reportKey: 'generatedAt' },
        { id: 'test_cases', label: '测试用例', reportKey: 'testCaseSummary' },
        { id: 'duration', label: '总耗时', reportKey: 'totalDuration' },
      ],
    },
    {
      id: 'recommendation',
      type: 'recommendation',
      title: '综合推荐',
    },
    {
      id: 'models',
      type: 'model_accordion',
      title: '模型详细对比',
    },
    {
      id: 'actions',
      type: 'actions',
    },
  ] satisfies ReportViewSection[],
} as const;

export function getReportFieldValue(
  report: Record<string, string | number>,
  key: ReportViewField['reportKey'],
): string {
  const val = report[key];
  return val != null ? String(val) : '';
}
