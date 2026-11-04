import { create } from 'zustand';
import { api, ApiError, describeError, health, pair } from '@/services/api';
import { loadConfig, onConfigChange, saveConfig } from '@/services/config';
import { listModels } from '@/services/ollama';
import { AppSettingsSchema, type AppSettings, type ModelsResponse } from '@/types/api';
import { DEFAULT_CONFIG, type ExtensionConfig } from '@/types/config';

export type Page = 'chat' | 'knowledge' | 'memory' | 'history' | 'prompts' | 'diagnostics' | 'settings';
export type Connection = 'checking' | 'ok' | 'backend-down' | 'unauthorized' | 'unpaired';

interface AppState {
  page: Page;
  config: ExtensionConfig;
  configLoaded: boolean;
  connection: Connection;
  connectionError: { message: string; hint?: string | null } | null;
  backendVersion: string | null;
  settings: AppSettings | null;
  models: ModelsResponse | null;
  modelsLoading: boolean;
  setPage: (p: Page) => void;
  init: () => Promise<void>;
  updateConfig: (patch: Partial<ExtensionConfig>) => Promise<void>;
  checkConnection: () => Promise<Connection>;
  tryPair: () => Promise<boolean>;
  refreshSettings: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  refreshModels: () => Promise<void>;
}

export const useApp = create<AppState>((set, get) => ({
  page: 'chat',
  config: DEFAULT_CONFIG,
  configLoaded: false,
  connection: 'checking',
  connectionError: null,
  backendVersion: null,
  settings: null,
  models: null,
  modelsLoading: false,

  setPage: (page) => set({ page }),

  init: async () => {
    const config = await loadConfig();
    set({ config, configLoaded: true });
    onConfigChange((c) => set({ config: c }));
    const conn = await get().checkConnection();
    if (conn === 'ok') {
      await Promise.allSettled([get().refreshSettings(), get().refreshModels()]);
    }
  },

  updateConfig: async (patch) => {
    const next = await saveConfig(patch);
    set({ config: next });
  },

  checkConnection: async () => {
    set({ connection: 'checking', connectionError: null });
    try {
      const h = await health();
      set({ backendVersion: h.version });
    } catch (e) {
      set({ connection: 'backend-down', connectionError: describeError(e) });
      return 'backend-down';
    }
    if (!get().config.token) {
      const paired = await get().tryPair();
      if (!paired) {
        set({ connection: 'unpaired' });
        return 'unpaired';
      }
    }
    try {
      await api.get('/auth/check', { timeoutMs: 5000 });
      set({ connection: 'ok' });
      return 'ok';
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // token rotated? try pairing once more
        if (await get().tryPair()) {
          set({ connection: 'ok' });
          return 'ok';
        }
        set({ connection: 'unauthorized', connectionError: describeError(e) });
        return 'unauthorized';
      }
      set({ connection: 'backend-down', connectionError: describeError(e) });
      return 'backend-down';
    }
  },

  tryPair: async () => {
    try {
      const token = await pair();
      set({ config: { ...get().config, token } });
      return true;
    } catch {
      return false;
    }
  },

  refreshSettings: async () => {
    const raw = await api.get<unknown>('/settings');
    set({ settings: AppSettingsSchema.parse(raw) });
  },

  updateSettings: async (patch) => {
    const raw = await api.put<unknown>('/settings', patch);
    const s = AppSettingsSchema.parse(raw);
    set({ settings: s });
    return s;
  },

  refreshModels: async () => {
    set({ modelsLoading: true });
    try {
      set({ models: await listModels() });
    } finally {
      set({ modelsLoading: false });
    }
  },
}));
