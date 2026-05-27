/** NFR-P1：API Key 仅保存在浏览器 localStorage，不上传后端。 */

const STORAGE_KEY = 'aipm-bench-model-keys';
const FINGERPRINT_KEY = 'aipm-bench-model-keys-fp';

type KeyMap = Record<string, string>;

export interface ModelKeyMeta {
  name: string;
  apiEndpoint: string;
  apiModel: string;
}

function readMap(storageKey: string): KeyMap {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const map: KeyMap = {};
    for (const [id, key] of Object.entries(parsed)) {
      if (typeof key === 'string' && key.trim()) {
        map[id] = key.trim();
      }
    }
    return map;
  } catch {
    return {};
  }
}

function writeMap(storageKey: string, map: KeyMap): void {
  localStorage.setItem(storageKey, JSON.stringify(map));
}

export function modelKeyFingerprint(meta: ModelKeyMeta): string {
  return [
    meta.name.trim().toLowerCase(),
    meta.apiEndpoint.trim().toLowerCase(),
    meta.apiModel.trim().toLowerCase(),
  ].join('|');
}

function getModelApiKeyByFingerprint(fp: string): string | null {
  return readMap(FINGERPRINT_KEY)[fp] ?? null;
}

function setModelApiKeyByFingerprint(fp: string, apiKey: string): void {
  const map = readMap(FINGERPRINT_KEY);
  const trimmed = apiKey.trim();
  if (!trimmed) {
    delete map[fp];
  } else {
    map[fp] = trimmed;
  }
  writeMap(FINGERPRINT_KEY, map);
}

export function getModelApiKey(modelId: string): string | null {
  return readMap(STORAGE_KEY)[modelId] ?? null;
}

/** 按 modelId 或「名称+端点+model」指纹读取 Key（应对 DB 重置后 id 变化） */
export function resolveModelApiKey(
  model: { id: string } & Partial<ModelKeyMeta>,
): string | null {
  const byId = getModelApiKey(model.id);
  if (byId) return byId;
  if (model.name && model.apiEndpoint && model.apiModel) {
    const fp = modelKeyFingerprint({
      name: model.name,
      apiEndpoint: model.apiEndpoint,
      apiModel: model.apiModel,
    });
    const byFp = getModelApiKeyByFingerprint(fp);
    if (byFp) {
      // 回填到当前 modelId，避免下次再查指纹
      setModelApiKey(model.id, byFp, {
        name: model.name,
        apiEndpoint: model.apiEndpoint,
        apiModel: model.apiModel,
      });
      return byFp;
    }
  }
  return null;
}

export function setModelApiKey(
  modelId: string,
  apiKey: string,
  meta?: ModelKeyMeta,
): void {
  const trimmed = apiKey.trim();
  const map = readMap(STORAGE_KEY);
  if (!trimmed) {
    delete map[modelId];
  } else {
    map[modelId] = trimmed;
  }
  writeMap(STORAGE_KEY, map);

  if (meta && trimmed) {
    setModelApiKeyByFingerprint(modelKeyFingerprint(meta), trimmed);
  }
}

export function removeModelApiKey(modelId: string, meta?: ModelKeyMeta): void {
  const map = readMap(STORAGE_KEY);
  delete map[modelId];
  writeMap(STORAGE_KEY, map);
  if (meta) {
    const fpMap = readMap(FINGERPRINT_KEY);
    delete fpMap[modelKeyFingerprint(meta)];
    writeMap(FINGERPRINT_KEY, fpMap);
  }
}

export function hasModelApiKey(
  model: { id: string } & Partial<ModelKeyMeta>,
): boolean {
  return Boolean(resolveModelApiKey(model));
}

export function maskStoredApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

export function mergeModelWithLocalKey<T extends {
  id: string;
  name?: string;
  apiEndpoint?: string;
  apiModel?: string;
  hasApiKey?: boolean;
  apiKeyMasked?: string | null;
}>(model: T): T {
  const key = resolveModelApiKey({
    id: model.id,
    name: model.name ?? '',
    apiEndpoint: model.apiEndpoint ?? '',
    apiModel: model.apiModel ?? '',
  });
  return {
    ...model,
    hasApiKey: Boolean(key),
    apiKeyMasked: key ? maskStoredApiKey(key) : null,
  };
}

export function mergeModelsWithLocalKeys<T extends {
  id: string;
  name?: string;
  apiEndpoint?: string;
  apiModel?: string;
  hasApiKey?: boolean;
  apiKeyMasked?: string | null;
}>(models: T[]): T[] {
  return models.map(mergeModelWithLocalKey);
}

/** 启动时：为所有模型尝试从指纹库恢复 Key */
export function reconcileModelKeysFromModels(
  models: Array<{ id: string; name: string; apiEndpoint: string; apiModel: string }>,
): void {
  for (const model of models) {
    resolveModelApiKey(model);
  }
}
