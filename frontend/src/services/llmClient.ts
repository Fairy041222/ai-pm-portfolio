/**
 * NFR-P1：API Key 保存在浏览器 localStorage。
 * 无 CORS 的厂商（讯飞、腾讯混元等）经本应用后端 /api/proxy/* 转发，Key 仅随请求体透传、不落库。
 */

import { API_BASE } from '@/config/env';
import { inferVendorFromEndpoint, normalizeSparkModel, type VendorType } from '@/utils/vendorInference';
import { getRegistryDefaults, getVendorConfig } from '@/services/modelRegistryCache';

export interface LlmInvokeConfig {
  apiEndpoint: string;
  apiModel: string;
  apiKey: string;
  name?: string;
  vendor?: VendorType;
}

export interface ChatResult {
  content: string;
  success: boolean;
  promptTokens: number;
  completionTokens: number;
  error?: string;
  /** 用户取消或组件卸载导致的中断，不应作为失败展示 */
  cancelled?: boolean;
}

const DEEPSEEK_CHAT_URL = 'https://api.deepseek.com/chat/completions';
const CURSOR_OFFICIAL_HOSTS = ['api.cursor.com', 'cursor.com', 'cursor.sh'];

function buildMessages(userContent: string, systemPrompt?: string | null) {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt?.trim()) {
    messages.push({ role: 'system', content: systemPrompt.trim() });
  }
  messages.push({ role: 'user', content: userContent });
  return messages;
}

function extractOpenAiContent(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const choices = d.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
    const msg = (choices[0] as { message?: { content?: string } }).message;
    if (msg?.content) return String(msg.content);
  }
  const output = d.output;
  if (output && typeof output === 'object') {
    const text = (output as { text?: string }).text;
    if (text) return String(text);
  }
  return '';
}

function usageFromOpenAi(data: unknown): { pt: number; ct: number } {
  if (!data || typeof data !== 'object') return { pt: 0, ct: 0 };
  const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
  return {
    pt: Number(usage?.prompt_tokens ?? 0),
    ct: Number(usage?.completion_tokens ?? 0),
  };
}

function parseErrorMessage(data: unknown, status: number, raw: string): string {
  if (data && typeof data === 'object') {
    const err = (data as { error?: { message?: string }; message?: string }).error;
    if (err && typeof err === 'object' && err.message) return String(err.message);
    const msg = (data as { message?: string; detail?: string }).message;
    if (msg) return String(msg);
    const detail = (data as { detail?: string }).detail;
    if (detail) return String(detail);
  }
  return raw.slice(0, 200) || `HTTP ${status}`;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

type FetchErrorMeta = Error & { userCancelled?: boolean; timedOut?: boolean };

function isTimeoutAbort(err: unknown): boolean {
  if (!isAbortError(err)) return false;
  const meta = err as FetchErrorMeta;
  if (meta.timedOut) return true;
  const msg = err instanceof Error ? err.message : '';
  return /timeout|超时|aborted without reason/i.test(msg) || msg === '';
}

function isUserCancelledAbort(err: unknown, externalSignal?: AbortSignal): boolean {
  const meta = err as FetchErrorMeta;
  if (meta.userCancelled) return true;
  if (externalSignal?.aborted) return true;
  const msg = err instanceof Error ? err.message : '';
  return /cancel|取消/i.test(msg);
}

function handleFetchAbort(
  err: unknown,
  externalSignal?: AbortSignal,
  timeoutMs = 60_000,
  vendor: VendorType = 'openai_compatible',
): ChatResult | null {
  if (!isAbortError(err)) return null;

  if (isUserCancelledAbort(err, externalSignal)) {
    console.info('[llmClient] 请求已被取消');
    return {
      content: '',
      success: false,
      promptTokens: 0,
      completionTokens: 0,
      cancelled: true,
    };
  }

  if (isTimeoutAbort(err)) {
    return {
      content: formatTimeoutError(timeoutMs, vendor),
      success: false,
      promptTokens: 0,
      completionTokens: 0,
      error: 'timeout',
    };
  }

  console.info('[llmClient] 请求已被取消');
  return {
    content: '',
    success: false,
    promptTokens: 0,
    completionTokens: 0,
    cancelled: true,
  };
}

function corsHint(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|network|cors|cross-origin/i.test(msg)) {
    return (
      `${msg}。该厂商 API 可能未允许浏览器跨域访问；` +
      '请在 models.yaml 启用 browser_proxy 后使用后端代理，或配置可跨域的转发地址。'
    );
  }
  return msg;
}

function needsBrowserProxy(vendor: VendorType): boolean {
  const vconf = getVendorConfig(vendor);
  return Boolean(vconf.browserProxy ?? vconf.browser_proxy);
}

function resolveTimeoutMs(vendor: VendorType, overrideMs?: number): number {
  if (overrideMs != null && overrideMs > 0) return overrideMs;
  const vconf = getVendorConfig(vendor);
  const vendorSec = Number(
    (vconf.timeoutSeconds as number | undefined) ??
      (vconf.timeout_seconds as number | undefined) ??
      0,
  );
  if (vendorSec > 0) return vendorSec * 1000;
  return getRegistryDefaults().timeoutSeconds * 1000;
}

function getRetryPolicy(): { maxAttempts: number; baseDelayMs: number } {
  const defs = getRegistryDefaults();
  const maxAttempts = Math.max(1, defs.retryMaxAttempts);
  const baseDelayMs = Math.max(200, defs.retryBaseDelaySeconds * 1000);
  return { maxAttempts, baseDelayMs };
}

function formatTimeoutError(timeoutMs: number, vendor: VendorType): string {
  const sec = Math.round(timeoutMs / 1000);
  return (
    `【调用异常】请求超时（已等待 ${sec} 秒）。` +
    `可在 config/models.yaml 中为厂商「${vendor}」调整 timeout_seconds，` +
    `或修改 global_defaults.eval_timeout_seconds（评测）/ timeout_seconds（对话）。` +
    `当前前端读取到的默认超时为 ${sec} 秒。`
  );
}

const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deepseekChatUrl(config: LlmInvokeConfig): string {
  const base = config.apiEndpoint.trim().replace(/\/+$/, '');
  if (!base || base.includes('deepseek.com')) return DEEPSEEK_CHAT_URL;
  if (base.endsWith('/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  return `${base}/chat/completions`;
}

function openAiCompatibleUrl(config: LlmInvokeConfig): string {
  let base = config.apiEndpoint.trim().replace(/\/+$/, '');
  if (!base.startsWith('http')) base = `https://${base}`;
  if (base.endsWith('/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  if (!base.includes('/v1')) return `${base}/v1/chat/completions`;
  return `${base}/chat/completions`;
}

async function httpPost(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<{ ok: boolean; status: number; data: unknown; raw: string }> {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('请求超时', 'AbortError'));
  }, timeoutMs);

  const onExternalAbort = () => {
    clearTimeout(timer);
    const reason =
      externalSignal?.reason ??
      new DOMException('请求已被取消', 'AbortError');
    controller.abort(reason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      const err = new DOMException('请求已被取消', 'AbortError') as FetchErrorMeta;
      err.userCancelled = true;
      throw err;
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await res.text();
    let data: unknown = raw;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      /* keep raw */
    }
    return { ok: res.ok, status: res.status, data, raw };
  } catch (err) {
    if (isAbortError(err)) {
      const wrapped = err as FetchErrorMeta;
      if (timedOut) {
        wrapped.timedOut = true;
      } else if (externalSignal?.aborted) {
        wrapped.userCancelled = true;
      }
    }
    throw err;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

async function httpPostWithRetry(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs: number,
  externalSignal?: AbortSignal,
  vendor: VendorType = 'openai_compatible',
): Promise<{ ok: boolean; status: number; data: unknown; raw: string }> {
  const { maxAttempts, baseDelayMs } = getRetryPolicy();
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const result = await httpPost(url, headers, payload, timeoutMs, externalSignal);
      if (RETRYABLE_HTTP.has(result.status) && attempt < maxAttempts - 1) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      return result;
    } catch (err) {
      lastErr = err;
      const aborted = handleFetchAbort(err, externalSignal, timeoutMs, vendor);
      if (aborted?.cancelled) throw err;
      if (isTimeoutAbort(err) && attempt < maxAttempts - 1) {
        console.warn(`[llmClient] ${vendor} 超时，${baseDelayMs * 2 ** attempt}ms 后重试`);
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }

  if (lastErr) throw lastErr;
  throw new Error('httpPostWithRetry exhausted');
}

async function callViaBackendProxy(
  config: LlmInvokeConfig,
  userContent: string,
  systemPrompt: string | null | undefined,
  maxTokens: number,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<ChatResult> {
  const vendor =
    config.vendor ?? inferVendorFromEndpoint(config.apiEndpoint, config.name ?? '');
  const proxyPath = vendor === 'spark' ? '/proxy/xunfei' : '/proxy/llm';
  const url = `${API_BASE}${proxyPath}`;
  const payload = {
    apiKey: config.apiKey,
    apiEndpoint: config.apiEndpoint,
    apiModel: config.apiModel,
    name: config.name ?? '',
    vendor,
    userContent,
    systemPrompt: systemPrompt ?? null,
    maxTokens,
    timeoutSeconds: Math.max(60, Math.ceil(timeoutMs / 1000) + 15),
  };

  try {
    const { ok, status, data, raw } = await httpPostWithRetry(
      url,
      { 'Content-Type': 'application/json', Accept: 'application/json' },
      payload,
      timeoutMs + 45_000,
      externalSignal,
      vendor,
    );
    if (!ok) {
      const message = parseErrorMessage(data, status, raw);
      return {
        content: `【调用失败】${message}`,
        success: false,
        promptTokens: 0,
        completionTokens: 0,
        error: message,
      };
    }
    const body = data as {
      content?: string;
      success?: boolean;
      promptTokens?: number;
      completionTokens?: number;
      error?: string;
    };
    return {
      content: body.content ?? '',
      success: Boolean(body.success),
      promptTokens: Number(body.promptTokens ?? 0),
      completionTokens: Number(body.completionTokens ?? 0),
      error: body.error,
    };
  } catch (err) {
    const aborted = handleFetchAbort(err, externalSignal, timeoutMs, vendor);
    if (aborted) return aborted;
    const message = corsHint(err);
    return {
      content: `【调用异常】${message}`,
      success: false,
      promptTokens: 0,
      completionTokens: 0,
      error: message,
    };
  }
}

async function callOpenAiCompatible(
  config: LlmInvokeConfig,
  userContent: string,
  systemPrompt: string | null | undefined,
  maxTokens: number,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<ChatResult> {
  const url = openAiCompatibleUrl(config);
  const payload = {
    model: config.apiModel,
    messages: buildMessages(userContent, systemPrompt),
    max_tokens: maxTokens,
    temperature: 0.7,
    stream: false,
  };
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };
  const vendor =
    config.vendor ?? inferVendorFromEndpoint(config.apiEndpoint, config.name ?? '');
  try {
    const { ok, status, data, raw } = await httpPostWithRetry(
      url,
      headers,
      payload,
      timeoutMs,
      externalSignal,
      vendor,
    );
    if (!ok) {
      return {
        content: `【调用失败】${parseErrorMessage(data, status, raw)}`,
        success: false,
        promptTokens: 0,
        completionTokens: 0,
        error: parseErrorMessage(data, status, raw),
      };
    }
    const content = extractOpenAiContent(data);
    const { pt, ct } = usageFromOpenAi(data);
    return {
      content: content || '（模型返回空内容）',
      success: Boolean(content),
      promptTokens: pt,
      completionTokens: ct,
    };
  } catch (err) {
    const aborted = handleFetchAbort(err, externalSignal, timeoutMs, vendor);
    if (aborted) return aborted;
    const message = corsHint(err);
    return {
      content: `【调用异常】${message}`,
      success: false,
      promptTokens: 0,
      completionTokens: 0,
      error: message,
    };
  }
}

async function callDeepseek(
  config: LlmInvokeConfig,
  userContent: string,
  systemPrompt: string | null | undefined,
  maxTokens: number,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<ChatResult> {
  const url = deepseekChatUrl(config);
  const payload = {
    model: config.apiModel || 'deepseek-chat',
    messages: buildMessages(userContent, systemPrompt),
    max_tokens: maxTokens,
    temperature: 0.7,
    thinking: { type: 'disabled' },
    stream: false,
  };
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };
  const vendor =
    config.vendor ?? inferVendorFromEndpoint(config.apiEndpoint, config.name ?? '');
  try {
    const { ok, status, data, raw } = await httpPostWithRetry(
      url,
      headers,
      payload,
      timeoutMs,
      externalSignal,
      vendor,
    );
    if (!ok) {
      return {
        content: `【调用失败】${parseErrorMessage(data, status, raw)}`,
        success: false,
        promptTokens: 0,
        completionTokens: 0,
      };
    }
    const content = extractOpenAiContent(data);
    const { pt, ct } = usageFromOpenAi(data);
    return {
      content: content || '（模型返回空内容）',
      success: Boolean(content),
      promptTokens: pt,
      completionTokens: ct,
    };
  } catch (err) {
    const aborted = handleFetchAbort(err, externalSignal, timeoutMs, vendor);
    if (aborted) return aborted;
    const message = corsHint(err);
    return {
      content: `【调用异常】${message}`,
      success: false,
      promptTokens: 0,
      completionTokens: 0,
      error: message,
    };
  }
}

async function callQwen(
  config: LlmInvokeConfig,
  userContent: string,
  systemPrompt: string | null | undefined,
  maxTokens: number,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<ChatResult> {
  const base = config.apiEndpoint.trim().replace(/\/+$/, '');
  if (base.includes('compatible-mode')) {
    return callOpenAiCompatible(
      config,
      userContent,
      systemPrompt,
      maxTokens,
      timeoutMs,
      externalSignal,
    );
  }
  const url = `${base}/services/aigc/text-generation/generation`;
  const payload = {
    model: config.apiModel,
    input: { messages: buildMessages(userContent, systemPrompt) },
    parameters: {
      result_format: 'message',
      max_tokens: maxTokens,
      temperature: 0.7,
    },
  };
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };
  const vendor =
    config.vendor ?? inferVendorFromEndpoint(config.apiEndpoint, config.name ?? '');
  try {
    const { ok, status, data, raw } = await httpPostWithRetry(
      url,
      headers,
      payload,
      timeoutMs,
      externalSignal,
      vendor,
    );
    if (!ok) {
      return {
        content: `【调用失败】${parseErrorMessage(data, status, raw)}`,
        success: false,
        promptTokens: 0,
        completionTokens: 0,
      };
    }
    let content = '';
    if (data && typeof data === 'object') {
      const d = data as {
        output?: { choices?: Array<{ message?: { content?: string } }> };
      };
      content = d.output?.choices?.[0]?.message?.content ?? extractOpenAiContent(data);
    }
    return {
      content: content || '（模型返回空内容）',
      success: Boolean(content),
      promptTokens: 0,
      completionTokens: 0,
    };
  } catch (err) {
    const aborted = handleFetchAbort(err, externalSignal, timeoutMs, vendor);
    if (aborted) return aborted;
    const message = corsHint(err);
    return {
      content: `【调用异常】${message}`,
      success: false,
      promptTokens: 0,
      completionTokens: 0,
      error: message,
    };
  }
}

export async function chatCompletion(
  userContent: string,
  config: LlmInvokeConfig,
  options?: {
    systemPrompt?: string | null;
    maxTokens?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<ChatResult> {
  if (!config.apiKey?.trim()) {
    return {
      content: '【配置错误】请先在右侧模型设置中填写 API Key（仅保存在浏览器）',
      success: false,
      promptTokens: 0,
      completionTokens: 0,
    };
  }

  const vendor =
    config.vendor ?? inferVendorFromEndpoint(config.apiEndpoint, config.name ?? '');
  const defs = getRegistryDefaults();
  const vconf = getVendorConfig(vendor);
  const maxTokens = options?.maxTokens ?? defs.maxTokens;
  const timeoutMs = resolveTimeoutMs(vendor, options?.timeoutMs);
  const invokeConfig = { ...config, vendor };
  const signal = options?.signal;

  if (vendor === 'spark') {
    invokeConfig.apiModel = normalizeSparkModel(config.apiModel);
  }

  if (needsBrowserProxy(vendor)) {
    return callViaBackendProxy(
      invokeConfig,
      userContent,
      options?.systemPrompt,
      maxTokens,
      timeoutMs,
      signal,
    );
  }

  if (vendor === 'deepseek') {
    return callDeepseek(
      invokeConfig,
      userContent,
      options?.systemPrompt,
      maxTokens,
      timeoutMs,
      signal,
    );
  }
  if (vendor === 'qwen') {
    return callQwen(
      invokeConfig,
      userContent,
      options?.systemPrompt,
      maxTokens,
      timeoutMs,
      signal,
    );
  }

  const lower = config.apiEndpoint.toLowerCase();
  const blockedHosts = (vconf.blockedHosts ?? vconf.blocked_hosts) as string[] | undefined;
  const cursorBlocked =
    blockedHosts?.some((h) => lower.includes(String(h).toLowerCase())) ??
    CURSOR_OFFICIAL_HOSTS.some((h) => lower.includes(h));
  if (vendor === 'cursor' && cursorBlocked) {
    return {
      content: '【配置错误】Cursor 官方域名不支持 OpenAI 兼容 Chat，请填写自建代理地址',
      success: false,
      promptTokens: 0,
      completionTokens: 0,
    };
  }

  return callOpenAiCompatible(
    invokeConfig,
    userContent,
    options?.systemPrompt,
    maxTokens,
    timeoutMs,
    signal,
  );
}

export function toLlmConfig(model: {
  name: string;
  apiEndpoint: string;
  apiModel: string;
  vendor?: string;
}, apiKey: string): LlmInvokeConfig {
  return {
    name: model.name,
    apiEndpoint: model.apiEndpoint,
    apiModel: model.apiModel,
    apiKey,
    vendor: (model.vendor as VendorType | undefined) ?? inferVendorFromEndpoint(model.apiEndpoint, model.name),
  };
}
