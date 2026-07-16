/**
 * Storage that can't crash the app: with cookies/site-data blocked (Chrome's "Block all cookies",
 * some webviews), merely touching `window.localStorage` throws SecurityError — and two of our
 * call sites run during render/mount, where an uncaught throw unmounts the whole React tree
 * (there is no error boundary; the blank-page failure is total). Persistence is a nicety; these
 * wrappers make its absence mean "preferences don't stick", never "no app".
 */

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage denied — the preference simply won't persist past this session.
  }
}
