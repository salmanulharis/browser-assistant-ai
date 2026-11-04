/**
 * Ollama model management. The extension never talks to Ollama directly – all
 * calls go through the local backend, which owns the Ollama client.
 */
import { api, stream } from '@/services/api';
import type { ModelInfo, ModelsResponse } from '@/types/api';

export const listModels = () => api.get<ModelsResponse>('/models', { timeoutMs: 15000 });

export const showModel = (model: string) => api.post<Record<string, unknown>>('/models/show', { model });

export const testModel = (model: string, kind: 'chat' | 'embedding' | 'vision') =>
  api.post<{ ok: boolean; model: string; kind: string; duration_ms: number; result: string; details: Record<string, unknown> }>(
    '/models/test', { model, kind }, { timeoutMs: 300_000 });

/** Download a model. Callers MUST have shown a confirmation dialog first. */
export async function* pullModel(model: string, signal?: AbortSignal) {
  yield* stream('/models/pull', { model, confirm: true }, signal);
}

export function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

export function modelsOfKind(models: ModelInfo[], kind: 'chat' | 'embedding' | 'vision'): ModelInfo[] {
  if (kind === 'chat') return models.filter((m) => m.kind !== 'embedding');
  if (kind === 'vision') return models.filter((m) => m.capabilities.includes('vision'));
  return models.filter((m) => m.kind === 'embedding' || m.capabilities.includes('embedding'));
}
