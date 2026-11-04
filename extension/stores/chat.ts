import { create } from 'zustand';
import { api, describeError, stream } from '@/services/api';
import { gatherContext, slimPage } from '@/services/context-manager';
import { canScript } from '@/services/page-reader';
import { getActiveTab, isRestrictedUrl, type TabSummary } from '@/services/tabs';
import { buildActionTask, isPageActionRequest } from '@/utils/intent';
import { useApp } from '@/stores/app';
import type { Conversation, Memory, Message, Source } from '@/types/api';
import type { ContextToggles } from '@/types/config';
import type { PageContext } from '@/types/page';

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  thinking?: string;
  streaming?: boolean;
  error?: { message: string; hint?: string | null } | null;
  invalidCitations?: string[];
  stats?: Record<string, unknown> | null;
  model?: string | null;
  /** Set when this assistant turn is a proposed set of page edits (reviewed before running). */
  action?: { task: string; tab: TabSummary } | null;
}

interface ChatState {
  conversationId: string | null;
  title: string;
  messages: ChatMsg[];
  streaming: boolean;
  abort: AbortController | null;
  notes: string[];
  toggles: ContextToggles;
  selectedTabIds: number[];
  attachedDocs: { id: string; name: string }[];
  modelOverride: string | null;
  memorySuggestions: Memory[];
  handoffPage: PageContext | null;
  forceRead: boolean;
  setToggles: (t: Partial<ContextToggles>) => void;
  setSelectedTabs: (ids: number[]) => void;
  attachDoc: (d: { id: string; name: string }) => void;
  detachDoc: (id: string) => void;
  setModelOverride: (m: string | null) => void;
  setHandoffPage: (p: PageContext | null) => void;
  setForceRead: (v: boolean) => void;
  send: (text: string, opts?: { regenerate?: boolean }) => Promise<void>;
  /** Plan edits on the active tab (fill/type/select/click) for approval, shown inline in chat. */
  act: (request: string, opts?: { display?: string; reference?: string }) => Promise<void>;
  stop: () => void;
  regenerate: () => Promise<void>;
  newConversation: () => void;
  clearContext: () => void;
  loadConversation: (id: string) => Promise<void>;
  dismissSuggestion: (id: string) => void;
}

let tempId = 0;
const tmp = () => `tmp-${++tempId}`;

function fromServer(m: Message): ChatMsg {
  return {
    id: m.id,
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
    sources: m.sources ?? undefined,
    stats: m.stats ?? null,
    model: m.model,
    thinking: (m.stats?.thinking as string | undefined) ?? undefined,
    invalidCitations: (m.stats?.invalid_citations as string[] | undefined) ?? [],
  };
}

async function captureScreenshot(tab: TabSummary): Promise<string | null> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    return dataUrl.split(',')[1] ?? null;
  } catch {
    return null;
  }
}

export const useChat = create<ChatState>((set, get) => ({
  conversationId: null,
  title: 'New conversation',
  messages: [],
  streaming: false,
  abort: null,
  notes: [],
  toggles: useApp.getState().config.contextDefaults,
  selectedTabIds: [],
  attachedDocs: [],
  modelOverride: null,
  memorySuggestions: [],
  handoffPage: null,
  forceRead: false,

  setToggles: (t) => set({ toggles: { ...get().toggles, ...t } }),
  setSelectedTabs: (ids) => set({ selectedTabIds: ids }),
  attachDoc: (d) => set({ attachedDocs: [...get().attachedDocs.filter((x) => x.id !== d.id), d] }),
  detachDoc: (id) => set({ attachedDocs: get().attachedDocs.filter((x) => x.id !== id) }),
  setModelOverride: (m) => set({ modelOverride: m }),
  setHandoffPage: (p) => set({ handoffPage: p }),
  setForceRead: (v) => set({ forceRead: v }),

  act: async (request, opts = {}) => {
    if (get().streaming) return;
    const userMsg: ChatMsg = { id: tmp(), role: 'user', content: opts.display ?? request };
    const fail = (message: string, hint?: string) =>
      set({ messages: [...get().messages, userMsg, { id: tmp(), role: 'assistant', content: '', error: { message, hint } }] });
    if (!useApp.getState().config.automation) {
      return fail('Page editing is turned off.', 'Enable “Browser automation” in Settings → Browser.');
    }
    const tab = await getActiveTab();
    if (!tab || isRestrictedUrl(tab.url)) return fail('There is no web page I can edit in this tab.', 'Switch to the tab with the form and try again.');
    const probe = await canScript(tab.id, tab.url);
    if (!probe.ok || !tab.url) {
      return fail('I need website access to fill or edit this page.', 'Click “Grant website access” at the top of the chat, then send the request again.');
    }
    const previous = opts.reference ?? [...get().messages].reverse().find((m) => m.role === 'assistant' && m.content && !m.action)?.content;
    const task = buildActionTask(request, previous);
    set({ messages: [...get().messages, userMsg, { id: tmp(), role: 'assistant', content: '', action: { task, tab } }] });
  },

  send: async (text, opts = {}) => {
    if (get().streaming) return;
    const app = useApp.getState();
    const cfg = app.config;
    const regenerate = !!opts.regenerate;
    if (!regenerate && cfg.automation && isPageActionRequest(text)) return get().act(text);
    const userMsg: ChatMsg = { id: tmp(), role: 'user', content: text };
    const assistant: ChatMsg = { id: tmp(), role: 'assistant', content: '', streaming: true };
    const abort = new AbortController();
    set({
      streaming: true,
      abort,
      notes: [],
      memorySuggestions: [],
      messages: regenerate ? [...get().messages, assistant] : [...get().messages, userMsg, assistant],
    });
    const patch = (fn: (m: ChatMsg) => ChatMsg) => set({ messages: get().messages.map((m) => (m.id === assistant.id ? fn(m) : m)) });

    try {
      const activeTab = await getActiveTab();
      const toggles = get().toggles;
      let page: PageContext | null = null;
      let notes: string[] = [];
      const handoff = get().handoffPage;
      if (handoff && (toggles.page || toggles.selection)) {
        page = slimPage(handoff);
      }
      const ctx = await gatherContext({
        activeTab: page ? null : activeTab,
        toggles,
        selectedTabIds: cfg.multiTab ? get().selectedTabIds : [],
        excludedSites: cfg.excludedSites,
        forceRead: get().forceRead,
        autoCapture: cfg.autoCapturePage,
      });
      page = page ?? ctx.page;
      notes = ctx.notes;
      let images: string[] = [];
      if (cfg.includeScreenshot && app.settings?.vision_model && activeTab) {
        const shot = await captureScreenshot(activeTab);
        if (shot) images = [shot];
        else notes.push('Screenshot unavailable (needs the toolbar icon / shortcut to grant temporary access).');
      }
      set({ notes });
      const body = {
        message: text,
        conversation_id: get().conversationId,
        model: get().modelOverride,
        context: toggles,
        page,
        tabs: ctx.tabs,
        instructions: cfg.instructions,
        document_ids: get().attachedDocs.map((d) => d.id),
        images,
        regenerate,
      };

      if (app.settings && !app.settings.streaming) {
        const res = await api.post<{ conversation_id: string; message_id: string; content: string; thinking: string; sources: Source[]; invalid_citations: string[]; stats: Record<string, unknown>; warnings: string[]; model: string }>(
          '/chat', body, { signal: abort.signal, timeoutMs: (app.settings.generation_timeout + 30) * 1000 });
        set({ conversationId: res.conversation_id, notes: [...notes, ...res.warnings] });
        patch((m) => ({ ...m, id: res.message_id, content: res.content, thinking: res.thinking, sources: res.sources, invalidCitations: res.invalid_citations, stats: res.stats, streaming: false, model: res.model }));
      } else {
        for await (const ev of stream('/chat/stream', body, abort.signal)) {
          if (ev.event === 'meta') {
            set({ conversationId: ev.data.conversation_id, notes: [...get().notes, ...(ev.data.warnings ?? [])] });
            patch((m) => ({ ...m, sources: ev.data.sources, model: ev.data.model }));
          } else if (ev.event === 'delta') {
            patch((m) => ({ ...m, content: m.content + ev.data.text }));
          } else if (ev.event === 'thinking') {
            patch((m) => ({ ...m, thinking: (m.thinking ?? '') + ev.data.text }));
          } else if (ev.event === 'done') {
            patch((m) => ({ ...m, id: ev.data.message_id, sources: ev.data.sources, invalidCitations: ev.data.invalid_citations, stats: ev.data.stats, streaming: false }));
            set({ streaming: false, abort: null });
          } else if (ev.event === 'memory_suggestions') {
            set({ memorySuggestions: ev.data.memories ?? [] });
          }
        }
      }
    } catch (e) {
      if (abort.signal.aborted) {
        patch((m) => ({ ...m, streaming: false, content: m.content ? `${m.content}\n\n*(stopped)*` : '*(stopped)*' }));
      } else {
        patch((m) => ({ ...m, streaming: false, error: describeError(e) }));
      }
    } finally {
      patch((m) => ({ ...m, streaming: false }));
      set({ streaming: false, abort: null, forceRead: false });
    }
  },

  stop: () => {
    get().abort?.abort();
  },

  regenerate: async () => {
    const msgs = get().messages;
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (!lastUser || !get().conversationId) return;
    const lastIdx = msgs.length - 1;
    if (msgs[lastIdx]?.role === 'assistant') set({ messages: msgs.slice(0, lastIdx) });
    await get().send(lastUser.content, { regenerate: true });
  },

  newConversation: () => {
    get().abort?.abort();
    set({ conversationId: null, title: 'New conversation', messages: [], notes: [], memorySuggestions: [], attachedDocs: [], handoffPage: null });
  },

  clearContext: () => set({ selectedTabIds: [], attachedDocs: [], handoffPage: null, forceRead: false, notes: [] }),

  loadConversation: async (id) => {
    get().abort?.abort();
    const conv = await api.get<Conversation>(`/conversations/${id}`);
    set({ conversationId: conv.id, title: conv.title, messages: (conv.messages ?? []).filter((m) => m.role !== 'system').map(fromServer), notes: [], memorySuggestions: [] });
  },

  dismissSuggestion: (id) => set({ memorySuggestions: get().memorySuggestions.filter((m) => m.id !== id) }),
}));
