import { useState, useRef, useEffect } from 'react';
import { Zap, Paperclip, FileText, User, Bot, Loader2 } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import type { Message } from '@/types';
import { resolveModelsForSend } from '@/utils/modelSelection';
import {
  formatMessageTimestamp,
  getAssistantModelLabel,
} from '@/utils/messageDisplay';
import { getReportIntroText } from '@/utils/reportIntro';
import type { ReportData } from '@/types';
import EvaluationProgressPanel from '@/components/EvaluationProgressPanel';
import { checkSecurityQuota } from '@/api/client';
import { USE_MOCK_API } from '@/config/env';
import {
  beginSendCooldown,
  DAILY_LIMIT,
  getDailyEvalCount,
  getDailyEvalRemaining,
  getDailyLimitBannerMessage,
  getSendCooldownRemainingMs,
  isDailyQuotaExhausted,
  syncDailyEvalCountFromBackend,
} from '@/utils/evalRateLimit';
import sendIconUrl from '../assets/icon/AIPM_Bench_icon_3.svg';

interface CenterPanelProps {
  onOpenReport: (report?: ReportData) => void;
}

export default function CenterPanel({ onOpenReport }: CenterPanelProps) {
  const { state, activeConversation, sendMessage, openEvaluationReport, retryEvaluation, persistEvaluationReport } =
    useApp();
  const [input, setInput] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [, setQuotaTick] = useState(0);
  const [quotaExhausted, setQuotaExhausted] = useState(isDailyQuotaExhausted());
  const activeConversationId = state.activeConversationId;
  const isSending = activeConversationId
    ? Boolean(state.sendingByConversationId[activeConversationId])
    : false;
  const evalRunning =
    state.evaluationProgress?.status === 'running' &&
    state.evaluationProgress.conversationId === activeConversationId;
  const cooldownRemainingMs = getSendCooldownRemainingMs();
  const sendBlocked =
    isSending || evalRunning || cooldownRemainingMs > 0;
  const fileRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const isReportMode =
    state.selectedModelIds.length >= 2 ||
    /生成报告|测试模型|对比/.test(input);

  const resolvedModels = resolveModelsForSend(
    state.selectedModelIds,
    state.models,
    isReportMode,
  );

  const showLightningBtn = !!file || /生成报告|测试模型|对比/.test(input);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversation?.messages]);

  useEffect(() => {
    const refreshQuota = () => {
      setQuotaExhausted(isDailyQuotaExhausted());
    };
    refreshQuota();

    if (!USE_MOCK_API) {
      void checkSecurityQuota('check')
        .then((quota) => {
          syncDailyEvalCountFromBackend(quota.currentCount);
          setQuotaExhausted(!quota.allowed || isDailyQuotaExhausted());
        })
        .catch(() => {});
    }

    const timer = window.setInterval(() => {
      refreshQuota();
      setQuotaTick((n) => n + 1);
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const evalBlockedByQuota = isReportMode && quotaExhausted;

  const handleSend = async () => {
    if (!input.trim() && !file) return;
    if (sendBlocked || evalBlockedByQuota) return;

    beginSendCooldown();
    const text = input.trim() || (file ? `[已上传文件：${file.name}]` : '');
    setInput('');
    setFile(null);
    try {
      await sendMessage(text, file);
    } catch (err) {
      const message = err instanceof Error ? err.message : '发送失败，请稍后重试';
      console.error(message, err);
      window.alert(message);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const messages = activeConversation?.messages ?? [];

  const showEvaluationProgress =
    state.evaluationProgress &&
    state.evaluationProgress.conversationId === activeConversationId &&
    (state.evaluationProgress.status === 'running' ||
      state.evaluationProgress.status === 'failed');

  const sendButtonLabel = (() => {
    if (evalBlockedByQuota) return '今日已达上限';
    if (isSending || evalRunning) return '评测中…';
    if (cooldownRemainingMs > 0) {
      return `请稍候 ${Math.ceil(cooldownRemainingMs / 1000)}s`;
    }
    return '发送';
  })();

  const canSendNow =
    !sendBlocked &&
    !evalBlockedByQuota &&
    Boolean(input.trim() || file);

  return (
    <main className="flex flex-col flex-1 h-full overflow-hidden bg-white">
      {/* Header: h-[75px] aligns border-b ~1px above left「新建对话」button (logo 68px + 8px gap - 1px) */}
      <div className="shrink-0 h-[60px] px-6 border-b border-(--color-border) flex flex-col justify-end box-border"
      style={{
        borderTopWidth: '1px',
        borderTopStyle: 'solid',
        borderTopColor: 'var(--color-border)',
        borderImage: `linear-gradient(to right, transparent 16px, var(--color-border) 16px, var(--color-border) calc(100% - 16px), transparent calc(100% - 16px)) 1`
      }}>
        <div className="flex items-center gap-3 pb-3">
          <div className="w-2 h-2 rounded-full shrink-0 bg-(--color-success)" />
          <h1 className="text-xl font-bold text-(--color-text-primary) truncate">
            {activeConversation?.title ?? '新对话'}
          </h1>
          {activeConversation?.recommendedModel && (
            <span className="text-xs px-2 py-0.5 rounded-full shrink-0 bg-(--color-primary)/10 text-(--color-primary)">
              推荐：{activeConversation.recommendedModel}
            </span>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 scrollbar-hide [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">
        {messages.length === 0 && (
          <EmptyState key={state.activeConversationId ?? 'empty'} />
        )}
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} onOpenReport={onOpenReport} />
        ))}
        {showEvaluationProgress && (
            <EvaluationProgressPanel
              progress={state.evaluationProgress!}
              onViewReport={openEvaluationReport}
              onRetry={() => {
                void retryEvaluation();
              }}
              onPersistReport={() => {
                const taskId = state.evaluationProgress?.taskId;
                if (!taskId) return;
                void persistEvaluationReport(taskId).catch((err) => {
                  window.alert(err instanceof Error ? err.message : '保存报告失败');
                });
              }}
            />
          )}
        {isSending && activeConversationId && !state.evaluationProgress && (
          <div className="flex items-start gap-3" key={`loading-${activeConversationId}`}>
            <div className="w-7 h-7 rounded-full bg-(--color-primary)/10 flex items-center justify-center shrink-0 mt-0.5">
              <Bot size={14} className="text-(--color-primary)" />
            </div>
            <div className="bg-gray-100 rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-2">
              <Loader2 size={16} className="text-(--color-text-secondary) animate-spin" />
              <span className="text-xs text-(--color-text-secondary)">AI 思考中…</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="px-4 pb-4 pt-5 item-center border-t border-(--color-border)"
        style={{
          borderTopWidth: '1px',
          borderTopStyle: 'solid',
          borderTopColor: 'var(--color-border)',
          borderImage: `linear-gradient(to right, transparent 16px, var(--color-border) 16px, var(--color-border) calc(100% - 16px), transparent calc(100% - 16px)) 1`
        }}>
        {file && (
          <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-lg bg-(--color-left-bg) border border-(--color-border)">
            <FileText size={14} className="text-(--color-primary)" />
            <span className="text-xs text-(--color-text-secondary) flex-1 truncate">{file.name}</span>
            <button
              onClick={() => setFile(null)}
              className="text-(--color-text-secondary) hover:text-(--color-error) transition-colors cursor-pointer"
            >
              ×
            </button>
          </div>
        )}

        {quotaExhausted && (
          <div
            className="mb-3 flex items-start gap-3 rounded-xl border px-4 py-3"
            style={{
              backgroundColor: '#FFF7ED',
              borderColor: '#FDBA74',
            }}
            role="status"
          >
            <span className="text-lg leading-none shrink-0" aria-hidden>
              ⚠️
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-900">
                {getDailyLimitBannerMessage()}
              </p>
              <p className="text-xs text-amber-800/90 mt-1">
                今日已用 {getDailyEvalCount()}/{DAILY_LIMIT} 次评测额度。
                您仍可在左侧切换历史对话，并点击下方报告卡片查看以往评测结果；普通单模型对话不受影响。
              </p>
            </div>
          </div>
        )}
        
        {/* 灰色框容器 - 包含输入框、上传按钮、发送按钮 */}
        <div className="bg-gray-50 rounded-2xl border border-(--color-border) focus-within:border-(--color-primary) focus-within:ring-2 focus-within:ring-(--color-primary)/20 transition overflow-hidden">
          {/* 输入框 */}
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="描述您的业务场景或上传需求文档，AI将据此生成测试用例并评测所有模型..."
            rows={3}
            className="w-full bg-transparent resize-none text-sm text-(--color-text-primary) outline-none placeholder:text-(--color-text-secondary) px-4 pt-3 pb-2"
            style={{
              lineHeight: '1.5',
              minHeight: '80px',
            }}
          />

          {/* 底部按钮行 - 上传文件 和 发送 */}
          <div className="flex items-center justify-between px-3 pb-3">
            <button
              onClick={() => fileRef.current?.click()}
              className="text-(--color-text-secondary) hover:text-(--color-primary) transition-colors cursor-pointer flex items-center gap-1.5 text-sm"
            >
              <Paperclip size={16} />
              <span>上传文件</span>
            </button>
            <input ref={fileRef} type="file" className="hidden" onChange={e => setFile(e.target.files?.[0] ?? null)} />
            
            <button
              onClick={handleSend}
              disabled={!canSendNow}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-sm font-medium text-white transition-all cursor-pointer"
              style={{
                backgroundColor: canSendNow ? 'var(--color-primary)' : '#D1D5DB',
                cursor: canSendNow ? 'pointer' : 'not-allowed',
              }}
            >
              {isSending || evalRunning ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <>
                  <img src={sendIconUrl} alt="send" className="w-3.5 h-3.5" />
                  {sendButtonLabel}
                  {showLightningBtn && sendButtonLabel === '发送' && <Zap size={13} />}
                </>
              )}
            </button>
          </div>
        </div>
        
        <p className="text-base text-(--color-text-secondary) mt-3 px-1">
          {quotaExhausted && isReportMode
            ? '报告模式已暂停：今日评测额度已用完，请明日再试'
            : isReportMode
              ? state.selectedModelIds.length >= 2
                ? `报告模式：将对比 ${state.selectedModelIds.length} 个模型（今日剩余 ${getDailyEvalRemaining()} 次）`
                : `报告模式：将自动对比 ${resolvedModels.displayNames.join('、') || '默认模型'}（今日剩余 ${getDailyEvalRemaining()} 次）`
              : state.selectedModelIds.length === 0
                ? `未选择模型时，将自动使用默认模型：${resolvedModels.displayNames[0] ?? 'Deepseek-v4-flash'}`
                : `普通对话：使用 ${resolvedModels.displayNames[0] ?? '已选模型'}`}
        </p>
      </div>
    </main>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center animate-empty-state-fade-in will-change-[opacity,transform] [transform:translateZ(0)] [backface-visibility:hidden]">
      <div className="mb-4 flex h-10 w-100 items-center justify-center rounded-2xl">
        <img
          src="./src/assets/icon/AIPM_Bench_icon_1.svg"
          alt="AIPM Bench"
          className="h-15 w-15"
        />
        <h3 className="mb-2 text-base font-semibold text-(--color-text-primary)">
          欢迎使用 AIPM Bench
        </h3>
      </div>

      <p className="w-100 text-sm text-(--color-text-secondary)">
        在这里，你可以输入业务场景或上传文档
        <br />
        AI 将自动生成测试用例，帮你对比不同模型的输出效果
      </p>
    </div>
  );
}

function MessageBubble({
  message,
  onOpenReport,
}: {
  message: Message;
  onOpenReport: (report?: ReportData) => void;
}) {
  const isUser = message.role === 'user';

  if (message.type === 'report') {
    const introText = getReportIntroText(message);

    return (
      <div className="flex items-start gap-3">
        <div className="w-7 h-7 rounded-full bg-(--color-primary)/10 flex items-center justify-center shrink-0 mt-0.5">
          <Bot size={14} className="text-(--color-primary)" />
        </div>
        <div className="max-w-[75%] flex flex-col items-start w-full gap-3 report-message-stack">
          <div className="report-intro w-full px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap bg-[#F3F4F6] text-(--color-text-primary) rounded-tl-sm">
            {introText}
          </div>
          <div className="report-link w-full">
            <ReportCard onOpen={() => onOpenReport(message.reportData)} />
          </div>
          <div className="report-timestamp w-full">
            <MessageMetaRow message={message} compact />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-start gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5"
        style={{
          backgroundColor: isUser ? 'var(--color-primary)' : 'var(--color-primary)/10',
        }}
      >
        {isUser
          ? <User size={14} color="white" />
          : <Bot size={14} className="text-(--color-primary)" />
        }
      </div>
      <div
        className={`max-w-[75%] min-w-0 relative flex flex-col ${
          isUser ? 'items-end' : 'items-start'
        }`}
      >
        <div
          className="px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words max-w-full w-full"
          style={{
            backgroundColor: isUser ? 'var(--color-primary)' : '#F3F4F6',
            color: isUser ? 'white' : 'var(--color-text-primary)',
            borderRadius: isUser ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
            overflow: 'visible',
            maxHeight: 'none',
          }}
        >
          {message.content}
        </div>
        <MessageMetaRow message={message} alignEnd={isUser} />
      </div>
    </div>
  );
}

/** 消息底部：左下角时间戳 + 右下角模型提示，同一行底部对齐 */
function MessageMetaRow({
  message,
  alignEnd = false,
  compact = false,
}: {
  message: Message;
  alignEnd?: boolean;
  /** 报告消息内使用，避免额外 margin 破坏统一 gap */
  compact?: boolean;
}) {
  const timeLabel = formatMessageTimestamp(message.timestamp);
  const modelLabel = getAssistantModelLabel(message);

  const marginClass = compact ? '' : 'mt-1.5';

  if (alignEnd) {
    return (
      <div className={`${marginClass} flex w-full min-h-[18px] items-end justify-start px-1`}>
        <span
          className="shrink-0 leading-none tabular-nums"
          style={{ fontSize: 12, color: '#999999' }}
        >
          {timeLabel}
        </span>
      </div>
    );
  }

  return (
    <div className={`${marginClass} flex w-full min-h-[18px] items-end justify-between gap-4 px-1`}>
      <span
        className="shrink-0 leading-none tabular-nums"
        style={{ fontSize: 12, color: '#999999' }}
      >
        {timeLabel}
      </span>
      <span
        className="min-w-0 flex-1 text-right leading-none"
        style={{ fontSize: 12, color: '#999999' }}
      >
        {modelLabel ?? ''}
      </span>
    </div>
  );
}

function ReportCard({ onOpen }: { onOpen: () => void }) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="flex items-center gap-3 px-4 py-3 rounded-2xl border transition-all text-left cursor-pointer"
      style={{
        backgroundColor: hovered ? '#F5F5F5' : 'white',
        borderColor: 'var(--color-border)',
        boxShadow: hovered ? '0 4px 16px rgba(0,0,0,0.10)' : '0 1px 4px rgba(0,0,0,0.05)',
      }}
    >
      <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center shrink-0">
        <FileText size={20} className="text-red-500" />
      </div>
      <div>
        <p className="text-sm font-semibold text-(--color-text-primary)">大模型性能对比报告.pdf</p>
        <p className="text-xs text-(--color-text-secondary) mt-0.5">报告已生成好，请点击查看</p>
      </div>
    </button>
  );
}
