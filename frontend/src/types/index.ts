export interface Conversation {
  id: string;
  title: string;
  date: string;
  recommendedModel: string;
  messages: Message[];
  /** 关联的评测报告 id，左侧展示「报告」标签 */
  relatedReportId?: string;
}

/** 左侧栏专用「报告对话」条目 */
export interface ReportConversation {
  id: string;
  title: string;
  date: string;
  reportData: ReportData;
}

export type MessageRole = 'user' | 'assistant';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  type?: 'text' | 'report';
  reportData?: ReportData;
  /** 助手回复实际使用的模型名称 */
  usedModelName?: string;
  /** 是否为系统自动选择的默认模型 */
  usedDefaultModel?: boolean;
}

export interface Model {
  id: string;
  name: string;
  apiEndpoint: string;
  /** 发往厂商 API 的 model 参数，如 hy3-preview、lite、deepseek-chat */
  apiModel: string;
  /** 厂商标识（由后端推断，浏览器直连时使用） */
  vendor?: string;
  hasApiKey: boolean;
  /** 掩码形式，仅用于编辑回显，如 sk-****db3 */
  apiKeyMasked?: string | null;
  isRecommended: boolean;
}

/** config/models.yaml 预设条目 */
export interface ModelPreset {
  presetId: string;
  name: string;
  enabled: boolean;
  vendor: string;
  apiEndpoint: string;
  apiModel: string;
  isRecommended: boolean;
  maxTokens: number;
  temperature: number;
  timeoutSeconds: number;
  description: string;
  adapter: string;
}

export interface ModelRegistry {
  version: number;
  globalDefaults: Record<string, unknown>;
  vendors: Record<string, unknown>;
  presets: ModelPreset[];
}

/** 添加/编辑模型 */
export interface ModelFormValues {
  name: string;
  apiEndpoint: string;
  apiModel: string;
  apiKey: string;
}

export type TestCaseStatus = 'success' | 'failure';

export interface TestCaseResult {
  id: string;
  input: string;
  output: string;
  time: string;
  status: TestCaseStatus;
}

export interface ModelConItem {
  text: string;
  level: 'error' | 'warning';
}

export interface ModelReport {
  id: string;
  name: string;
  successRate: string;
  avgTime: string;
  cost: string;
  pros: string[];
  cons: ModelConItem[];
  testCases: TestCaseResult[];
}

export interface ReportData {
  id: string;
  conversationId: string;
  generatedAt: string;
  testCaseCount: number;
  testCaseSummary: string;
  totalDuration: string;
  totalDurationSeconds: number;
  bestModel: string;
  recommendationReason: string;
  models: ModelReport[];
}

/** 评测任务实时进度（FR-11） */
export interface ClientEvalTestCase {
  id: string;
  input: string;
  category?: string;
}

export interface ClientEvalModelMeta {
  id: string;
  name: string;
  apiEndpoint: string;
  apiModel: string;
  vendor: string;
}

export interface EvaluationProgress {
  taskId: string;
  conversationId: string;
  progress: number;
  currentStep: string;
  completedCases: number;
  totalCases: number;
  estimatedRemainingSeconds: number;
  /** 预估评测总时长（秒） */
  estimatedTotalSeconds?: number;
  /** 参与评测的模型数量 */
  modelCount?: number;
  status: 'running' | 'completed' | 'failed';
  /** 报告数据库持久化状态 */
  persistStatus?: 'none' | 'pending' | 'saved' | 'failed';
  persistError?: string | null;
  error?: string | null;
  reportData?: ReportData | null;
  message?: Message | null;
  /** 浏览器端可开始模型评测 */
  clientEvalReady?: boolean;
  testCases?: ClientEvalTestCase[];
  modelsMeta?: ClientEvalModelMeta[];
  systemPrompt?: string;
}
