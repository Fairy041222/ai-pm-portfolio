/**
 * 浏览器端执行多模型评测，完成后将结果提交后端生成报告。
 */

import * as api from '@/api/client';
import { chatCompletion, toLlmConfig } from '@/services/llmClient';
import { resolveModelApiKey } from '@/services/modelKeyStorage';
import { getRegistryDefaults } from '@/services/modelRegistryCache';
import type {
  ClientEvalTestCase,
  EvaluationProgress,
  Model,
} from '@/types';

const EVAL_TIMEOUT_MS = () => getRegistryDefaults().evalTimeoutSeconds * 1000;
const EVAL_MAX_TOKENS = () => getRegistryDefaults().evalMaxTokens;
const MAX_CONCURRENT = 4;

function formatDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  return `${seconds.toFixed(1)}s`;
}

function truncateOutput(text: string, max = 4000): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 3)}...`;
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index;
      index += 1;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function buildLocalProgress(
  base: EvaluationProgress,
  patch: Partial<EvaluationProgress>,
): EvaluationProgress {
  return { ...base, ...patch };
}

export async function runClientSideEvaluation(params: {
  taskId: string;
  conversationId: string;
  progress: EvaluationProgress;
  models: Model[];
  onProgressUpdate: (progress: EvaluationProgress) => void;
}): Promise<void> {
  const { taskId, conversationId, progress, models, onProgressUpdate } = params;
  const testCases = progress.testCases ?? [];
  const modelsMeta = progress.modelsMeta ?? [];
  const systemPrompt = progress.systemPrompt ?? '';

  if (!testCases.length || modelsMeta.length < 2) {
    throw new Error('评测任务数据不完整，请重新发起评测');
  }

  const modelMap = new Map(models.map((m) => [m.id, m]));
  const evalModels = modelsMeta.map((meta) => {
    const local = modelMap.get(meta.id);
    const apiKey = resolveModelApiKey({
      id: meta.id,
      name: meta.name,
      apiEndpoint: local?.apiEndpoint ?? meta.apiEndpoint,
      apiModel: local?.apiModel ?? meta.apiModel,
    });
    if (!apiKey) {
      throw new Error(
        `模型「${meta.name}」未在本浏览器保存 API Key，请在右侧「编辑模型」中填写（Key 保存在 localStorage）`,
      );
    }
    return {
      meta,
      config: toLlmConfig(
        {
          name: meta.name,
          apiEndpoint: local?.apiEndpoint ?? meta.apiEndpoint,
          apiModel: local?.apiModel ?? meta.apiModel,
          vendor: meta.vendor,
        },
        apiKey,
      ),
    };
  });

  const totalCells = testCases.length * evalModels.length;
  let completedCells = 0;
  const caseDoneCount: Record<string, number> = {};
  testCases.forEach((tc) => {
    caseDoneCount[tc.id] = 0;
  });

  const jobs: Array<{ model: (typeof evalModels)[0]; testCase: ClientEvalTestCase }> = [];
  for (const model of evalModels) {
    for (const testCase of testCases) {
      jobs.push({ model, testCase });
    }
  }

  const cells = await mapPool(jobs, MAX_CONCURRENT, async ({ model, testCase }) => {
    const start = performance.now();
    let chat;
    try {
      chat = await chatCompletion(testCase.input, model.config, {
        systemPrompt,
        maxTokens: EVAL_MAX_TOKENS(),
        timeoutMs: EVAL_TIMEOUT_MS(),
      });
    } catch (err) {
      chat = {
        content: `【评测异常】${err instanceof Error ? err.message : String(err)}`,
        success: false,
        promptTokens: 0,
        completionTokens: 0,
      };
    }
    const elapsed = (performance.now() - start) / 1000;
    const success = chat.cancelled
      ? false
      : chat.success && !chat.content.startsWith('【');
    const output = chat.cancelled
      ? ''
      : success
        ? truncateOutput(chat.content)
        : chat.content;

    completedCells += 1;
    caseDoneCount[testCase.id] = (caseDoneCount[testCase.id] ?? 0) + 1;
    const casesFullyDone = Object.values(caseDoneCount).filter(
      (n) => n >= evalModels.length,
    ).length;
    const pct = 20 + (60 * completedCells) / Math.max(totalCells, 1);

    const nextProgress = buildLocalProgress(progress, {
      progress: Math.min(80, Math.round(pct)),
      currentStep: `评测${model.meta.name}`,
      completedCases: Math.min(casesFullyDone, testCases.length),
      totalCases: testCases.length,
      status: 'running',
    });
    onProgressUpdate(nextProgress);
    void api.patchEvaluationProgress(taskId, {
      progress: nextProgress.progress,
      currentStep: nextProgress.currentStep,
      completedCases: nextProgress.completedCases,
      totalCases: nextProgress.totalCases,
    }).catch(() => {});

    return {
      modelId: model.meta.id,
      testCaseId: testCase.id,
      output,
      time: formatDuration(elapsed),
      status: success ? ('success' as const) : ('failure' as const),
      elapsedSeconds: elapsed,
      promptTokens: chat.promptTokens,
      completionTokens: chat.completionTokens,
    };
  });

  onProgressUpdate(
    buildLocalProgress(progress, {
      progress: 88,
      currentStep: '生成报告',
      completedCases: testCases.length,
      totalCases: testCases.length,
    }),
  );

  await api.submitEvaluationResults(taskId, {
    conversationId,
    cells,
    wallDurationSeconds: Math.round(performance.now() / 1000),
  });
}
