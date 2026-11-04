import { act, render, screen, waitFor, within } from '@testing-library/react';
import { TabIndicator } from '@/components/chat/TabIndicator';
import { useActiveTab } from '@/hooks/useActiveTab';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionsSection } from '@/components/diagnostics/PermissionsSection';
import { DiagnosticsPage } from '@/components/diagnostics/DiagnosticsPage';
import { App } from '@/entrypoints/sidepanel/App';
import { useApp } from '@/stores/app';
import { stream } from '@/services/api';
import { fakeChrome } from '../setup';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function mockFetch(h: Handler) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(h(String(input), init ?? {})));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const SETTINGS = {
  ollama_url: 'http://127.0.0.1:11434', chat_model: 'qwen3:4b', embedding_model: 'nomic-embed-text', vision_model: '', temperature: 0.4, context_length: 8192,
  request_timeout: 10, generation_timeout: 300, streaming: true, think: false, local_only: true, rag_top_k: 5, chunk_size_tokens: 700, chunk_overlap_tokens: 100,
  min_relevance: 0.35, max_page_context_chars: 12000, auto_memory_mode: 'ask', auto_memory_categories: ['profile'], memory_retrieval: true, memory_top_k: 5,
  cross_conversation_retrieval: true, conversation_retention_days: 0, recent_messages: 8, summarize_after_messages: 16,
};

function healthyBackend(): Handler {
  return (url) => {
    if (url.endsWith('/health')) return json({ status: 'ok', version: '1.0.0', api_version: 'v1' });
    if (url.endsWith('/auth/pair')) return json({ token: 't'.repeat(43) });
    if (url.endsWith('/auth/check')) return json({ ok: true });
    if (url.endsWith('/settings')) return json(SETTINGS);
    if (url.endsWith('/models')) return json({ reachable: true, ollama_url: SETTINGS.ollama_url, version: '0.40', models: [], selected: {}, missing: [], suggestions: [], error: null });
    if (url.includes('/conversations')) return json([]);
    if (url.includes('/diagnostics?')) return json({ latest: null, history: [] });
    if (url.endsWith('/diagnostics/run')) {
      return json({ id: 'r1', level: 'basic', started_at: new Date().toISOString(), finished_at: null, summary: { overall: 'failed', healthy: 1, warnings: 0, failed: 1, counts: {} }, results: [
        { id: 'backend.api', group: 'backend', name: 'FastAPI', status: 'healthy', message: 'Backend 1.0.0 running.' },
        { id: 'ollama.reachable', group: 'ollama', name: 'Ollama server reachable', status: 'failed', message: 'Ollama server is not responding at 127.0.0.1:11434.', hint: 'Start Ollama.' },
      ] });
    }
    if (url.includes('/diagnostics/stream-test')) return new Response('event: tick\ndata: {}\n\nevent: done\ndata: {}\n\n', { headers: { 'access-control-allow-origin': location.origin } });
    return json({}, 404);
  };
}

beforeEach(() => {
  useApp.setState(useApp.getInitialState(), true);
});
afterEach(() => vi.unstubAllGlobals());

describe('side panel', () => {
  it('renders all seven pages in the navigation and connects to the backend', async () => {
    mockFetch(healthyBackend());
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    for (const label of ['Chat', 'Knowledge', 'Memory', 'History', 'Prompts', 'Diagnostics', 'Settings']) {
      expect(within(nav).getByTitle(new RegExp(`^${label}`))).toBeInTheDocument();
    }
    await waitFor(() => expect(useApp.getState().connection).toBe('ok'));
    expect(useApp.getState().config.token).toHaveLength(43); // paired automatically
  });

  it('shows an actionable banner when the backend is down', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    render(<App />);
    expect(await screen.findByText(/Cannot reach the local backend/)).toBeInTheDocument();
    expect(screen.getByText(/start\.ps1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Diagnose' })).toBeInTheDocument();
  });
});

describe('diagnostics page', () => {
  it('runs a basic check on open and never shows success for failed checks', async () => {
    const f = mockFetch(healthyBackend());
    await useApp.getState().updateConfig({ token: 'x'.repeat(43) });
    render(<DiagnosticsPage />);
    // shown both as the failed check and in the Ollama guidance box
    expect((await screen.findAllByText(/not responding at 127\.0\.0\.1:11434/, {}, { timeout: 4000 })).length).toBe(2);
    expect(screen.getByText(/Check whether Ollama is running/)).toBeInTheDocument();
    const runCall = f.mock.calls.find(([u]) => String(u).endsWith('/diagnostics/run'));
    expect(JSON.parse(String(runCall![1]!.body)).level).toBe('basic'); // no inference on open
    const ollamaSection = screen.getByText('Ollama server').closest('section')!;
    expect(within(ollamaSection).getByText('Failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-run failed/ })).toBeEnabled();
    expect(screen.getByText('Chrome extension')).toBeInTheDocument();
  });
});

describe('permissions', () => {
  it('shows status and requests website access on click', async () => {
    fakeChrome.activeTab = { id: 1, url: 'https://news.example.org/a', title: 'A', windowId: 1, active: true } as chrome.tabs.Tab;
    render(<PermissionsSection />);
    const grant = await screen.findByRole('button', { name: 'Allow news.example.org' });
    expect(screen.getByText('Website access permission is required to read this page.')).toBeInTheDocument();
    await userEvent.click(grant);
    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://news.example.org/*'] });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Allow news.example.org' })).not.toBeInTheDocument());
    expect(screen.getByText('https://news.example.org')).toBeInTheDocument();
  });

  it('when Chrome hides the tab URL, first reveals the site (tabs), then requests that site', async () => {
    // Chrome without "tabs"/host access: URL hidden, and injecting a script fails.
    fakeChrome.granted.delete('tabs');
    fakeChrome.origins.delete('http://localhost/*');
    const real = { id: 1, url: 'http://localhost/wp-admin/users.php', title: 'Users', windowId: 1, active: true } as chrome.tabs.Tab;
    vi.mocked(chrome.tabs.query).mockImplementation(async () => [fakeChrome.granted.has('tabs') ? real : { ...real, url: undefined, title: undefined }]);
    vi.mocked(chrome.scripting.executeScript).mockImplementation(async () => {
      if (fakeChrome.origins.has('http://localhost/*')) return [{ result: true }] as never;
      throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
    });
    const Harness = () => <TabIndicator state={useActiveTab()} />;
    try {
      render(<Harness />);
      expect(await screen.findByText('URL hidden until access is granted')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Grant website access' }));
      expect(chrome.permissions.request).toHaveBeenLastCalledWith({ permissions: ['tabs'] });
      // second click asks for exactly the revealed site
      await userEvent.click(await screen.findByRole('button', { name: 'Allow localhost' }));
      expect(chrome.permissions.request).toHaveBeenLastCalledWith({ origins: ['http://localhost/*'] });
      expect(await screen.findByText('Can read')).toBeInTheDocument();
    } finally {
      fakeChrome.origins.add('http://localhost/*');
      fakeChrome.granted.delete('tabs');
      vi.mocked(chrome.tabs.query).mockImplementation(async () => (fakeChrome.activeTab ? [fakeChrome.activeTab] : []));
      vi.mocked(chrome.scripting.executeScript).mockImplementation(async () => [{ result: true }] as never);
    }
  });

  it('handles a denied optional permission gracefully', async () => {
    fakeChrome.grantNext = false;
    render(<PermissionsSection />);
    const btn = await screen.findByRole('button', { name: /Grant Tabs/ });
    await userEvent.click(btn);
    expect(chrome.permissions.request).toHaveBeenCalledWith({ permissions: ['tabs'] });
    expect(await screen.findByRole('button', { name: /Grant Tabs/ })).toBeInTheDocument();
  });
});

describe('streaming client', () => {
  it('yields deltas and can be cancelled', async () => {
    const enc = new TextEncoder();
    let cancelled = false;
    mockFetch(() => new Response(new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('event: meta\ndata: {"conversation_id":"c1"}\n\n'));
        c.enqueue(enc.encode('event: delta\ndata: {"text":"Hel"}\n\n'));
      },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const ctrl = new AbortController();
    const seen: string[] = [];
    await act(async () => {
      try {
        for await (const ev of stream('/chat/stream', { message: 'hi' }, ctrl.signal)) {
          seen.push(ev.event);
          if (ev.event === 'delta') ctrl.abort();
        }
      } catch (e) {
        expect((e as Error).name).toBe('AbortError');
      }
    });
    expect(seen).toEqual(['meta', 'delta']);
    expect(cancelled || ctrl.signal.aborted).toBe(true);
  });
});

describe('page edit planning', () => {
  it('shows elapsed time while planning and Cancel aborts the request', async () => {
    let aborted = false;
    vi.stubGlobal('fetch', vi.fn((_u: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); });
    })));
    vi.mocked(chrome.scripting.executeScript).mockImplementation(async () => [{ result: [] }] as never);
    const { AgentPanel } = await import('@/components/browser-actions/AgentPanel');
    const tab = { id: 1, windowId: 1, title: 'Edit User', url: 'https://wp.example/wp-admin/user-edit.php', active: true };
    render(<AgentPanel tab={tab} initialTask="Fill the first name with Meera" autoStart embedded onClose={() => {}} />);
    expect(await screen.findByRole('status')).toHaveTextContent(/Planning with the local model… \ds/);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(aborted).toBe(true));
    expect(await screen.findByText(/Cancelled – nothing was changed/)).toBeInTheDocument();
    vi.mocked(chrome.scripting.executeScript).mockImplementation(async () => [{ result: true }] as never);
  });
});
