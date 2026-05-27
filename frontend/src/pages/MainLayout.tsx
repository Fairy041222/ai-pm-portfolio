import { useCallback } from 'react';
import LeftPanel from '@/components/LeftPanel';
import CenterPanel from '@/components/CenterPanel';
import RightPanel from '@/components/RightPanel';
import ReportDetail from '@/pages/ReportDetail';
import { fetchReport } from '@/api/client';
import { useApp } from '@/context/AppContext';
import { createDemoReport } from '@/data/mockData';
import type { ReportData } from '@/types';

export default function MainLayout() {
  const {
    state,
    isReportViewActive,
    getReportForConversation,
    openReportConversation,
    dispatch,
    useMockApi,
  } = useApp();
  /** 仅由中间栏 PDF 卡片点击触发，不在左侧对话选择时自动打开 */
  const handleOpenReport = useCallback((report?: ReportData) => {
    const convId = state.activeConversationId;
    if (!convId || isReportViewActive) return;

    void (async () => {
      let resolved = report ?? getReportForConversation(convId);
      if (!resolved && !useMockApi) {
        try {
          resolved = await fetchReport(convId);
          if (resolved) {
            dispatch({ type: 'UPSERT_REPORT_CONVERSATION', report: resolved });
          }
        } catch {
          resolved = null;
        }
      }
      openReportConversation(resolved ?? createDemoReport(convId), convId);
    })();
  }, [
    state.activeConversationId,
    isReportViewActive,
    getReportForConversation,
    openReportConversation,
    useMockApi,
    dispatch,
  ]);

  const handleBackFromReport = useCallback(() => {
    dispatch({ type: 'CLOSE_REPORT_CONVERSATION' });
  }, [dispatch]);

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden bg-white">
      <div className="flex h-full min-h-0 shrink-0">
        <LeftPanel />
      </div>
      <div className="flex flex-1 overflow-hidden min-w-0">
        {isReportViewActive && state.reportConversation ? (
          <ReportDetail
            embedded
            report={state.reportConversation.reportData}
            onBack={handleBackFromReport}
          />
        ) : (
          <CenterPanel onOpenReport={handleOpenReport} />
        )}
      </div>
      <RightPanel />
    </div>
  );
}
