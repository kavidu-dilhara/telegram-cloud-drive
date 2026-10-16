import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { haptic } from "../telegram";

type Kind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: Kind;
  message: string;
  action?: { label: string; run: () => void };
}
interface ToastOptions {
  kind?: Kind;
  action?: Toast["action"];
}

const ToastContext = createContext<(message: string, options?: ToastOptions) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((old) => old.filter((toast) => toast.id !== id)), []);
  const push = useCallback((message: string, options: ToastOptions = {}) => {
    const id = nextId.current++;
    const kind = options.kind ?? "info";
    if (kind === "error") haptic.error();
    else if (kind === "success") haptic.success();
    setToasts((old) => [...old.slice(-3), { id, kind, message, action: options.action }]);
    window.setTimeout(() => dismiss(id), options.action ? 8000 : kind === "error" ? 7000 : 4500);
  }, [dismiss]);

  const value = useMemo(() => push, [push]);
  const Icon = { success: CheckCircle2, error: CircleAlert, info: Info };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" aria-live="polite">
        {toasts.map((toast) => {
          const KindIcon = Icon[toast.kind];
          return (
            <div
              key={toast.id}
              className={`toast toast-${toast.kind}`}
              role={toast.kind === "error" ? "alert" : "status"}
            >
              <KindIcon size={18} aria-hidden="true" />
              <span>{toast.message}</span>
              {toast.action && (
                <button
                  type="button"
                  className="toast-action"
                  onClick={() => {
                    toast.action?.run();
                    dismiss(toast.id);
                  }}
                >
                  {toast.action.label}
                </button>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label="Dismiss message"
                onClick={() => dismiss(toast.id)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
