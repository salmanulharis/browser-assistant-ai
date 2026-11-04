import { CONFIG_KEY, DEFAULT_CONFIG, ExtensionConfigSchema, type ExtensionConfig } from '@/types/config';

/** Load + validate the extension configuration. Invalid stored values fall back to defaults. */
export async function loadConfig(): Promise<ExtensionConfig> {
  const raw = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY];
  const parsed = ExtensionConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { ...DEFAULT_CONFIG, token: (raw as Partial<ExtensionConfig>)?.token ?? '' };
}

export async function saveConfig(patch: Partial<ExtensionConfig>): Promise<ExtensionConfig> {
  const current = await loadConfig();
  const next = ExtensionConfigSchema.parse({ ...current, ...patch });
  await chrome.storage.local.set({ [CONFIG_KEY]: next });
  return next;
}

export function onConfigChange(cb: (cfg: ExtensionConfig) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[CONFIG_KEY]) {
      const parsed = ExtensionConfigSchema.safeParse(changes[CONFIG_KEY].newValue ?? {});
      if (parsed.success) cb(parsed.data);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
