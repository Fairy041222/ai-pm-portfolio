/** NFR-P5：前端防恶意调用（每日次数 + 发送冷却） */

const DAILY_STORAGE_KEY = 'aipm-bench-eval-daily';
export const DAILY_LIMIT = 20;
export const SEND_COOLDOWN_MS = 10_000;

interface DailyRecord {
  date: string;
  count: number;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function readDailyRecord(): DailyRecord {
  try {
    const raw = localStorage.getItem(DAILY_STORAGE_KEY);
    if (!raw) return { date: todayKey(), count: 0 };
    const parsed = JSON.parse(raw) as DailyRecord;
    if (parsed.date !== todayKey()) {
      return { date: todayKey(), count: 0 };
    }
    return { date: parsed.date, count: Number(parsed.count) || 0 };
  } catch {
    return { date: todayKey(), count: 0 };
  }
}

function writeDailyRecord(record: DailyRecord): void {
  localStorage.setItem(DAILY_STORAGE_KEY, JSON.stringify(record));
}

export function getDailyEvalCount(): number {
  return readDailyRecord().count;
}

export function getDailyEvalRemaining(): number {
  return Math.max(0, DAILY_LIMIT - getDailyEvalCount());
}

export function isDailyQuotaExhausted(): boolean {
  return getDailyEvalCount() >= DAILY_LIMIT;
}

export function checkDailyEvalLimit(): { allowed: boolean; remaining: number; count: number } {
  const count = getDailyEvalCount();
  const remaining = Math.max(0, DAILY_LIMIT - count);
  return { allowed: count < DAILY_LIMIT, remaining, count };
}

/** 与后端计数对齐（取较大值，防止前后端漂移） */
export function syncDailyEvalCountFromBackend(backendCount: number): void {
  const record = readDailyRecord();
  const next = Math.max(record.count, Math.max(0, backendCount));
  writeDailyRecord({ date: todayKey(), count: next });
}

export function recordEvalStart(): void {
  const record = readDailyRecord();
  writeDailyRecord({ date: todayKey(), count: record.count + 1 });
}

export function getDailyLimitBannerMessage(): string {
  return `今日评测次数已达上限（${DAILY_LIMIT}/${DAILY_LIMIT}），请明日再试。您仍可查看下方历史报告。`;
}

export function getDailyLimitMessage(): string {
  return getDailyLimitBannerMessage();
}

let sendCooldownUntil = 0;

export function beginSendCooldown(): void {
  sendCooldownUntil = Date.now() + SEND_COOLDOWN_MS;
}

export function getSendCooldownRemainingMs(): number {
  return Math.max(0, sendCooldownUntil - Date.now());
}

export function isSendCooldownActive(): boolean {
  return getSendCooldownRemainingMs() > 0;
}
