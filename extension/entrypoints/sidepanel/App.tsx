import { Activity, BookOpen, Brain, History, MessageSquare, Settings, SquareLibrary } from 'lucide-react';
import { useEffect } from 'react';
import { ChatPage } from '@/components/chat/ChatPage';
import { Toaster } from '@/components/common/toast';
import { Button, Spinner, cx } from '@/components/common/ui';
import { DiagnosticsPage } from '@/components/diagnostics/DiagnosticsPage';
import { HistoryPage } from '@/components/history/HistoryPage';
import { KnowledgePage } from '@/components/knowledge/KnowledgePage';
import { MemoryPage } from '@/components/memory/MemoryPage';
import { PromptsPage } from '@/components/prompts/PromptsPage';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { useAppearance } from '@/hooks/useAppearance';
import { usePendingHandoff } from '@/hooks/usePendingHandoff';
import { useApp, type Page } from '@/stores/app';

const NAV: { id: Page; label: string; Icon: typeof MessageSquare }[] = [
  { id: 'chat', label: 'Chat', Icon: MessageSquare },
  { id: 'knowledge', label: 'Knowledge', Icon: BookOpen },
  { id: 'memory', label: 'Memory', Icon: Brain },
  { id: 'history', label: 'History', Icon: History },
  { id: 'prompts', label: 'Prompts', Icon: SquareLibrary },
  { id: 'diagnostics', label: 'Diagnostics', Icon: Activity },
  { id: 'settings', label: 'Settings', Icon: Settings },
];

export function ConnectionBanner() {
  const connection = useApp((s) => s.connection);
  const error = useApp((s) => s.connectionError);
  const check = useApp((s) => s.checkConnection);
  const setPage = useApp((s) => s.setPage);
  if (connection === 'ok' || connection === 'checking') return null;
  const text =
    connection === 'backend-down'
      ? error?.message ?? 'The local backend is not reachable.'
      : connection === 'unpaired'
        ? 'The extension is not paired with the backend yet.'
        : 'The backend rejected the API token.';
  const hint =
    connection === 'backend-down'
      ? error?.hint ?? 'Start it with scripts\\start.ps1.'
      : 'Open Settings → Connection to pair automatically or paste the token.';
  return (
    <div role="alert" className="flex items-start gap-2 border-b border-bad/30 bg-bad/8 px-3 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-bad">{text}</p>
        <p className="text-fg/80">{hint}</p>
      </div>
      <Button size="sm" onClick={() => void check()}>Retry</Button>
      <Button size="sm" variant="ghost" onClick={() => setPage(connection === 'backend-down' ? 'diagnostics' : 'settings')}>
        {connection === 'backend-down' ? 'Diagnose' : 'Settings'}
      </Button>
    </div>
  );
}

function CurrentPage({ page }: { page: Page }) {
  switch (page) {
    case 'chat': return <ChatPage />;
    case 'knowledge': return <KnowledgePage />;
    case 'memory': return <MemoryPage />;
    case 'history': return <HistoryPage />;
    case 'prompts': return <PromptsPage />;
    case 'diagnostics': return <DiagnosticsPage />;
    case 'settings': return <SettingsPage />;
  }
}

export function App() {
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const init = useApp((s) => s.init);
  const configLoaded = useApp((s) => s.configLoaded);
  const connection = useApp((s) => s.connection);
  const periodic = useApp((s) => s.config.periodicHealthMinutes);
  const check = useApp((s) => s.checkConnection);

  useAppearance();
  usePendingHandoff();
  useEffect(() => { void init(); }, [init]);

  // Optional lightweight periodic connectivity check (never runs model inference).
  useEffect(() => {
    if (!periodic) return;
    const t = setInterval(() => void check(), periodic * 60_000);
    return () => clearInterval(t);
  }, [periodic, check]);

  // Alt+1..7 switches pages.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= NAV.length) {
        e.preventDefault();
        setPage(NAV[n - 1].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPage]);

  if (!configLoaded) {
    return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav aria-label="Main" className="flex items-center gap-0.5 overflow-x-auto border-b border-border px-1.5 py-1">
        {NAV.map(({ id, label, Icon }, i) => (
          <button
            key={id}
            onClick={() => setPage(id)}
            aria-current={page === id ? 'page' : undefined}
            title={`${label} (Alt+${i + 1})`}
            className={cx(
              'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs',
              page === id ? 'bg-subtle font-medium text-fg' : 'text-muted hover:bg-subtle hover:text-fg',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            <span className={cx(page !== id && 'sr-only min-[420px]:not-sr-only')}>{label}</span>
          </button>
        ))}
        <span className="ml-auto pl-1" title={`Backend: ${connection}`}>
          <span className={cx('block size-2 rounded-full', connection === 'ok' ? 'bg-ok' : connection === 'checking' ? 'bg-muted animate-pulse' : 'bg-bad')} />
          <span className="sr-only">Backend connection: {connection}</span>
        </span>
      </nav>
      <ConnectionBanner />
      <main className={cx('min-h-0 flex-1', page === 'chat' ? 'overflow-hidden' : 'overflow-y-auto')}>
        <CurrentPage page={page} />
      </main>
      <Toaster />
    </div>
  );
}
