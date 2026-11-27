import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";

type PageActionsContextValue = {
  host: HTMLElement | null;
  setHost: (host: HTMLElement | null) => void;
};

const PageActionsContext = createContext<PageActionsContextValue | null>(null);

export function PageActionsProvider({ children }: { children: React.ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ host, setHost }), [host]);
  return <PageActionsContext.Provider value={value}>{children}</PageActionsContext.Provider>;
}

export function PageActionsHost({ className }: { className?: string }) {
  const setHost = useContext(PageActionsContext)?.setHost;
  const ref = useCallback((node: HTMLDivElement | null) => {
    setHost?.(node);
  }, [setHost]);
  return <div ref={ref} className={className} />;
}

export function PageActions({ children }: { children: React.ReactNode }) {
  const host = useContext(PageActionsContext)?.host;
  if (!host) return null;
  return createPortal(children, host);
}
