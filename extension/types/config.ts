import { z } from 'zod';
import { DEFAULT_EXCLUDED_SITES } from '@/utils/sensitive';

export const ContextTogglesSchema = z.object({
  page: z.boolean().default(true),
  selection: z.boolean().default(true),
  tabs: z.boolean().default(true),
  memory: z.boolean().default(true),
  knowledge: z.boolean().default(true),
  history: z.boolean().default(true),
  samples: z.boolean().default(true),
});
export type ContextToggles = z.infer<typeof ContextTogglesSchema>;

export const LauncherPosition = z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']);

/** Extension-side configuration (chrome.storage.local, key "lba.config"). */
export const ExtensionConfigSchema = z.object({
  backendUrl: z.string().url().default('http://127.0.0.1:8765'),
  token: z.string().default(''),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  fontSize: z.enum(['sm', 'md', 'lg']).default('md'),
  floating: z
    .object({
      enabled: z.boolean().default(true),
      position: LauncherPosition.default('bottom-right'),
      disabledSites: z.array(z.string()).default([]),
      offset: z.object({ x: z.number(), y: z.number() }).nullable().default(null),
    })
    .prefault({}),
  excludedSites: z.array(z.string()).default(DEFAULT_EXCLUDED_SITES),
  autoCapturePage: z.boolean().default(true),
  multiTab: z.boolean().default(true),
  automation: z.boolean().default(true),
  approvalMode: z.enum(['each', 'plan']).default('each'),
  contextDefaults: ContextTogglesSchema.prefault({}),
  instructions: z.string().max(4000).default(''),
  periodicHealthMinutes: z.number().int().min(0).max(240).default(0),
  includeScreenshot: z.boolean().default(false),
});
export type ExtensionConfig = z.infer<typeof ExtensionConfigSchema>;

export const DEFAULT_CONFIG: ExtensionConfig = ExtensionConfigSchema.parse({});
export const CONFIG_KEY = 'lba.config';
