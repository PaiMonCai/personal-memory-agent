/** 领域类型：与 database/001_baseline.sql 中的列一一对应 */

export type Kind = 'idea' | 'material' | 'todo' | 'note'
export type Status = 'inbox' | 'active' | 'done' | 'archived'
export type Priority = 'high' | 'normal' | 'low'
export type AiState = 'pending' | 'done' | 'failed'

export interface Entry {
  id: number
  owner_id?: string
  raw_text: string
  title: string | null
  kind: Kind | null
  summary: string | null
  key_points: string[]
  action_items: string[]
  tags: string[]
  status: Status
  priority: Priority
  due_date: string | null
  ai_state: AiState
  created_at: string
  updated_at: string
}

export interface EntryLink {
  id: number
  owner_id?: string
  source_id: number
  target_id: number
  reason: string | null
  created_at?: string
}

export interface Review {
  id: number
  period_label: string
  range_start: string | null
  range_end: string | null
  summary: string | null
  actions: string[]
  stats: Record<string, unknown>
  entry_count: number
  created_at: string
}

export interface ModelInfo {
  id: string
  provider?: string
  owned_by?: string
  disabled?: boolean
  enabled?: boolean
}

/* ------------------------------------------------------------ 设置 */

export type AiMode = 'cloud' | 'custom'

export interface VendorModel {
  id: string
  name: string
}

export interface Vendor {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: VendorModel[]
}

export interface ThemeSettings {
  preset: string
  accent: string
  bgFrom: string
  bgTo: string
  bgImage: string
  blur: number
  dim: number
  radius: number
  dark: boolean
  compact: boolean
}

export interface EffectSettings {
  type: string
  intensity: number
  speed: number
  custom: { code: string }
}

export interface AiSettings {
  mode: AiMode
  modelId: string
  temperature: number
  maxTokens: number
  custom: { pick: string; vendors: Vendor[] }
}

export interface Settings {
  theme: ThemeSettings
  effect: EffectSettings
  ai: AiSettings
}

export type PreferencesRow = Partial<Settings> & { owner_id?: string; updated_at?: string }

/* ------------------------------------------------------- AI 调用结果 */

export interface AnalysisResult {
  kind: Kind
  title: string
  summary: string
  key_points: string[]
  action_items: string[]
  tags: string[]
  priority: Priority
  due_date: string | null
  related_ids: number[]
  related_reason: string
}

export interface ReviewResult {
  summary: string
  themes: string[]
  actions: string[]
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
