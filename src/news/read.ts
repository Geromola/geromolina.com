/**
 * Which stories the reader has opened, shared by /news and the home page's story panel. Lives in
 * localStorage; every access is wrapped, so without storage everything simply counts as new.
 */
const KEY = 'news-read';
const MAX_READ = 600;

export function loadRead(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveRead(ids: readonly string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids.slice(-MAX_READ)));
  } catch {
    /* storage unavailable: read state lasts for this page */
  }
}

export function markRead(id: string) {
  const ids = loadRead();
  if (!ids.includes(id)) saveRead([...ids, id]);
}
