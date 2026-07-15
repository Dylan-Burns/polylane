/**
 * Inline toast notifications — how 409/429 chaos responses (and other transient failures) surface
 * to the user, per the task brief ("surfaced as inline toasts, not alerts"). A plain context +
 * fixed-position stack; no portal library needed for one small overlay.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastTone = "info" | "warning" | "error";

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastContextValue {
  push: (tone: ToastTone, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

const TOAST_LIFETIME_MS = 5000;

const TONE_CLASSES: Record<ToastTone, string> = {
  info: "border-signal/40 bg-panel-raised text-ink",
  warning: "border-status-amber/50 bg-panel-raised text-status-amber",
  error: "border-status-red/50 bg-panel-raised text-status-red",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const push = useCallback((tone: ToastTone, message: string) => {
    const id = nextId.current;
    nextId.current += 1;
    setToasts((prev) => [...prev, { id, tone, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_LIFETIME_MS);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4 sm:items-end">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`animate-step-in pointer-events-auto w-full max-w-sm rounded-lg border px-4 py-3 font-sans text-sm shadow-lg shadow-black/40 ${TONE_CLASSES[t.tone]}`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
