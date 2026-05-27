import { useState } from 'react';
import {
  ArrowLeft,
  Award,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  FileText,
  Info,
  ListChecks,
  RefreshCw,
  Timer,
  Pin,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { REPORT_VIEW_TEMPLATE } from '@/config/reportViewTemplate';
import { exportReport } from '@/api/client';
import { USE_MOCK_API } from '@/config/env';
import type { ModelReport, ReportData } from '@/types';

interface ReportDetailProps {
  onBack: () => void;
  /** 嵌入中间栏（三栏布局） */
  embedded?: boolean;
  /** 显式传入报告数据，优先于 context */
  report?: ReportData;
}

export default function ReportDetail({
  onBack,
  embedded = false,
  report: reportProp,
}: ReportDetailProps) {
  const { state } = useApp();
  const report =
    reportProp ?? state.reportConversation?.reportData ?? null;
  const [expandedModelId, setExpandedModelId] = useState<string | null>(
    () => report?.models[0]?.id ?? null,
  );

  if (!report) return null;

  const toggleExpand = (id: string) => {
    setExpandedModelId((prev) => (prev === id ? null : id));
  };

  const scrollbarHidden =
    'scrollbar-hide [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]';

  return (
    <div
      className={
        embedded
          ? `flex flex-col flex-1 min-w-0 h-full overflow-auto bg-[#F3F4F6] ${scrollbarHidden}`
          : `min-h-screen overflow-auto bg-[#F3F4F6] ${scrollbarHidden}`
      }
    >
      <div
        className={
          embedded
            ? 'max-w-[1200px] w-full mx-auto px-6 py-6 flex-1'
            : 'max-w-[1200px] mx-auto px-6 py-6'
        }
      >
        {/* 顶部：返回按钮独立一行（在内容卡片外） */}
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm font-medium text-(--color-primary) hover:opacity-80 transition-opacity cursor-pointer mb-4"
        >
          <ArrowLeft size={18} strokeWidth={2} />
          返回对话
        </button>

        {/* 标题独立一行 */}
        <h1 className="text-2xl sm:text-3xl font-bold text-(--color-text-primary) mb-6">
          {REPORT_VIEW_TEMPLATE.pageTitle}
        </h1>

        {/* 主内容卡片 */}
        <div className="bg-white rounded-2xl border border-(--color-border) shadow-sm p-6 space-y-8">
          {/* 报告概览 */}
          <section>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <OverviewCard
                icon={<Clock size={18} className="text-(--color-text-secondary)" />}
                label="生成时间"
                value={report.generatedAt}
              />
              <OverviewCard
                icon={<ListChecks size={18} className="text-(--color-text-secondary)" />}
                label="测试用例"
                value={report.testCaseSummary}
              />
              <OverviewCard
                icon={<Timer size={18} className="text-(--color-text-secondary)" />}
                label="总耗时"
                value={report.totalDuration}
                suffix={
                  report.totalDurationSeconds <= 60 ? (
                    <span className="text-sm font-medium text-(--color-success)">≤60秒</span>
                  ) : undefined
                }
              />
            </div>
          </section>

          {/* 最佳推荐模型 */}
          <section className="rounded-xl border border-(--color-primary)/25 bg-(--color-primary)/5 p-5">
            <div className="flex items-center gap-2 mb-4">
              <Award size={20} className="text-(--color-primary)" />
              <p className="text-base font-semibold text-(--color-text-primary)">
                最佳推荐模型：
                <span className="text-(--color-primary) ml-1">{report.bestModel}</span>
              </p>
            </div>
            <div className="rounded-lg bg-gray-100 px-4 py-3.5">
              <p className="text-sm text-(--color-text-secondary) leading-relaxed flex gap-1.5">
                <Pin size={16} className="shrink-0 mt-0.5 text-(--color-error)" />
                <span>
                  <span className="font-medium text-(--color-text-primary)">推荐理由：</span>
                  {report.recommendationReason}
                </span>
              </p>
            </div>
          </section>

          {/* 模型对比表格 */}
          <section>
            <div className="overflow-x-auto rounded-lg border border-(--color-border)">
              <table className="w-full min-w-[800px] text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-(--color-border)">
                    {['模型', '成功率', '平均耗时', '成本估算', '优缺点', '操作'].map((h) => (
                      <th
                        key={h}
                        className="text-xs font-semibold text-(--color-text-secondary) text-left py-3.5 px-4 whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.models.map((model) => (
                    <ModelRowGroup
                      key={model.id}
                      model={model}
                      isExpanded={expandedModelId === model.id}
                      onToggle={() => toggleExpand(model.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* 底部操作按钮 */}
          <section className="flex flex-wrap gap-3 pt-2">
            <OutlineButton
              icon={<FileText size={16} />}
              label="生成报告 (Markdown)"
              onClick={() => {
                void downloadMarkdown(report);
              }}
            />
            <OutlineButton
              icon={<Download size={16} />}
              label="下载原始数据 (JSON)"
              onClick={() => downloadJson(report)}
            />
            <OutlineButton
              icon={<RefreshCw size={16} />}
              label="重试评测"
              onClick={onBack}
            />
          </section>

          {/* 评测说明 */}
          <div className="rounded-lg bg-amber-50 border border-amber-200/80 px-4 py-3.5 flex gap-3">
            <Info size={18} className="text-amber-700 shrink-0 mt-0.5" />
            <div className="text-sm text-amber-900/90 leading-relaxed">
              <p className="font-semibold text-amber-800 mb-1">评测说明</p>
              <p>
                部分模型存在失败的测试用例，展开「查看详情」可以查看每个测试用例的具体执行情况。建议根据实际业务场景选择合适的模型。
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OverviewCard({
  icon,
  label,
  value,
  suffix,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  suffix?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-gray-50 border border-(--color-border) px-5 py-4">
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className="text-xs text-(--color-text-secondary)">{label}</span>
      </div>
      <div className="flex items-baseline gap-2 flex-wrap">
        <p className="text-lg font-bold text-(--color-text-primary)">{value}</p>
        {suffix}
      </div>
    </div>
  );
}

function ModelRowGroup({
  model,
  isExpanded,
  onToggle,
}: {
  model: ModelReport;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-b border-(--color-border) hover:bg-gray-50/80 transition-colors">
        <td className="px-4 py-4 font-semibold text-(--color-text-primary) whitespace-nowrap">
          {model.name}
        </td>
        <td className="px-4 py-4">
          <SuccessRateText rate={model.successRate} />
        </td>
        <td className="px-4 py-4 text-(--color-text-primary)">{model.avgTime}</td>
        <td className="px-4 py-4 text-(--color-text-primary)">{model.cost}</td>
        <td className="px-4 py-4 min-w-[180px]">
          <ProsConsList pros={model.pros} cons={model.cons} />
        </td>
        <td className="px-4 py-4 whitespace-nowrap">
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex items-center gap-0.5 text-sm text-(--color-primary) hover:underline cursor-pointer font-medium"
          >
            查看详情
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </td>
      </tr>
      {isExpanded && (
        <tr className="bg-gray-50/60">
          <td colSpan={6} className="p-4 border-b border-(--color-border)">
            <div className="rounded-xl border border-(--color-border) bg-white overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-(--color-border) bg-gray-50/80">
                <FileText size={16} className="text-(--color-primary)" />
                <span className="text-sm font-semibold text-(--color-text-primary)">
                  {model.name} 详细评测结果
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px] text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-(--color-border)">
                      {['用例', '输入', '输出/结果', '耗时', '状态'].map((h) => (
                        <th
                          key={h}
                          className="text-xs font-semibold text-(--color-text-secondary) text-left py-2.5 px-4"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {model.testCases.map((tc, i) => (
                      <tr
                        key={tc.id}
                        className="border-b border-(--color-border)/60 last:border-0 hover:bg-gray-50 transition-colors"
                      >
                        <td className="px-4 py-3 text-(--color-text-secondary) whitespace-nowrap">
                          {i + 1}/{model.testCases.length}
                        </td>
                        <td className="px-4 py-3 text-(--color-text-primary) align-top max-w-[160px]">
                          {tc.input}
                        </td>
                        <td className="px-4 py-3 text-(--color-text-primary) align-top max-w-[360px] leading-relaxed">
                          {tc.output}
                        </td>
                        <td className="px-4 py-3 text-(--color-text-secondary) whitespace-nowrap">
                          {tc.time}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className="text-base" role="img" aria-label={tc.status}>
                            {tc.status === 'success' ? '✅' : '❌'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function SuccessRateText({ rate }: { rate: string }) {
  const n = parseInt(rate, 10);
  const colorClass =
    n >= 90
      ? 'text-emerald-500 font-bold'
      : n >= 75
        ? 'text-blue-600 font-bold'
        : 'text-amber-500 font-bold';
  return <span className={colorClass}>{rate}</span>;
}

function ProsConsList({
  pros,
  cons,
}: {
  pros: string[];
  cons: ModelReport['cons'];
}) {
  return (
    <ul className="space-y-1 text-xs text-(--color-text-secondary) list-none pl-0">
      {pros.map((item) => (
        <li key={item} className="flex items-start gap-1">
          <span className="shrink-0">•</span>
          <span className="text-(--color-text-primary)">{item}</span>
        </li>
      ))}
      {cons.map((item) => (
        <li key={item.text} className="flex items-start gap-1">
          <span
            className={`shrink-0 ${item.level === 'warning' ? 'text-(--color-warning)' : 'text-(--color-error)'}`}
          >
            •
          </span>
          <span
            className={
              item.level === 'warning'
                ? 'text-(--color-warning)'
                : 'text-(--color-error)'
            }
          >
            {item.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

function OutlineButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-(--color-text-primary) border border-(--color-border) bg-white hover:bg-gray-50 transition-colors cursor-pointer"
    >
      {icon}
      {label}
    </button>
  );
}

async function downloadMarkdown(report: ReportData) {
  if (!USE_MOCK_API) {
    try {
      const result = await exportReport(report.id, 'markdown');
      downloadText(result.content, result.filename);
      return;
    } catch (err) {
      console.warn('后端模板导出失败，使用本地降级', err);
    }
  }
  const md = [
    `# ${REPORT_VIEW_TEMPLATE.pageTitle}`,
    '',
    `- 生成时间：${report.generatedAt}`,
    `- 测试用例：${report.testCaseSummary}`,
    `- 总耗时：${report.totalDuration}`,
    '',
    `## 最佳推荐：${report.bestModel}`,
    report.recommendationReason,
  ].join('\n');
  downloadText(md, '大模型性能对比报告.md');
}

function downloadJson(report: ReportData) {
  downloadText(JSON.stringify(report, null, 2), '大模型评测数据.json');
}

function downloadText(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
