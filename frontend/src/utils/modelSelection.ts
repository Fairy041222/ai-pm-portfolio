import type { Model } from '@/types';

export interface ResolvedModelsForSend {
  modelIds: string[];
  usedDefault: boolean;
  displayNames: string[];
}

function pickDefaultModel(models: Model[]): Model | undefined {
  if (models.length === 0) return undefined;
  return models.find((m) => m.isRecommended) ?? models[0];
}

/**
 * 解析发送消息时使用的模型 ID：
 * - 用户已勾选 → 使用用户选择（报告模式使用全部已选）
 * - 未勾选 → 使用推荐模型或列表中第一个
 */
export function resolveModelsForSend(
  selectedModelIds: string[],
  models: Model[],
  isReportMode: boolean,
): ResolvedModelsForSend {
  const selected = selectedModelIds.filter((id) => models.some((m) => m.id === id));

  if (selected.length > 0) {
    const names = selected.map((id) => models.find((m) => m.id === id)?.name ?? id);
    if (isReportMode) {
      return { modelIds: selected, usedDefault: false, displayNames: names };
    }
    return { modelIds: [selected[0]], usedDefault: false, displayNames: [names[0]] };
  }

  const fallback = pickDefaultModel(models);
  if (!fallback) {
    return { modelIds: [], usedDefault: true, displayNames: [] };
  }

  if (!isReportMode) {
    return {
      modelIds: [fallback.id],
      usedDefault: true,
      displayNames: [fallback.name],
    };
  }

  const second = models.find((m) => m.id !== fallback.id);
  if (second) {
    return {
      modelIds: [fallback.id, second.id],
      usedDefault: true,
      displayNames: [fallback.name, second.name],
    };
  }

  return {
    modelIds: [fallback.id],
    usedDefault: true,
    displayNames: [fallback.name],
  };
}
