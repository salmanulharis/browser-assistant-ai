import { z } from 'zod';
import { ActionPlanSchema } from '@/types/page';

export interface ApiErrorBody { code: string; message: string; hint?: string | null; details?: Record<string, unknown> }

export type SourceType = 'page' | 'selection' | 'tab' | 'memory' | 'document' | 'conversation' | 'sample' | 'instruction';

export interface Source {
  id: string;
  type: SourceType;
  title: string;
  url?: string | null;
  ref_id?: string | null;
  location?: string | null;
  snippet: string;
  score?: number | null;
  cited?: boolean;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sources?: Source[] | null;
  model?: string | null;
  stats?: Record<string, unknown> | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  title: string;
  page_url: string | null;
  page_title: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  messages?: Message[];
}

export interface Memory {
  id: string;
  content: string;
  title: string | null;
  category: string | null;
  source: 'user' | 'auto' | 'import';
  status: 'active' | 'pending' | 'disabled';
  pinned: boolean;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryCategory { id: number; name: string; description: string | null; auto_allowed: boolean }

export interface DocumentInfo {
  id: string;
  original_name: string;
  extension: string;
  size_bytes: number;
  collection: string;
  source_url: string | null;
  status: 'pending' | 'processing' | 'indexed' | 'failed';
  error: string | null;
  chunk_count: number;
  char_count: number;
  embedded_model: string | null;
  created_at: string;
  updated_at: string;
  preview?: { chunk_index: number; content: string; location: string | null; token_estimate: number }[];
  duplicate?: boolean;
}

export interface KnowledgeHit { document_id: string; document_name: string; chunk_index: number; location: string | null; content: string; score: number }

export interface PromptItem {
  id: string;
  title: string;
  content: string;
  kind: 'prompt' | 'sample';
  category: string | null;
  tags: string[];
  pinned: boolean;
  use_count: number;
  created_at: string;
  updated_at: string;
}

export interface ModelInfo {
  name: string;
  size_bytes: number | null;
  family: string | null;
  parameter_size: string | null;
  quantization: string | null;
  context_length: number | null;
  capabilities: string[];
  kind: 'chat' | 'embedding' | 'vision';
  selected_as: string[];
}

export interface ModelsResponse {
  reachable: boolean;
  ollama_url: string;
  version: string | null;
  models: ModelInfo[];
  selected: Record<string, string>;
  missing: string[];
  suggestions: { name: string; kind: string; why: string }[];
  error: ApiErrorBody | null;
}

export const AppSettingsSchema = z.object({
  ollama_url: z.string(),
  chat_model: z.string(),
  embedding_model: z.string(),
  vision_model: z.string(),
  temperature: z.number(),
  context_length: z.number(),
  request_timeout: z.number(),
  generation_timeout: z.number(),
  streaming: z.boolean(),
  think: z.boolean(),
  local_only: z.boolean(),
  rag_top_k: z.number(),
  chunk_size_tokens: z.number(),
  chunk_overlap_tokens: z.number(),
  min_relevance: z.number(),
  max_page_context_chars: z.number(),
  auto_memory_mode: z.enum(['off', 'ask', 'auto']),
  auto_memory_categories: z.array(z.string()),
  memory_retrieval: z.boolean(),
  memory_top_k: z.number(),
  cross_conversation_retrieval: z.boolean(),
  conversation_retention_days: z.number(),
  recent_messages: z.number(),
  summarize_after_messages: z.number(),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export type DiagStatus = 'healthy' | 'warning' | 'failed' | 'not_configured' | 'permission_required' | 'not_verifiable' | 'skipped' | 'testing';

export interface CheckResult {
  id: string;
  group: string;
  name: string;
  status: DiagStatus;
  message: string;
  hint?: string | null;
  duration_ms?: number;
  details?: Record<string, unknown>;
  action?: { label: string; run: () => Promise<void> | void } | null;
}

export interface DiagnosticRun {
  id: string;
  level: string;
  started_at: string;
  finished_at: string | null;
  summary: { overall: string; healthy: number; warnings: number; failed: number; counts: Record<string, number> };
  results: CheckResult[];
}

export const BrowserTaskSchema = z.object({
  id: z.string(),
  task: z.string(),
  page_url: z.string().nullable(),
  status: z.string(),
  plan: ActionPlanSchema,
  blocked: z.array(z.object({ action: z.record(z.string(), z.unknown()), reason: z.string() })),
  model: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  logs: z.array(z.record(z.string(), z.unknown())).default([]),
  sources: z.array(z.any()).optional(),
  warnings: z.array(z.string()).optional(),
});
export type BrowserTask = z.infer<typeof BrowserTaskSchema>;

export interface FieldSuggestion { ref: string; value: string; confidence: 'high' | 'medium' | 'low'; note: string; source_ids: string[] }
export interface FormGenerateResponse { suggestions: FieldSuggestion[]; skipped: { ref: string; reason: string }[]; sources: Source[]; model: string }

export interface SseEvent { event: string; data: any }
