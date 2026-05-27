import type { ModelPreset, ModelRegistry } from '@/types';

let cachedRegistry: ModelRegistry | null = null;

export function setModelRegistry(registry: ModelRegistry): void {
  cachedRegistry = registry;
}

export function getModelRegistry(): ModelRegistry | null {
  return cachedRegistry;
}

export function getRegistryDefaults(): {
  timeoutSeconds: number;
  maxTokens: number;
  temperature: number;
  evalMaxTokens: number;
  evalTimeoutSeconds: number;
  retryMaxAttempts: number;
  retryBaseDelaySeconds: number;
} {
  const g = cachedRegistry?.globalDefaults ?? {};
  return {
    timeoutSeconds: Number(g.timeoutSeconds ?? g.timeout_seconds ?? 60),
    maxTokens: Number(g.maxTokens ?? g.max_tokens ?? 1024),
    temperature: Number(g.temperature ?? 0.7),
    evalMaxTokens: Number(g.evalMaxTokens ?? g.eval_max_tokens ?? 800),
    evalTimeoutSeconds: Number(g.evalTimeoutSeconds ?? g.eval_timeout_seconds ?? 60),
    retryMaxAttempts: Number(g.retryMaxAttempts ?? g.retry_max_attempts ?? 3),
    retryBaseDelaySeconds: Number(g.retryBaseDelaySeconds ?? g.retry_base_delay_seconds ?? 1.5),
  };
}

export function getVendorConfig(vendor: string): Record<string, unknown> {
  const vendors = cachedRegistry?.vendors ?? {};
  return (vendors[vendor] as Record<string, unknown> | undefined)
    ?? (vendors.openai_compatible as Record<string, unknown> | undefined)
    ?? {};
}

export function listEnabledPresets(): ModelPreset[] {
  return cachedRegistry?.presets ?? [];
}

export function getPresetById(presetId: string): ModelPreset | undefined {
  return listEnabledPresets().find((p) => p.presetId === presetId);
}

export function presetToFormValues(preset: ModelPreset): {
  name: string;
  apiEndpoint: string;
  apiModel: string;
} {
  return {
    name: preset.name,
    apiEndpoint: preset.apiEndpoint,
    apiModel: preset.apiModel,
  };
}
