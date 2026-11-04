import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import '@/assets/main.css';
import { Toaster } from '@/components/common/toast';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { useAppearance } from '@/hooks/useAppearance';
import { useApp } from '@/stores/app';
import { ConnectionBanner } from '../sidepanel/App';

function Options() {
  const init = useApp((s) => s.init);
  useAppearance();
  useEffect(() => { void init(); }, [init]);
  return (
    <div className="mx-auto max-w-2xl">
      <header className="flex items-center gap-2 px-3 pt-4">
        <h1 className="flex-1 text-lg font-semibold">Local Browser AI – Settings</h1>
        <button className="text-xs text-accent underline" onClick={() => void chrome.sidePanel?.open?.({ windowId: chrome.windows?.WINDOW_ID_CURRENT ?? -2 })}>Open side panel</button>
      </header>
      <ConnectionBanner />
      <SettingsPage />
      <Toaster />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Options /></StrictMode>);
