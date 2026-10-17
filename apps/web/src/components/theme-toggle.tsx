'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

// Light and dark. Without a choice the site follows the system (a CSS media query); the toggle sets
// data-theme on <html> and remembers it. Before the first click nothing here runs on the server.
type Theme = 'light' | 'dark';

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('qsr-theme');
    } catch {
      /* storage can be blocked */
    }
    const initial = saved === 'light' || saved === 'dark' ? saved : systemTheme();
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset['theme'] = saved;
    setTheme(initial);
  }, []);

  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        document.documentElement.dataset['theme'] = next;
        try {
          localStorage.setItem('qsr-theme', next);
        } catch {
          /* ignore */
        }
        setTheme(next);
      }}
    >
      {theme === 'dark' ? (
        <Sun className="size-4" aria-hidden="true" />
      ) : (
        <Moon className="size-4" aria-hidden="true" />
      )}
    </Button>
  );
}
