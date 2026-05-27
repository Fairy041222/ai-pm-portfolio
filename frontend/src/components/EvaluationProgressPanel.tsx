import { useEffect, useRef, useState } from 'react';
import type { EvaluationProgress } from '@/types';

function formatEta(seconds: number, isRunning: boolean): string {
  if (seconds <= 0) {
    return isRunning ? '计算中…' : '0 秒';
  }
  if (seconds < 60) return `约 ${seconds} 秒`;
  const min = Math.ceil(seconds / 60);
  return `约 ${min} 分钟`;
}

interface EvaluationProgressPanelProps {
  progress: EvaluationProgress;
  onViewReport?: () => void;
  onRetry?: () => void;
  onPersistReport?: () => void;
}

export default function EvaluationProgressPanel({
  progress,
  onViewReport,
  onRetry,
  onPersistReport,
}: EvaluationProgressPanelProps) {
  const targetPct = Math.max(0, Math.min(100, progress.progress));
  const [displayPct, setDisplayPct] = useState(targetPct);
  const displayRef = useRef(displayPct);
  const isDone = progress.status === 'completed';
  const isFailed = progress.status === 'failed';
  const isRunning = progress.status === 'running';
  const persistFailed = isDone && progress.persistStatus === 'failed';

  displayRef.current = displayPct;

  // 轮询间隔内平滑逼近目标进度，避免长时间停在同一百分比
  useEffect(() => {
    if (targetPct <= displayRef.current) {
      setDisplayPct(targetPct);
      return;
    }
    const tickMs = 80;
    const id = window.setInterval(() => {
      setDisplayPct((prev) => {
        if (prev >= targetPct) return targetPct;
        const delta = Math.max(1, Math.ceil((targetPct - prev) / 12));
        return Math.min(prev + delta, targetPct);
      });
    }, tickMs);
    return () => window.clearInterval(id);
  }, [targetPct]);

  const casesLabel =
    progress.totalCases > 0
      ? `${progress.completedCases}/${progress.totalCases}`
      : `${progress.completedCases}/0`;

  const estimatedTotal = progress.estimatedTotalSeconds ?? 0;
  const modelCount = progress.modelCount ?? 0;
  const caseCount = progress.totalCases > 0 ? progress.totalCases : 3;
  const estimatedTotalHint =
    estimatedTotal > 0
      ? estimatedTotal < 60
        ? `约 ${estimatedTotal} 秒`
        : `约 ${Math.ceil(estimatedTotal / 60)} 分钟`
      : null;

  return (
    <div className="mx-6 mb-4 rounded-2xl border border-(--color-primary)/20 bg-(--color-primary)/5 p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <p className="text-sm font-semibold text-(--color-text-primary)">
            {isDone ? '评测已完成' : isFailed ? '评测失败' : '正在生成评测报告'}
          </p>
          <p className="text-xs text-(--color-primary) mt-0.5 font-medium">
            当前步骤：{progress.currentStep || '准备中'}
          </p>
          {isRunning && estimatedTotalHint && (
            <p className="text-xs text-(--color-text-secondary) mt-1">
              预计评测
              {modelCount > 0 ? ` ${modelCount} 个模型、` : ' '}
              {caseCount} 个用例，总时长 {estimatedTotalHint}
            </p>
          )}
        </div>
        <span className="text-lg font-bold tabular-nums text-(--color-primary)">
          {Math.round(displayPct)}%
        </span>
      </div>

      <div className="h-2.5 w-full rounded-full bg-white/80 overflow-hidden mb-3">
        <div
          className="h-full rounded-full transition-[width] duration-300 ease-out"
          style={{
            width: `${displayPct}%`,
            backgroundColor: isFailed
              ? 'var(--color-error)'
              : isDone
                ? 'var(--color-success)'
                : 'var(--color-primary)',
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-(--color-text-secondary)">
        <span>
          用例进度：
          <strong className="text-(--color-text-primary)">{casesLabel}</strong>
        </span>
        {isRunning && (
          <span>
            预计剩余：
            <strong className="text-(--color-text-primary)">
              {formatEta(progress.estimatedRemainingSeconds, true)}
            </strong>
          </span>
        )}
        {isFailed && progress.error && (
          <span className="text-(--color-error)">{progress.error}</span>
        )}
        {persistFailed && progress.persistError && (
          <span className="text-amber-700">保存提示：{progress.persistError}</span>
        )}
      </div>

      {(isDone || isFailed) && (
        <div className="mt-4 flex flex-wrap gap-3">
          {isDone && onViewReport && (
            <button
              type="button"
              onClick={onViewReport}
              className="rounded-xl bg-(--color-primary) px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity cursor-pointer"
            >
              查看报告
            </button>
          )}
          {isDone && persistFailed && onPersistReport && (
            <button
              type="button"
              onClick={onPersistReport}
              className="rounded-xl border border-(--color-primary) px-4 py-2 text-sm font-medium text-(--color-primary) hover:bg-(--color-primary)/5 transition-colors cursor-pointer"
            >
              重新保存报告
            </button>
          )}
          {isFailed && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-xl border border-(--color-error) px-4 py-2 text-sm font-medium text-(--color-error) hover:bg-(--color-error)/5 transition-colors cursor-pointer"
            >
              重试
            </button>
          )}
        </div>
      )}
    </div>
  );
}
