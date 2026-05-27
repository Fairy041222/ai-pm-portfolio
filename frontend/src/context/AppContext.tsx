import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  Conversation,
  Model,
  Message,
  ModelFormValues,
  ReportData,
  ReportConversation,
  EvaluationProgress,
} from '@/types';
import {
  getInitialConversations,
  getReportForConversation as getMockReportForConversation,
  initialModels,
  generateMockReport,
} from '@/data/mockData';
import {
  REPORT_CONVERSATION_ID,
  REPORT_CONVERSATION_TITLE,
} from '@/constants/report';
import {
  deriveConversationTitle,
  isEmptyNewConversation,
  isReportTriggerContent,
  sortConversationsByRecency,
} from '@/utils/conversationUtils';
import { resolveModelsForSend } from '@/utils/modelSelection';
import { buildReportIntroText } from '@/utils/reportIntro';
import { USE_MOCK_API } from '@/config/env';
import * as api from '@/api/client';
import {
  mergeModelWithLocalKey,
  mergeModelsWithLocalKeys,
  removeModelApiKey,
  setModelApiKey,
  resolveModelApiKey,
  reconcileModelKeysFromModels,
} from '@/services/modelKeyStorage';
import { setModelRegistry } from '@/services/modelRegistryCache';
import { LlmClient } from '@/llm/client';
import { runClientSideEvaluation } from '@/services/clientEvaluationRunner';
import { resolveApiKeyForUpdate } from '@/utils/apiKeyMask';
import {
  checkDailyEvalLimit,
  getDailyLimitMessage,
  recordEvalStart,
  syncDailyEvalCountFromBackend,
} from '@/utils/evalRateLimit';

interface AppState {
  conversations: Conversation[];
  reportConversation: ReportConversation | null;
  activeConversationId: string | null;
  previousConversationId: string | null;
  models: Model[];
  selectedModelIds: string[];
  reportsByConversationId: Record<string, ReportData>;
  /** 按对话 ID 记录是否正在等待 AI 回复 */
  sendingByConversationId: Record<string, boolean>;
  /** 评测报告生成实时进度（FR-11） */
  evaluationProgress: EvaluationProgress | null;
}

type AppAction =
  | { type: 'HYDRATE'; payload: AppState }
  | { type: 'NEW_CONVERSATION' }
  | { type: 'ADD_CONVERSATION'; conversation: Conversation }
  | { type: 'UPDATE_CONVERSATION'; conversation: Conversation }
  | { type: 'SET_ACTIVE_CONVERSATION'; id: string; previousId?: string | null }
  | { type: 'DELETE_CONVERSATIONS'; ids: string[]; fallbackConversation?: Conversation }
  | { type: 'ADD_MESSAGE'; conversationId: string; message: Message }
  | { type: 'REMOVE_LAST_USER_MESSAGE'; conversationId: string }
  | { type: 'TOGGLE_MODEL'; id: string }
  | { type: 'ADD_MODEL'; model: Model }
  | { type: 'UPDATE_MODEL'; model: Model }
  | { type: 'DELETE_MODEL'; id: string }
  | { type: 'SET_MODELS'; models: Model[] }
  | { type: 'UPSERT_REPORT_CONVERSATION'; report: ReportData }
  | {
      type: 'OPEN_REPORT_CONVERSATION';
      report: ReportData;
      fromConversationId: string;
    }
  | { type: 'CLOSE_REPORT_CONVERSATION' }
  | { type: 'SET_CONVERSATION_SENDING'; conversationId: string; sending: boolean }
  | { type: 'SET_EVALUATION_PROGRESS'; progress: EvaluationProgress | null }
  | {
      type: 'MERGE_EVALUATION_RESULT';
      conversationId: string;
      message: Message;
      report: ReportData;
    };

function buildReportConversation(report: ReportData): ReportConversation {
  return {
    id: REPORT_CONVERSATION_ID,
    title: REPORT_CONVERSATION_TITLE,
    date: report.generatedAt,
    reportData: report,
  };
}

function formatConversationDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatMessageTime(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const MOCK_STORAGE_KEY = 'aipm-bench-mock-state';
const EVAL_WATCH_STORAGE_KEY = 'aipm-bench-eval-watch';

type EvalWatchSession = { taskId: string; conversationId: string };

function readEvalWatchSession(): EvalWatchSession | null {
  try {
    const raw = sessionStorage.getItem(EVAL_WATCH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EvalWatchSession;
    if (parsed?.taskId && parsed?.conversationId) return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeEvalWatchSession(taskId: string, conversationId: string): void {
  try {
    sessionStorage.setItem(
      EVAL_WATCH_STORAGE_KEY,
      JSON.stringify({ taskId, conversationId }),
    );
  } catch {
    /* ignore */
  }
}

function clearEvalWatchSession(): void {
  try {
    sessionStorage.removeItem(EVAL_WATCH_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function createLocalEmptyConversation(): Conversation {
  return {
    id: `conv_${Date.now()}`,
    title: '新对话',
    date: formatConversationDate(new Date()),
    recommendedModel: '',
    messages: [],
  };
}

type PersistedMockSlice = Pick<
  AppState,
  'conversations' | 'activeConversationId' | 'reportsByConversationId' | 'selectedModelIds'
>;

function loadPersistedMockSlice(): PersistedMockSlice | null {
  try {
    const raw = sessionStorage.getItem(MOCK_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedMockSlice;
  } catch {
    return null;
  }
}

function persistMockSlice(state: AppState): void {
  try {
    const slice: PersistedMockSlice = {
      conversations: state.conversations,
      activeConversationId: state.activeConversationId,
      reportsByConversationId: state.reportsByConversationId,
      selectedModelIds: state.selectedModelIds,
    };
    sessionStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify(slice));
  } catch {
    // ignore quota / private mode
  }
}

/** 确保列表中有且仅选中一个空对话；无空对话时 prepend 新的 */
function ensureSingleEmptyConversation(
  conversations: Conversation[],
  activeConversationId: string | null,
  newEmpty?: Conversation,
): { conversations: Conversation[]; activeConversationId: string } {
  const emptyOnes = conversations.filter(isEmptyNewConversation);
  let convs = conversations;

  if (emptyOnes.length === 0) {
    const empty = newEmpty ?? createLocalEmptyConversation();
    return {
      conversations: sortConversationsByRecency([empty, ...convs]),
      activeConversationId: empty.id,
    };
  }

  const keep = emptyOnes[0];
  const duplicateIds = new Set(emptyOnes.slice(1).map((c) => c.id));
  if (duplicateIds.size > 0) {
    convs = convs.filter((c) => !duplicateIds.has(c.id));
  }

  const activeStillExists =
    activeConversationId != null && convs.some((c) => c.id === activeConversationId);
  return {
    conversations: sortConversationsByRecency(convs),
    activeConversationId: activeStillExists ? activeConversationId : keep.id,
  };
}

function indexReportsFromConversations(
  conversations: Conversation[],
): Record<string, ReportData> {
  const map: Record<string, ReportData> = {};
  for (const conv of conversations) {
    for (const msg of conv.messages) {
      if (msg.type === 'report' && msg.reportData) {
        map[conv.id] = msg.reportData;
      }
    }
    const fromMock = getMockReportForConversation(conv.id);
    if (fromMock && !map[conv.id]) {
      map[conv.id] = fromMock;
    }
  }
  return map;
}

function buildMockInitialState(): AppState {
  const persisted = loadPersistedMockSlice();

  if (persisted && persisted.conversations.length > 0) {
    const { conversations, activeConversationId } = ensureSingleEmptyConversation(
      persisted.conversations,
      persisted.activeConversationId,
    );
    const reportsByConversationId = {
      ...indexReportsFromConversations(conversations),
      ...persisted.reportsByConversationId,
    };
    const validModelIds = new Set(initialModels.map((m) => m.id));
    const selectedModelIds = (persisted.selectedModelIds ?? []).filter((id) =>
      validModelIds.has(id),
    );
    return {
      conversations,
      reportConversation: null,
      activeConversationId,
      previousConversationId: null,
      models: initialModels,
      selectedModelIds,
      reportsByConversationId,
      sendingByConversationId: {},
      evaluationProgress: null,
    };
  }

  const historyConversations = getInitialConversations();
  const empty = createLocalEmptyConversation();
  const { conversations, activeConversationId } = ensureSingleEmptyConversation(
    [...historyConversations],
    null,
    empty,
  );
  const reportsByConversationId = indexReportsFromConversations(conversations);

  return {
    conversations,
    reportConversation: null,
    activeConversationId,
    previousConversationId: null,
    models: initialModels,
    selectedModelIds: [],
    reportsByConversationId,
    sendingByConversationId: {},
    evaluationProgress: null,
  };
}

const emptyState: AppState = {
  conversations: [],
  reportConversation: null,
  activeConversationId: null,
  previousConversationId: null,
  models: [],
  selectedModelIds: [],
  reportsByConversationId: {},
  sendingByConversationId: {},
  evaluationProgress: null,
};

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'HYDRATE': {
      const watch = readEvalWatchSession();
      const conversations = sortConversationsByRecency(action.payload.conversations);
      const activeFromWatch =
        watch && conversations.some((c) => c.id === watch.conversationId)
          ? watch.conversationId
          : null;
      return {
        ...action.payload,
        conversations,
        activeConversationId: activeFromWatch ?? action.payload.activeConversationId,
        sendingByConversationId: action.payload.sendingByConversationId ?? {},
        evaluationProgress: null,
      };
    }

    case 'NEW_CONVERSATION': {
      const now = new Date();
      const dateStr = formatConversationDate(now);
      const newConv: Conversation = {
        id: `conv_${Date.now()}`,
        title: '新对话',
        date: dateStr,
        recommendedModel: '',
        messages: [],
      };
      return {
        ...state,
        conversations: sortConversationsByRecency([newConv, ...state.conversations]),
        activeConversationId: newConv.id,
        previousConversationId: null,
      };
    }

    case 'ADD_CONVERSATION':
      return {
        ...state,
        conversations: sortConversationsByRecency([
          action.conversation,
          ...state.conversations,
        ]),
        activeConversationId: action.conversation.id,
        previousConversationId: null,
      };

    case 'UPDATE_CONVERSATION': {
      const reportsByConversationId = { ...state.reportsByConversationId };
      for (const msg of action.conversation.messages) {
        if (msg.type === 'report' && msg.reportData) {
          reportsByConversationId[action.conversation.id] = msg.reportData;
        }
      }
      const merged = state.conversations.map((c) =>
        c.id === action.conversation.id ? action.conversation : c,
      );
      return {
        ...state,
        conversations: sortConversationsByRecency(merged),
        reportsByConversationId,
      };
    }

    case 'SET_ACTIVE_CONVERSATION': {
      const switchingToReport = action.id === REPORT_CONVERSATION_ID;
      const currentIsReport = state.activeConversationId === REPORT_CONVERSATION_ID;
      let previousConversationId = state.previousConversationId;

      if (switchingToReport && !currentIsReport) {
        previousConversationId =
          action.previousId ?? state.activeConversationId ?? previousConversationId;
      } else if (!switchingToReport) {
        previousConversationId = null;
      }

      return {
        ...state,
        activeConversationId: action.id,
        previousConversationId,
      };
    }

    case 'SET_CONVERSATION_SENDING': {
      const next = { ...state.sendingByConversationId };
      if (action.sending) {
        next[action.conversationId] = true;
      } else {
        delete next[action.conversationId];
      }
      return { ...state, sendingByConversationId: next };
    }

    case 'SET_EVALUATION_PROGRESS':
      return { ...state, evaluationProgress: action.progress };

    case 'MERGE_EVALUATION_RESULT': {
      const { conversationId, message, report } = action;
      const reportsByConversationId = {
        ...state.reportsByConversationId,
        [conversationId]: report,
      };
      const conversations = state.conversations.map((c) => {
        if (c.id !== conversationId) return c;
        const alreadyHasMessage =
          c.messages.some((m) => m.id === message.id) ||
          c.messages.some(
            (m) => m.type === 'report' && m.reportData?.id === report.id,
          );
        return {
          ...c,
          relatedReportId: report.id,
          messages: alreadyHasMessage ? c.messages : [...c.messages, message],
        };
      });
      return {
        ...state,
        conversations: sortConversationsByRecency(conversations),
        reportsByConversationId,
      };
    }

    case 'DELETE_CONVERSATIONS': {
      let remaining = state.conversations.filter((c) => !action.ids.includes(c.id));
      const reportsByConversationId = { ...state.reportsByConversationId };
      const sendingByConversationId = { ...state.sendingByConversationId };
      action.ids.forEach((id) => {
        delete reportsByConversationId[id];
        delete sendingByConversationId[id];
      });

      if (remaining.length === 0 && action.fallbackConversation) {
        remaining = [action.fallbackConversation];
      }

      let newActive = state.activeConversationId;
      if (action.ids.includes(state.activeConversationId ?? '')) {
        newActive = remaining[0]?.id ?? null;
      }
      if (remaining.length > 0 && !remaining.some((c) => c.id === newActive)) {
        newActive = remaining[0]?.id ?? null;
      }

      return {
        ...state,
        conversations: sortConversationsByRecency(remaining),
        activeConversationId: newActive,
        reportsByConversationId,
        sendingByConversationId,
        previousConversationId:
          newActive === REPORT_CONVERSATION_ID ? state.previousConversationId : null,
      };
    }

    case 'ADD_MESSAGE': {
      const nowStr = formatConversationDate(new Date());
      const convs = state.conversations.map((c) => {
        if (c.id !== action.conversationId) return c;
        const updated = {
          ...c,
          messages: [...c.messages, action.message],
          date: nowStr,
        };
        if (c.messages.length === 0 && action.message.role === 'user') {
          updated.title = deriveConversationTitle(
            action.message.content,
            c.title || '新对话',
          );
        }
        if (action.message.type === 'report') {
          const firstUser = updated.messages.find((m) => m.role === 'user');
          if (
            firstUser &&
            isReportTriggerContent(firstUser.content) &&
            (isReportTriggerContent(updated.title) ||
              /^大模型性能对比报告/.test(updated.title))
          ) {
            updated.title = deriveConversationTitle(firstUser.content, '新对话');
          }
          if (action.message.reportData) {
            updated.relatedReportId = action.message.reportData.id;
          }
        }
        return updated;
      });
      let reportsByConversationId = state.reportsByConversationId;
      let reportConversation = state.reportConversation;
      if (action.message.type === 'report' && action.message.reportData) {
        const report = action.message.reportData;
        reportsByConversationId = {
          ...reportsByConversationId,
          [action.conversationId]: report,
        };
        reportConversation = buildReportConversation(report);
      }
      return {
        ...state,
        conversations: sortConversationsByRecency(convs),
        reportsByConversationId,
        reportConversation,
      };
    }

    case 'REMOVE_LAST_USER_MESSAGE': {
      return {
        ...state,
        conversations: state.conversations.map((c) => {
          if (c.id !== action.conversationId) return c;
          const messages = [...c.messages];
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].role === 'user') {
              messages.splice(i, 1);
              break;
            }
          }
          return { ...c, messages };
        }),
      };
    }

    case 'TOGGLE_MODEL': {
      const selected = state.selectedModelIds.includes(action.id)
        ? state.selectedModelIds.filter((id) => id !== action.id)
        : [...state.selectedModelIds, action.id];
      return { ...state, selectedModelIds: selected };
    }

    case 'ADD_MODEL':
      return { ...state, models: [...state.models, action.model] };

    case 'UPDATE_MODEL':
      return {
        ...state,
        models: state.models.map((m) => (m.id === action.model.id ? action.model : m)),
      };

    case 'DELETE_MODEL':
      return {
        ...state,
        models: state.models.filter((m) => m.id !== action.id),
        selectedModelIds: state.selectedModelIds.filter((id) => id !== action.id),
      };

    case 'SET_MODELS': {
      const validIds = new Set(action.models.map((m) => m.id));
      return {
        ...state,
        models: action.models,
        selectedModelIds: state.selectedModelIds.filter((id) => validIds.has(id)),
      };
    }

    case 'UPSERT_REPORT_CONVERSATION': {
      const report = action.report;
      return {
        ...state,
        reportConversation: buildReportConversation(report),
        reportsByConversationId: {
          ...state.reportsByConversationId,
          [report.conversationId]: report,
        },
      };
    }

    case 'OPEN_REPORT_CONVERSATION': {
      const report = action.report;
      const fromId = action.fromConversationId;
      const previousConversationId =
        fromId !== REPORT_CONVERSATION_ID ? fromId : state.previousConversationId;
      return {
        ...state,
        reportConversation: buildReportConversation(report),
        reportsByConversationId: {
          ...state.reportsByConversationId,
          [report.conversationId]: report,
        },
        activeConversationId: REPORT_CONVERSATION_ID,
        previousConversationId: previousConversationId ?? state.activeConversationId,
      };
    }

    case 'CLOSE_REPORT_CONVERSATION': {
      const fallback =
        state.previousConversationId ?? state.conversations[0]?.id ?? null;
      return {
        ...state,
        activeConversationId: fallback,
        previousConversationId: null,
      };
    }

    default:
      return state;
  }
}

// Fix ADD_CUSTOM_MODEL - I referenced it in reducer but removed from type - remove case ADD_CUSTOM_MODEL from reducer since we use ADD_MODEL

interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  activeConversation: Conversation | undefined;
  isReportViewActive: boolean;
  isInitializing: boolean;
  initError: string | null;
  useMockApi: boolean;
  sendMessage: (text: string, file?: File | null) => Promise<void>;
  createNewConversation: () => Promise<void>;
  deleteConversationsByIds: (ids: string[]) => Promise<void>;
  createModel: (values: ModelFormValues) => Promise<Model>;
  updateModel: (
    modelId: string,
    values: Partial<ModelFormValues>,
    options?: { hadKey?: boolean; userClearedKey?: boolean },
  ) => Promise<Model | void>;
  setDefaultModel: (modelId: string) => Promise<void>;
  deleteModelById: (modelId: string) => Promise<void>;
  deleteModelsByIds: (modelIds: string[]) => Promise<void>;
  refreshModels: () => Promise<void>;
  getReportForConversation: (conversationId: string) => ReportData | null;
  openReportConversation: (report: ReportData, fromConversationId: string) => void;
  openEvaluationReport: () => void;
  retryEvaluation: () => Promise<void>;
  persistEvaluationReport: (taskId: string) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

const INIT_TIMEOUT_MS = 15_000;
/** 真实评测进度轮询间隔（不影响后端执行速度） */
const EVAL_POLL_INTERVAL_MS = 2_000;
/** Mock 演示模式下进度步进间隔（仅 UI 模拟，需快于轮询） */
const MOCK_EVAL_STEP_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildInitialEvaluationProgress(
  taskId: string,
  conversationId: string,
  modelCount = 2,
): EvaluationProgress {
  const estimatedTotal = Math.min(55, 8 + modelCount * 10);
  return {
    taskId,
    conversationId,
    progress: 5,
    currentStep: '生成用例',
    completedCases: 0,
    totalCases: 3,
    estimatedRemainingSeconds: estimatedTotal,
    estimatedTotalSeconds: estimatedTotal,
    modelCount: modelCount,
    status: 'running',
  };
}

function applyCompletedEvaluation(
  progress: EvaluationProgress,
  dispatch: React.Dispatch<AppAction>,
): void {
  if (progress.reportData) {
    dispatch({ type: 'UPSERT_REPORT_CONVERSATION', report: progress.reportData });
  }
  if (progress.reportData && progress.message) {
    dispatch({
      type: 'MERGE_EVALUATION_RESULT',
      conversationId: progress.conversationId,
      message: progress.message,
      report: progress.reportData,
    });
  }
  dispatch({ type: 'SET_EVALUATION_PROGRESS', progress: null });
}

function startEvaluationWatch(
  taskId: string,
  conversationId: string,
  dispatch: React.Dispatch<AppAction>,
  onFinished: () => void,
  getModels: () => Model[],
): void {
  writeEvalWatchSession(taskId, conversationId);
  let clientEvalStarted = false;
  let clientEvalFailed = false;
  void (async () => {
    try {
      while (true) {
        if (clientEvalFailed) break;

        const progress = await api.fetchEvaluationProgress(taskId);
        dispatch({ type: 'SET_EVALUATION_PROGRESS', progress });

        if (
          progress.clientEvalReady &&
          progress.status === 'running' &&
          !clientEvalStarted
        ) {
          clientEvalStarted = true;
          void runClientSideEvaluation({
            taskId,
            conversationId,
            progress,
            models: getModels(),
            onProgressUpdate: (next) => {
              dispatch({ type: 'SET_EVALUATION_PROGRESS', progress: next });
            },
          }).catch((err) => {
            console.error('Client-side evaluation failed:', err);
            clientEvalFailed = true;
            dispatch({
              type: 'SET_EVALUATION_PROGRESS',
              progress: {
                ...progress,
                status: 'failed',
                error: err instanceof Error ? err.message : '浏览器端评测失败',
                currentStep: '失败',
              },
            });
            clearEvalWatchSession();
          });
        }

        if (progress.status === 'completed') {
          applyCompletedEvaluation(progress, dispatch);
          if (progress.persistStatus === 'pending' || progress.persistStatus === 'failed') {
            void api.persistEvaluationReport(taskId).then(async () => {
              const updated = await api.fetchConversation(conversationId).catch(() => null);
              if (updated) {
                dispatch({ type: 'UPDATE_CONVERSATION', conversation: updated });
              }
            }).catch(() => {
              /* 已有 reportData，可离线查看 */
            });
          } else {
            const updated = await api.fetchConversation(conversationId).catch(() => null);
            if (updated) {
              dispatch({ type: 'UPDATE_CONVERSATION', conversation: updated });
            }
          }
          clearEvalWatchSession();
          break;
        }

        if (progress.status === 'failed') {
          clearEvalWatchSession();
          break;
        }

        await sleep(EVAL_POLL_INTERVAL_MS);
      }
    } catch (err) {
      console.error('Evaluation progress polling failed:', err);
      dispatch({
        type: 'SET_EVALUATION_PROGRESS',
        progress: {
          taskId,
          conversationId,
          progress: 0,
          currentStep: '失败',
          completedCases: 0,
          totalCases: 0,
          estimatedRemainingSeconds: 0,
          status: 'failed',
          error: err instanceof Error ? err.message : '获取评测进度失败',
        },
      });
      clearEvalWatchSession();
    } finally {
      onFinished();
    }
  })();
}

async function simulateMockEvaluationProgress(
  conversationId: string,
  modelNames: string[],
  onUpdate: (progress: EvaluationProgress) => void,
): Promise<{ taskId: string; conversationId: string; reportData: ReportData }> {
  const taskId = `mock_${Date.now()}`;
  const totalCases = 3;
  const modelA = modelNames[0] ?? '模型A';
  const modelB = modelNames[1] ?? '模型B';
  const steps: Array<Omit<EvaluationProgress, 'taskId' | 'conversationId'>> = [
    {
      progress: 8,
      currentStep: '生成用例',
      completedCases: 0,
      totalCases,
      estimatedRemainingSeconds: 45,
      status: 'running',
    },
    {
      progress: 18,
      currentStep: '生成用例',
      completedCases: totalCases,
      totalCases,
      estimatedRemainingSeconds: 40,
      status: 'running',
    },
  ];

  for (let i = 1; i <= totalCases; i++) {
    steps.push({
      progress: 20 + Math.round((30 * i) / totalCases),
      currentStep: `评测${modelA}`,
      completedCases: i,
      totalCases,
      estimatedRemainingSeconds: Math.max(5, 40 - i * 3),
      status: 'running',
    });
  }
  for (let i = 1; i <= totalCases; i++) {
    steps.push({
      progress: 50 + Math.round((30 * i) / totalCases),
      currentStep: `评测${modelB}`,
      completedCases: i,
      totalCases,
      estimatedRemainingSeconds: Math.max(3, 20 - i * 2),
      status: 'running',
    });
  }
  steps.push({
    progress: 88,
    currentStep: '生成报告',
    completedCases: totalCases,
    totalCases,
    estimatedRemainingSeconds: 5,
    status: 'running',
  });
  steps.push({
    progress: 100,
    currentStep: '生成报告',
    completedCases: totalCases,
    totalCases,
    estimatedRemainingSeconds: 0,
    status: 'completed',
  });

  for (const step of steps) {
    onUpdate({ taskId, conversationId, ...step });
    await sleep(MOCK_EVAL_STEP_MS);
  }

  return { taskId, conversationId, reportData: generateMockReport(conversationId, modelNames) };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

async function bootstrapFromApi(): Promise<AppState> {
  const [rawConversations, rawModels, registry] = await Promise.all([
    api.fetchConversations(),
    api.fetchModels(),
    api.fetchModelRegistry().catch(() => null),
  ]);

  if (registry) {
    setModelRegistry(registry);
  }

  const conversations = Array.isArray(rawConversations) ? rawConversations : [];
  const models = Array.isArray(rawModels) ? mergeModelsWithLocalKeys(rawModels) : [];
  reconcileModelKeysFromModels(
    models.map((m) => ({
      id: m.id,
      name: m.name,
      apiEndpoint: m.apiEndpoint,
      apiModel: m.apiModel,
    })),
  );
  const modelsWithKeys = mergeModelsWithLocalKeys(models);

  const emptyOnes = conversations.filter(isEmptyNewConversation);
  let convs = [...conversations];

  if (emptyOnes.length > 1) {
    const duplicateIds = emptyOnes.slice(1).map((c) => c.id);
    await api.deleteConversations(duplicateIds);
    convs = convs.filter((c) => !duplicateIds.includes(c.id));
  }

  let activeId: string;
  const evalWatch = readEvalWatchSession();
  const evalConvId =
    evalWatch && convs.some((c) => c.id === evalWatch.conversationId)
      ? evalWatch.conversationId
      : null;
  const existingEmpty = convs.find(isEmptyNewConversation);
  if (evalConvId) {
    activeId = evalConvId;
  } else if (existingEmpty) {
    activeId = existingEmpty.id;
  } else {
    const created = await api.createConversation();
    convs = [created, ...convs];
    activeId = created.id;
  }

  const reportsByConversationId = indexReportsFromConversations(convs);
  const sorted = sortConversationsByRecency(convs);

  return {
    conversations: sorted,
    reportConversation: null,
    activeConversationId: activeId,
    previousConversationId: null,
    models: modelsWithKeys,
    selectedModelIds: [],
    reportsByConversationId,
    sendingByConversationId: {},
    evaluationProgress: null,
  };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, emptyState);
  const [isInitializing, setIsInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);
  const initSeqRef = useRef(0);
  const modelsRef = useRef<Model[]>(state.models);
  modelsRef.current = state.models;

  useEffect(() => {
    const seq = ++initSeqRef.current;
    let cancelled = false;

    async function loadPayload(): Promise<AppState> {
      if (USE_MOCK_API) {
        return buildMockInitialState();
      }
      await api.fetchHealth();
      return bootstrapFromApi();
    }

    async function init() {
      setIsInitializing(true);
      setInitError(null);
      try {
        const payload = await withTimeout(
          loadPayload(),
          INIT_TIMEOUT_MS,
          '初始化超时，请确认后端已启动（aipm-backend）',
        );
        if (!cancelled && seq === initSeqRef.current) {
          dispatch({ type: 'HYDRATE', payload });
        }
      } catch (err) {
        console.error('Failed to initialize app data:', err);
        const message =
          err instanceof api.ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : '初始化失败';
        if (!cancelled && seq === initSeqRef.current) {
          setInitError(message);
          dispatch({ type: 'HYDRATE', payload: buildMockInitialState() });
        }
      } finally {
        // 仅结束当前轮次加载；避免 React StrictMode 下 cancelled 导致永远卡在加载页
        if (seq === initSeqRef.current) {
          setIsInitializing(false);
        }
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!USE_MOCK_API || isInitializing) return;
    persistMockSlice(state);
  }, [
    state.conversations,
    state.activeConversationId,
    state.reportsByConversationId,
    state.selectedModelIds,
    isInitializing,
  ]);

  useEffect(() => {
    if (isInitializing || USE_MOCK_API) return;
    const watch = readEvalWatchSession();
    if (!watch) return;
    if (state.evaluationProgress?.taskId === watch.taskId) return;
    startEvaluationWatch(watch.taskId, watch.conversationId, dispatch, () => {}, () =>
      modelsRef.current,
    );
  }, [isInitializing, state.evaluationProgress?.taskId]);

  useEffect(() => {
    if (isInitializing || USE_MOCK_API) return;
    const convId = state.activeConversationId;
    if (!convId || convId === REPORT_CONVERSATION_ID) return;

    void (async () => {
      try {
        const updated = await api.fetchConversation(convId);
        dispatch({ type: 'UPDATE_CONVERSATION', conversation: updated });
      } catch (err) {
        console.warn('Failed to refresh conversation on switch:', err);
      }
    })();
  }, [state.activeConversationId, isInitializing]);

  const isReportViewActive = state.activeConversationId === REPORT_CONVERSATION_ID;

  const activeConversation = isReportViewActive
    ? undefined
    : state.conversations.find((c) => c.id === state.activeConversationId);

  const getReportForConversation = useCallback(
    (conversationId: string): ReportData | null => {
      const conv = state.conversations.find((c) => c.id === conversationId);
      const reportMessages =
        conv?.messages.filter((m) => m.type === 'report' && m.reportData) ?? [];
      if (reportMessages.length > 0) {
        return reportMessages[reportMessages.length - 1].reportData!;
      }
      if (state.reportsByConversationId[conversationId]) {
        return state.reportsByConversationId[conversationId];
      }
      if (USE_MOCK_API) {
        return getMockReportForConversation(conversationId);
      }
      return null;
    },
    [state.conversations, state.reportsByConversationId],
  );

  const openReportConversation = useCallback(
    (report: ReportData, fromConversationId: string) => {
      dispatch({ type: 'OPEN_REPORT_CONVERSATION', report, fromConversationId });
    },
    [],
  );

  const createNewConversation = useCallback(async () => {
    const existingEmpty = state.conversations.find(isEmptyNewConversation);
    if (existingEmpty) {
      const refreshed: Conversation = {
        ...existingEmpty,
        date: formatConversationDate(new Date()),
      };
      dispatch({ type: 'UPDATE_CONVERSATION', conversation: refreshed });
      dispatch({ type: 'SET_ACTIVE_CONVERSATION', id: existingEmpty.id });
      return;
    }

    if (USE_MOCK_API) {
      dispatch({ type: 'NEW_CONVERSATION' });
      return;
    }
    const conv = await api.createConversation();
    dispatch({ type: 'ADD_CONVERSATION', conversation: conv });
  }, [state.conversations]);

  const deleteConversationsByIds = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return;

      const remaining = state.conversations.filter((c) => !ids.includes(c.id));
      let fallback: Conversation | undefined;
      if (remaining.length === 0) {
        fallback = USE_MOCK_API
          ? createLocalEmptyConversation()
          : await api.createConversation();
      }

      if (!USE_MOCK_API) {
        await api.deleteConversations(ids);
      }

      dispatch({
        type: 'DELETE_CONVERSATIONS',
        ids,
        fallbackConversation: fallback,
      });
    },
    [state.conversations],
  );

  const createModel = useCallback(async (values: ModelFormValues) => {
    if (!values.apiKey?.trim()) {
      throw new Error('请填写 API Key（Key 仅保存在浏览器，不会上传到服务器）');
    }
    const model: Model = USE_MOCK_API
      ? {
          id: `model_${Date.now()}`,
          name: values.name,
          apiEndpoint: values.apiEndpoint,
          apiModel: values.apiModel,
          hasApiKey: true,
          isRecommended: false,
        }
      : mergeModelWithLocalKey(await api.createModel(values));
    setModelApiKey(model.id, values.apiKey.trim(), {
      name: model.name,
      apiEndpoint: model.apiEndpoint,
      apiModel: model.apiModel,
    });
    dispatch({ type: 'ADD_MODEL', model: mergeModelWithLocalKey(model) });
    dispatch({ type: 'TOGGLE_MODEL', id: model.id });
    return mergeModelWithLocalKey(model);
  }, []);

  const updateModel = useCallback(async (
    modelId: string,
    values: Partial<ModelFormValues>,
    options?: { hadKey?: boolean; userClearedKey?: boolean },
  ) => {
    if (values.apiKey !== undefined) {
      const resolved = resolveApiKeyForUpdate(values.apiKey, {
        hadKey: options?.hadKey ?? false,
        userCleared: options?.userClearedKey,
      });
      if (resolved.clearApiKey) {
        const existing = state.models.find((m) => m.id === modelId);
        removeModelApiKey(
          modelId,
          existing
            ? {
                name: existing.name,
                apiEndpoint: existing.apiEndpoint,
                apiModel: existing.apiModel,
              }
            : undefined,
        );
      } else if (resolved.apiKey) {
        setModelApiKey(modelId, resolved.apiKey, {
          name: values.name ?? state.models.find((m) => m.id === modelId)?.name ?? '',
          apiEndpoint:
            values.apiEndpoint ??
            state.models.find((m) => m.id === modelId)?.apiEndpoint ??
            '',
          apiModel:
            values.apiModel ?? state.models.find((m) => m.id === modelId)?.apiModel ?? '',
        });
      } else if (
        values.name !== undefined ||
        values.apiEndpoint !== undefined ||
        values.apiModel !== undefined
      ) {
        const existing = state.models.find((m) => m.id === modelId);
        const key = existing ? resolveModelApiKey(existing) : null;
        if (existing && key) {
          setModelApiKey(modelId, key, {
            name: values.name ?? existing.name,
            apiEndpoint: values.apiEndpoint ?? existing.apiEndpoint,
            apiModel: values.apiModel ?? existing.apiModel,
          });
        }
      }
    }

    if (USE_MOCK_API) {
      const existing = state.models.find((m) => m.id === modelId);
      if (!existing) return;
      const updated: Model = mergeModelWithLocalKey({
        ...existing,
        name: values.name ?? existing.name,
        apiEndpoint: values.apiEndpoint ?? existing.apiEndpoint,
        apiModel: values.apiModel ?? existing.apiModel,
      });
      dispatch({ type: 'UPDATE_MODEL', model: updated });
      return updated;
    }
    const model = mergeModelWithLocalKey(await api.updateModel(modelId, values));
    dispatch({ type: 'UPDATE_MODEL', model });
    return model;
  }, [state.models]);

  const setDefaultModel = useCallback(async (modelId: string) => {
    if (USE_MOCK_API) {
      const models = state.models.map((m) => ({
        ...m,
        isRecommended: m.id === modelId,
      }));
      dispatch({ type: 'SET_MODELS', models });
      return;
    }
    const model = await api.setDefaultModel(modelId);
    const models = state.models.map((m) => ({
      ...m,
      isRecommended: m.id === model.id,
    }));
    dispatch({ type: 'SET_MODELS', models });
  }, [state.models]);

  const refreshModels = useCallback(async () => {
    if (USE_MOCK_API) return;
    const raw = await api.fetchModels();
    reconcileModelKeysFromModels(
      raw.map((m) => ({
        id: m.id,
        name: m.name,
        apiEndpoint: m.apiEndpoint,
        apiModel: m.apiModel,
      })),
    );
    dispatch({ type: 'SET_MODELS', models: mergeModelsWithLocalKeys(raw) });
  }, []);

  const deleteModelsByIds = useCallback(async (modelIds: string[]) => {
    const uniqueIds = [...new Set(modelIds)].filter(Boolean);
    if (!uniqueIds.length) return;

    if (USE_MOCK_API) {
      for (const id of uniqueIds) {
        dispatch({ type: 'DELETE_MODEL', id });
      }
      return;
    }

    const failures: string[] = [];
    await Promise.all(
      uniqueIds.map(async (id) => {
        try {
          await api.deleteModel(id);
        } catch (err) {
          // 后端已无记录（如 DB 重置后前端仍显示）时仍视为删除成功
          if (err instanceof api.ApiError && err.status === 404) {
            return;
          }
          failures.push(err instanceof Error ? err.message : String(err));
        } finally {
          const removed = state.models.find((m) => m.id === id);
          removeModelApiKey(
            id,
            removed
              ? {
                  name: removed.name,
                  apiEndpoint: removed.apiEndpoint,
                  apiModel: removed.apiModel,
                }
              : undefined,
          );
        }
      }),
    );

    if (failures.length > 0) {
      throw new api.ApiError(failures[0], 0);
    }

    const models = await api.fetchModels();
    dispatch({ type: 'SET_MODELS', models: mergeModelsWithLocalKeys(models) });
  }, []);

  const deleteModelById = useCallback(
    async (modelId: string) => {
      await deleteModelsByIds([modelId]);
    },
    [deleteModelsByIds],
  );

  const sendMessageMock = async (
    conversationId: string,
    text: string,
    selectedModelIds: string[],
    models: Model[],
  ) => {
    const isReportMode =
      selectedModelIds.length >= 2 || /生成报告|测试模型|对比/.test(text);
    const resolved = resolveModelsForSend(selectedModelIds, models, isReportMode);

    const userMsg: Message = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: formatMessageTime(),
    };
    dispatch({ type: 'ADD_MESSAGE', conversationId, message: userMsg });

    await new Promise((r) => setTimeout(r, 500));

    if (isReportMode && resolved.modelIds.length >= 2) {
      const selectedNames = resolved.modelIds.map(
        (id) => models.find((m) => m.id === id)?.name ?? id,
      );

      dispatch({ type: 'SET_EVALUATION_PROGRESS', progress: null });
      dispatch({
        type: 'SET_EVALUATION_PROGRESS',
        progress: buildInitialEvaluationProgress(`mock_${Date.now()}`, conversationId),
      });
      const mockResult = await simulateMockEvaluationProgress(
        conversationId,
        selectedNames,
        (progress) => {
          dispatch({ type: 'SET_EVALUATION_PROGRESS', progress });
        },
      );

      const report = mockResult.reportData;
      const reportMsg: Message = {
        id: `msg_${Date.now() + 1}`,
        role: 'assistant',
        content: buildReportIntroText(report, text),
        timestamp: formatMessageTime(),
        type: 'report',
        reportData: report,
      };
      dispatch({ type: 'ADD_MESSAGE', conversationId, message: reportMsg });
      dispatch({ type: 'UPSERT_REPORT_CONVERSATION', report });
      dispatch({ type: 'SET_EVALUATION_PROGRESS', progress: null });
    } else {
      const aiResponses = [
        '我已理解您的问题。根据您提供的信息，我建议您可以从以下几个角度思考：首先明确目标，然后分析现有资源，最后制定可执行的计划。',
        '这是一个很好的问题！基于您的描述，我认为关键在于平衡短期需求和长期目标，同时保持灵活性以应对变化。',
        '感谢您的提问。我分析了您的需求，总结如下：核心问题是效率优化，建议优先处理高优先级任务，并使用自动化工具减少重复工作。',
        '根据您描述的场景，我推荐采用结构化方法来解决问题：1) 收集数据，2) 识别模式，3) 制定策略，4) 执行并监测效果。',
      ];
      const aiMsg: Message = {
        id: `msg_${Date.now() + 1}`,
        role: 'assistant',
        content: aiResponses[Math.floor(Math.random() * aiResponses.length)],
        timestamp: formatMessageTime(),
        type: 'text',
        ...(resolved.displayNames[0]
          ? {
              usedModelName: resolved.displayNames[0],
              usedDefaultModel: resolved.usedDefault,
            }
          : {}),
      };
      dispatch({ type: 'ADD_MESSAGE', conversationId, message: aiMsg });
    }
  };

  const sendMessage = useCallback(
    async (text: string, file?: File | null) => {
      const conversationId = state.activeConversationId;
      if (!conversationId || isReportViewActive) return;

      const setSending = (sending: boolean) => {
        dispatch({ type: 'SET_CONVERSATION_SENDING', conversationId, sending });
      };

      setSending(true);
      let evaluationWatchStarted = false;
      try {
        if (file) {
          if (USE_MOCK_API) {
            const display = text.trim() || `[已上传文件：${file.name}]`;
            await sendMessageMock(
              conversationId,
              display,
              state.selectedModelIds,
              state.models,
            );
            return;
          }
          throw new Error('文件上传功能尚未在后端实现（MVP 返回 501）');
        }

        const content = text.trim();
        if (!content) return;

        if (USE_MOCK_API) {
          await sendMessageMock(
            conversationId,
            content,
            state.selectedModelIds,
            state.models,
          );
          return;
        }

        const userMsg: Message = {
          id: `msg_${Date.now()}_user`,
          role: 'user',
          content,
          timestamp: formatMessageTime(),
        };
        dispatch({ type: 'ADD_MESSAGE', conversationId, message: userMsg });

        const isReportMode =
          state.selectedModelIds.length >= 2 ||
          /生成报告|测试模型|对比/.test(content);
        const resolved = resolveModelsForSend(
          state.selectedModelIds,
          state.models,
          isReportMode,
        );

        if (isReportMode) {
          if (!USE_MOCK_API) {
            try {
              const quota = await api.checkSecurityQuota('check');
              syncDailyEvalCountFromBackend(quota.currentCount);
            } catch (err) {
              console.warn('Security quota check failed:', err);
            }
          }
          const daily = checkDailyEvalLimit();
          if (!daily.allowed) {
            dispatch({ type: 'REMOVE_LAST_USER_MESSAGE', conversationId });
            throw new Error(getDailyLimitMessage());
          }
          for (const modelId of resolved.modelIds) {
            const modelRef = state.models.find((m) => m.id === modelId);
            if (!modelRef || !resolveModelApiKey(modelRef)) {
              dispatch({ type: 'REMOVE_LAST_USER_MESSAGE', conversationId });
              const modelName = modelRef?.name ?? modelId;
              throw new Error(
                `模型「${modelName}」未在本浏览器保存 API Key。请在右侧「编辑模型」中重新填写 Key（Key 保存在浏览器 localStorage，不会上传服务器；换浏览器或清空站点数据后需重新填写）。`,
              );
            }
          }
        }

        console.log('[sendMessage] 报告/对话模型解析', {
          selectedModelIds: state.selectedModelIds,
          resolvedIds: resolved.modelIds,
          resolvedNames: resolved.displayNames,
          count: resolved.modelIds.length,
          isReportMode,
        });

        const response = await api.sendMessage(
          conversationId,
          content,
          resolved.modelIds,
        );

        if (response.type === 'report_pending') {
          recordEvalStart();
          dispatch({ type: 'SET_EVALUATION_PROGRESS', progress: null });
          dispatch({
            type: 'SET_EVALUATION_PROGRESS',
            progress: buildInitialEvaluationProgress(
              response.taskId,
              conversationId,
              resolved.modelIds.length,
            ),
          });

          evaluationWatchStarted = true;
          startEvaluationWatch(
            response.taskId,
            conversationId,
            dispatch,
            () => {
              setSending(false);
            },
            () => modelsRef.current,
          );
          return;
        }

        if (response.type === 'client_text_pending') {
          const localModel = state.models.find((m) => m.id === response.model.id);
          const apiKey = resolveModelApiKey({
            id: response.model.id,
            name: response.model.name,
            apiEndpoint: localModel?.apiEndpoint ?? response.model.apiEndpoint,
            apiModel: localModel?.apiModel ?? response.model.apiModel,
          });
          if (!apiKey) {
            throw new Error(
              `模型「${response.model.name}」未在本浏览器保存 API Key。请在右侧「编辑模型」中填写 Key（保存在浏览器 localStorage）。`,
            );
          }
          const chat = await LlmClient.chat(
            content,
            LlmClient.toConfig(
              {
                name: response.model.name,
                apiEndpoint: localModel?.apiEndpoint ?? response.model.apiEndpoint,
                apiModel: localModel?.apiModel ?? response.model.apiModel,
                vendor: response.model.vendor,
              },
              apiKey,
            ),
            { maxTokens: 1024, timeoutMs: 30_000 },
          );
          const saved = await api.saveAssistantMessage(conversationId, {
            content: chat.content,
            usedModelName: response.model.name,
            usedDefaultModel: response.usedDefaultModel,
          });
          dispatch({ type: 'ADD_MESSAGE', conversationId, message: saved.message });
          return;
        }

        const updated = await api.fetchConversation(conversationId);
        dispatch({ type: 'UPDATE_CONVERSATION', conversation: updated });

        if (response.type === 'report' && response.reportData) {
          dispatch({
            type: 'UPSERT_REPORT_CONVERSATION',
            report: response.reportData,
          });
        }
      } catch (err) {
        if (!USE_MOCK_API) {
          dispatch({ type: 'REMOVE_LAST_USER_MESSAGE', conversationId });
        }
        throw err;
      } finally {
        if (!evaluationWatchStarted) {
          setSending(false);
        }
      }
    },
    [isReportViewActive, state.activeConversationId, state.selectedModelIds, state.models],
  );

  const openEvaluationReport = useCallback(() => {
    const ep = state.evaluationProgress;
    if (!ep || ep.status !== 'completed') return;
    const report =
      ep.reportData ??
      state.reportsByConversationId[ep.conversationId] ??
      null;
    if (!report) return;
    dispatch({ type: 'UPSERT_REPORT_CONVERSATION', report });
    dispatch({
      type: 'OPEN_REPORT_CONVERSATION',
      report,
      fromConversationId: ep.conversationId,
    });
    dispatch({ type: 'SET_EVALUATION_PROGRESS', progress: null });
  }, [state.evaluationProgress, state.reportsByConversationId]);

  const retryEvaluation = useCallback(async () => {
    const ep = state.evaluationProgress;
    if (!ep) return;
    const conv = state.conversations.find((c) => c.id === ep.conversationId);
    const lastUser = [...(conv?.messages ?? [])]
      .reverse()
      .find((m) => m.role === 'user');
    if (!lastUser?.content.trim()) return;
    dispatch({ type: 'SET_EVALUATION_PROGRESS', progress: null });
    await sendMessage(lastUser.content);
  }, [sendMessage, state.evaluationProgress, state.conversations]);

  const persistEvaluationReportTask = useCallback(
    async (taskId: string) => {
      await api.persistEvaluationReport(taskId);
      const progress = await api.fetchEvaluationProgress(taskId);
      if (progress.status === 'completed') {
        applyCompletedEvaluation(progress, dispatch);
        const updated = await api.fetchConversation(progress.conversationId).catch(() => null);
        if (updated) {
          dispatch({ type: 'UPDATE_CONVERSATION', conversation: updated });
        }
      }
    },
    [],
  );

  if (isInitializing) {
    return (
      <div className="flex h-screen items-center justify-center bg-white text-sm text-(--color-text-secondary)">
        正在加载…
      </div>
    );
  }

  return (
    <AppContext.Provider
      value={{
        state,
        dispatch,
        activeConversation,
        isReportViewActive,
        isInitializing,
        initError,
        useMockApi: USE_MOCK_API,
        sendMessage,
        createNewConversation,
        deleteConversationsByIds,
        createModel,
        updateModel,
        setDefaultModel,
        deleteModelById,
        deleteModelsByIds,
        refreshModels,
        getReportForConversation,
        openReportConversation,
        openEvaluationReport,
        retryEvaluation,
        persistEvaluationReport: persistEvaluationReportTask,
      }}
    >
      <div className="flex h-screen flex-col overflow-hidden">
        {initError && (
          <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-800">
            无法连接后端，已回退到本地演示数据：{initError}
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

export { REPORT_CONVERSATION_ID };
