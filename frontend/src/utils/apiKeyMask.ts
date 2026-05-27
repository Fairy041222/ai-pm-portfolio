/** 判断是否为后端返回或 UI 占位用的掩码 Key（不应提交覆盖） */
export function isMaskedApiKey(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  return v.includes('*') || v.includes('•') || v.includes('…');
}

/** 编辑提交时解析 API Key 字段 */
export function resolveApiKeyForUpdate(
  apiKey: string,
  options: { hadKey: boolean; userCleared?: boolean },
): { apiKey?: string; clearApiKey?: boolean } {
  const trimmed = apiKey.trim();

  if (isMaskedApiKey(apiKey)) {
    return {};
  }

  if (!trimmed) {
    if (options.userCleared && options.hadKey) {
      return { clearApiKey: true, apiKey: '' };
    }
    if (!options.hadKey) {
      return { apiKey: '' };
    }
    return {};
  }

  return { apiKey: trimmed };
}
