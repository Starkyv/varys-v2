import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { RunDialog } from "../dialogs/RunDialog";

interface RunDialogValue {
  /** Open the run dialog, optionally pre-selecting a test. */
  openRunDialog: (testId?: string) => void;
}

const RunDialogContext = createContext<RunDialogValue | null>(null);

export function RunDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [testId, setTestId] = useState<string | undefined>(undefined);

  const openRunDialog = useCallback((id?: string) => {
    setTestId(id);
    setOpen(true);
  }, []);

  const value = useMemo(() => ({ openRunDialog }), [openRunDialog]);

  return (
    <RunDialogContext.Provider value={value}>
      {children}
      <RunDialog open={open} initialTestId={testId} onClose={() => setOpen(false)} />
    </RunDialogContext.Provider>
  );
}

export function useRunDialog(): RunDialogValue {
  const ctx = useContext(RunDialogContext);
  if (!ctx) throw new Error("useRunDialog must be used within <RunDialogProvider>");
  return ctx;
}
