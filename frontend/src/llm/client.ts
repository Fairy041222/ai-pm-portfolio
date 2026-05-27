/**
 * NFR-M3：模型调用层统一入口（展示层通过 AppContext/API，本层负责厂商 HTTP）
 */
export {
  chatCompletion as chat,
  chatCompletion,
  toLlmConfig,
  type ChatResult,
  type LlmInvokeConfig,
} from '@/services/llmClient';

import { chatCompletion, toLlmConfig, type ChatResult, type LlmInvokeConfig } from '@/services/llmClient';
import { getRegistryDefaults } from '@/services/modelRegistryCache';
import type { Model } from '@/types';

export const LlmClient = {
  defaults: getRegistryDefaults,

  chat(
    userContent: string,
    config: LlmInvokeConfig,
    options?: { systemPrompt?: string | null; maxTokens?: number; timeoutMs?: number },
  ): Promise<ChatResult> {
    const defs = getRegistryDefaults();
    return chatCompletion(userContent, config, {
      ...options,
      maxTokens: options?.maxTokens ?? defs.maxTokens,
      timeoutMs: options?.timeoutMs ?? defs.timeoutSeconds * 1000,
    });
  },

  toConfig(model: Pick<Model, 'name' | 'apiEndpoint' | 'apiModel' | 'vendor'>, apiKey: string) {
    return toLlmConfig(model, apiKey);
  },
};
