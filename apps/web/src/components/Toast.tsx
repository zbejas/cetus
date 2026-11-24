import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

type ToastTone = "info" | "success" | "danger";

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
}

interface ToastApi {
  push: (toast: Omit<ToastItem, "id">) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = useCallback((toast: Omit<ToastItem, "id">) => {
    const id = nextId++;
    setItems((current) => [...current, { ...toast, id }]);
    window.setTimeout(() => remove(id), 5_000);
  }, [remove]);

  const api = useMemo<ToastApi>(() => ({
    push,
    success: (title, description) => push({ title, description, tone: "success" }),
    error: (title, description) => push({ title, description, tone: "danger" }),
  }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {items.map((item) => (
          <div className="toast" key={item.id} data-tone={item.tone}>
            {item.tone === "success" ? <CheckCircle2 size={17} color="var(--success)" /> : null}
            {item.tone === "danger" ? <AlertTriangle size={17} color="var(--danger)" /> : null}
            {item.tone === "info" ? <Info size={17} color="var(--info)" /> : null}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{item.title}</div>
              {item.description ? <div style={{ marginTop: 2, color: "var(--muted)", fontSize: 12 }}>{item.description}</div> : null}
            </div>
            <button className="btn btn-ghost btn-sm" style={{ width: 24, height: 24, padding: 0 }} onClick={() => remove(item.id)} aria-label="Dismiss notification">
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}
