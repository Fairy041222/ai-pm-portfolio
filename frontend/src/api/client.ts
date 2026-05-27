import { API_BASE } from '@/config/env';
import { getOrCreateSessionId } from '@/services/sessionId';
import type {
  ClientEvalModelMeta,
  Conversation,
  EvaluationProgress,
  Message,
  Model,
  ModelFormValues,
  ReportData,
} from '@/types';

export class ApiError extends Error {
  status: number;
  body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** 每个 Response 只允许读取 body 一次 */
async function readResponseBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ApiError(`读取响应体失败：${msg}`, res.status);
  }
}

function extractErrorDetail(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim()) {
    return body.trim();
  }
  if (typeof body === 'object' && body !== null && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string' && detail.trim()) {
      return detail;
    }
    if (Array.isArray(detail)) {
      const parts = detail.map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item !== null) {
          const loc = 'loc' in item ? (item as { loc?: unknown[] }).loc : undefined;
          const msg = 'msg' in item ? String((item as { msg: unknown }).msg) : '';
          const path = Array.isArray(loc) ? loc.join('.') : '';
          return path ? `${path}: ${msg}` : msg;
        }
        return String(item);
      });
      return parts.filter(Boolean).join('; ') || fallback;
    }
  }
  return fallback;
}

function parseJsonBody<T>(raw: string, res: Response): T {
  if (!raw) {
    return undefined as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApiError(
      `响应不是有效的 JSON（HTTP ${res.status}）`,
      res.status,
      raw.slice(0, 500),
    );
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs?: number,
): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const headers: HeadersInit = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...options.headers,
  };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs != null && timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort(new DOMException('请求超时', 'AbortError'));
    }, timeoutMs);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      const msg = err.message || '';
      const isTimeout = /timeout|超时|aborted without reason/i.test(msg) || msg === '';
      throw new ApiError(
        isTimeout
          ? `请求超时（${Math.round((timeoutMs ?? 0) / 1000)}s），请确认后端已启动或稍后重试`
          : '请求已被取消',
        isTimeout ? 408 : 499,
      );
    }
    if (err instanceof TypeError) {
      throw new ApiError('无法连接服务器，请确认 aipm-backend 已启动', 0);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const raw = await readResponseBody(res);

  if (!res.ok) {
    let body: unknown = raw;
    if (raw) {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        /* 保留 raw 文本 */
      }
    }
    const detail = extractErrorDetail(body, res.statusText || `HTTP ${res.status}`);
    console.error('[API Client] 请求失败', {
      url,
      method: options.method ?? 'GET',
      status: res.status,
      detail,
      bodyPreview: raw.slice(0, 300),
    });
    throw new ApiError(detail || `HTTP ${res.status}`, res.status, body);
  }

  if (res.status === 204 || !raw) {
    return undefined as T;
  }

  return parseJsonBody<T>(raw, res);
}

// --- Conversations ---

export async function fetchConversations(): Promise<Conversation[]> {
  return request<Conversation[]>('/conversations');
}

export async function createConversation(): Promise<Conversation> {
  return request<Conversation>('/conversations', { method: 'POST' });
}

export async function deleteConversations(ids: string[]): Promise<void> {
  await request<void>('/conversations', {
    method: 'DELETE',
    body: JSON.stringify({ ids }),
  });
}

export async function fetchConversation(id: string): Promise<Conversation> {
  return request<Conversation>(`/conversations/${id}`);
}

// --- Messages ---

export type SendMessageResponse =
  | {
      type: 'text';
      content: string;
      message: Message;
      usedModelName?: string;
      usedDefaultModel?: boolean;
    }
  | {
      type: 'client_text_pending';
      message: Message;
      model: ClientEvalModelMeta;
      usedDefaultModel?: boolean;
    }
  | { type: 'report'; reportData: ReportData; message: Message }
  | { type: 'report_pending'; taskId: string; message: Message };

export async function fetchEvaluationProgress(
  taskId: string,
): Promise<EvaluationProgress> {
  return request<EvaluationProgress>(`/evaluation/progress/${taskId}`);
}

export async function persistEvaluationReport(
  taskId: string,
): Promise<{ ok: boolean; reportId: string; conversationId: string; alreadySaved: boolean }> {
  return request(`/evaluation/tasks/${taskId}/persist-report`, { method: 'POST' });
}

export async function patchEvaluationProgress(
  taskId: string,
  body: {
    progress?: number;
    currentStep?: string;
    completedCases?: number;
    totalCases?: number;
  },
): Promise<EvaluationProgress> {
  return request<EvaluationProgress>(`/evaluation/tasks/${taskId}/progress`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function submitEvaluationResults(
  taskId: string,
  body: {
    conversationId: string;
    cells: Array<{
      modelId: string;
      testCaseId: string;
      output: string;
      time: string;
      status: 'success' | 'failure';
      elapsedSeconds: number;
      promptTokens: number;
      completionTokens: number;
    }>;
    wallDurationSeconds: number;
  },
): Promise<EvaluationProgress> {
  return request<EvaluationProgress>(`/evaluation/tasks/${taskId}/submit-results`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function saveAssistantMessage(
  conversationId: string,
  body: {
    content: string;
    usedModelName?: string;
    usedDefaultModel?: boolean;
  },
): Promise<{
  type: 'text';
  content: string;
  message: Message;
  usedModelName?: string;
  usedDefaultModel?: boolean;
}> {
  return request(`/conversations/${conversationId}/messages/assistant`, {
    method: 'POST',
    body: JSON.stringify({
      content: body.content,
      used_model_name: body.usedModelName,
      used_default_model: body.usedDefaultModel ?? false,
    }),
  });
}

// --- Security (NFR-P5) ---

export interface SecurityQuotaResult {
  allowed: boolean;
  currentCount: number;
  dailyLimit: number;
  remaining: number;
  duplicateBlocked?: boolean;
  message?: string | null;
}

export async function checkSecurityQuota(
  action: 'check' | 'consume' = 'check',
): Promise<SecurityQuotaResult> {
  return request<SecurityQuotaResult>('/security/check-quota', {
    method: 'POST',
    body: JSON.stringify({
      session_id: getOrCreateSessionId(),
      action,
    }),
  });
}

export async function sendMessage(
  conversationId: string,
  content: string,
  modelIds?: string[],
): Promise<SendMessageResponse> {
  const question = content.trim();
  return request<SendMessageResponse>(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: question,
      question,
      model_ids: modelIds ?? [],
      session_id: getOrCreateSessionId(),
    }),
  });
}

// --- Reports ---

export async function fetchReport(conversationId: string): Promise<ReportData> {
  return request<ReportData>(`/reports/${conversationId}`);
}

export interface ExportReportResult {
  filename: string;
  content: string;
  contentType: string;
}

export async function exportReport(
  reportId: string,
  format: 'markdown' | 'json' = 'markdown',
): Promise<ExportReportResult> {
  const data = await request<{
    filename: string;
    content: string;
    contentType: string;
  }>(`/reports/${reportId}/export`, {
    method: 'POST',
    body: JSON.stringify({ format }),
  });
  return {
    filename: data.filename,
    content: data.content,
    contentType: data.contentType,
  };
}

// --- Models ---

export async function fetchModels(): Promise<Model[]> {
  return request<Model[]>('/models');
}

export async function fetchModelRegistry(): Promise<import('@/types').ModelRegistry> {
  return request('/models/registry');
}

export async function fetchModel(modelId: string): Promise<Model> {
  return request<Model>(`/models/${modelId}`);
}

export async function createModel(values: ModelFormValues): Promise<Model> {
  const payload = {
    name: values.name,
    api_endpoint: values.apiEndpoint,
    api_model: values.apiModel.trim(),
  };
  return request<Model>('/models', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateModel(
  modelId: string,
  values: Partial<ModelFormValues>,
): Promise<Model> {
  const body: Record<string, unknown> = {};
  if (values.name !== undefined) body.name = values.name;
  if (values.apiEndpoint !== undefined) body.api_endpoint = values.apiEndpoint;
  if (values.apiModel !== undefined) body.api_model = values.apiModel.trim();

  const result = await request<Model>(`/models/${modelId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return result;
}

export async function setDefaultModel(modelId: string): Promise<Model> {
  return request<Model>(`/models/${modelId}/set-default`, { method: 'POST' });
}

export async function deleteModel(modelId: string): Promise<void> {
  await request<void>(`/models/${modelId}`, { method: 'DELETE' });
}

// --- Health ---

/** 健康检查（初始化用，默认 8s 超时） */
export async function fetchHealth(
  timeoutMs = 8_000,
): Promise<{ status: string }> {
  return request<{ status: string }>('/health', {}, timeoutMs);
}
