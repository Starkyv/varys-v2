import { Check } from "@varys/ui";
import { AnimatePresence, motion } from "framer-motion";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import styles from "./toast.module.scss";

interface ToastValue {
  /** Show a transient confirmation toast (auto-dismisses). */
  toast: (message: string) => void;
}

const ToastContext = createContext<ToastValue | null>(null);

interface ToastState {
  id: number;
  message: string;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const seq = useRef(0);

  const toast = useCallback((message: string) => {
    const id = ++seq.current;
    setCurrent({ id, message });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCurrent((c) => (c?.id === id ? null : c));
    }, 2800);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.region} aria-live="polite" aria-atomic="true">
        <AnimatePresence>
          {current && (
            <motion.div
              key={current.id}
              className={styles.toast}
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 460, damping: 32 }}
            >
              <span className={styles.icon}>
                <Check size={18} />
              </span>
              {current.message}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}
