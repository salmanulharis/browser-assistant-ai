import { useEffect } from 'react';
import { toast } from '@/components/common/toast';
import { readPage } from '@/services/page-reader';
import { getTab } from '@/services/tabs';
import { useApp } from '@/stores/app';
import { useChat } from '@/stores/chat';
import { PENDING_KEY, PendingSchema, type Pending } from '@/types/messages';
import type { PageContext } from '@/types/page';

const emptyPage = (url: string, title: string, selected: string): PageContext => ({
  url, title, description: '', lang: '', site_name: '', headings: [], main_text: '', paragraphs: [], lists: [], tables: [],
  code_blocks: [], links: [], selected_text: selected, forms: [], content_hash: '', truncated: false,
});

async function handle(p: Pending): Promise<void> {
  const chat = useChat.getState();
  useApp.getState().setPage('chat');
  if (p.kind === 'page') {
    chat.setHandoffPage(p.page as unknown as PageContext);
    toast('Page received from the floating assistant.', 'ok');
  } else if (p.kind === 'selection') {
    chat.setHandoffPage(emptyPage(p.url, p.title, p.text));
    chat.setToggles({ selection: true });
    toast('Selection added as context. Ask your question below.', 'ok');
  } else if (p.kind === 'read') {
    const tab = await getTab(p.tabId);
    try {
      chat.setHandoffPage(await readPage(p.tabId, tab?.url));
      toast('Page captured.', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad');
    }
  }
}

/** Consumes hand-offs from the context menu, keyboard shortcuts and floating assistant. */
export function usePendingHandoff(): void {
  useEffect(() => {
    const consume = async () => {
      const raw = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY];
      if (!raw) return;
      await chrome.storage.session.remove(PENDING_KEY);
      const parsed = PendingSchema.safeParse(raw);
      if (parsed.success && Date.now() - parsed.data.at < 5 * 60_000) await handle(parsed.data);
    };
    void consume();
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[PENDING_KEY]?.newValue) void consume();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
}
