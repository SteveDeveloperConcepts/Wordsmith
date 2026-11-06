import { useEffect } from 'react';
import { desktop } from '../platform';
import { resolveTheme, useSettings } from '../state/settings';

/** Applies the chosen theme to the document, following the system setting when asked to. */
export function useTheme(): void {
  const theme = useSettings((s) => s.theme);
  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(theme);
    };
    apply();
    void desktop?.setTheme(theme);
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}
