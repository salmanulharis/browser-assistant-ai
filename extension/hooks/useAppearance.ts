import { useEffect } from 'react';
import { useApp } from '@/stores/app';

/** Applies theme (system/light/dark) and font size from the extension config to <html>. */
export function useAppearance(): void {
  const theme = useApp((s) => s.config.theme);
  const fontSize = useApp((s) => s.config.fontSize);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.font = fontSize;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => root.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches));
    apply();
    if (theme !== 'system') return;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme, fontSize]);
}
