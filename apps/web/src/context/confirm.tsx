import { AlertTriangle, Button, Modal, ModalBody, ModalFooter, ModalHeader } from "@varys/ui";
import { createContext, type ReactNode, useCallback, useContext, useId, useMemo, useRef, useState } from "react";

export interface ConfirmOptions {
  title: string;
  /** Body copy explaining the consequence (plain text or nodes). */
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive actions get a red confirm button + a warning icon. */
  tone?: "danger" | "primary";
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * App-wide confirmation dialog — the design-system `Modal`, surfaced imperatively so it
 * replaces the browser's native `window.confirm`. `const confirm = useConfirm()` then
 * `if (await confirm({ title, message, tone: "danger" })) { … }`. The last options linger
 * after close so the panel doesn't blank mid out-animation.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);
  const titleId = useId();

  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        resolveRef.current = resolve;
        setOptions(opts);
        setOpen(true);
      }),
    [],
  );

  const settle = useCallback((ok: boolean) => {
    resolveRef.current?.(ok);
    resolveRef.current = null;
    setOpen(false); // keep `options` rendered through the close animation
  }, []);

  const value = useMemo(() => confirm, [confirm]);
  const tone = options?.tone ?? "primary";

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Modal open={open} onClose={() => settle(false)} width={440} labelledBy={titleId}>
        <ModalHeader
          icon={tone === "danger" ? <AlertTriangle /> : undefined}
          title={options?.title ?? ""}
          titleId={titleId}
          onClose={() => settle(false)}
        />
        {options?.message != null && <ModalBody>{options.message}</ModalBody>}
        <ModalFooter>
          <Button variant="ghost" onClick={() => settle(false)}>
            {options?.cancelLabel ?? "Cancel"}
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} onClick={() => settle(true)}>
            {options?.confirmLabel ?? "Confirm"}
          </Button>
        </ModalFooter>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
}
