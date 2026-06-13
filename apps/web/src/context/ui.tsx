import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

interface UIValue {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

const UIContext = createContext<UIValue | null>(null);

const STORAGE_KEY = "varys.sidebarCollapsed";

export function UIProvider({ children }: { children: ReactNode }) {
  const [sidebarCollapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, sidebarCollapsed ? "1" : "0");
    } catch {
      /* ignore persistence failures (private mode, etc.) */
    }
  }, [sidebarCollapsed]);

  const toggleSidebar = useCallback(() => setCollapsed((c) => !c), []);

  const value = useMemo(() => ({ sidebarCollapsed, toggleSidebar }), [sidebarCollapsed, toggleSidebar]);
  return <UIContext.Provider value={value}>{children}</UIContext.Provider>;
}

export function useUI(): UIValue {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error("useUI must be used within <UIProvider>");
  return ctx;
}
