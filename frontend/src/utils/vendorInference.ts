/** 根据 API 地址与名称推断厂商（与后端 endpoint_inference 对齐） */

export type VendorType =
  | 'deepseek'
  | 'qwen'
  | 'cursor'
  | 'spark'
  | 'tencent'
  | 'openai_compatible';

export function inferVendorFromEndpoint(url: string, name = ''): VendorType {
  const text = `${url} ${name}`.toLowerCase();
  if (
    text.includes('xf-yun.com') ||
    text.includes('spark-api-open') ||
    text.includes('讯飞')
  ) {
    return 'spark';
  }
  if (
    text.includes('tencent') ||
    text.includes('hunyuan') ||
    text.includes('hy3') ||
    text.includes('cloud.tencent.com')
  ) {
    return 'tencent';
  }
  if (text.includes('dashscope') || text.includes('aliyuncs')) {
    return 'qwen';
  }
  if (text.includes('deepseek')) {
    return 'deepseek';
  }
  if (text.includes('cursor') || text.includes('cursor.sh')) {
    return 'cursor';
  }
  return 'openai_compatible';
}

export function normalizeSparkModel(model: string): string {
  const m = model.trim().toLowerCase();
  if (m === 'default' || !m) return 'lite';
  return m;
}
