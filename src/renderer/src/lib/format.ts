const numberFormat = new Intl.NumberFormat('en-US');

export const formatNumber = (n: number): string => numberFormat.format(n);

/** "45 sec", "3 min 20 sec", "1 hr 5 min" */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} min ${rest} sec` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours} hr ${mins} min` : `${hours} hr`;
}

export const plural = (n: number, singular: string, pluralForm = `${singular}s`): string =>
  `${formatNumber(n)} ${n === 1 ? singular : pluralForm}`;

/** "just now", "5 min ago", "Yesterday", "Mar 3" */
export function formatRelative(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const date = new Date(timestamp);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (timestamp >= startOfToday) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (timestamp >= startOfToday - 86_400_000) return 'Yesterday';
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
}

/** A file-system-friendly name for a document. */
export function fileNameFor(title: string, extension: string): string {
  const base = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled';
  return `${base}.${extension}`;
}
