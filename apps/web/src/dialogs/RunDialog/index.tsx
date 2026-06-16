import { Button, cx, Info, Modal, ModalBody, ModalFooter, ModalHeader, Play, Select, Switch } from "@varys/ui";
import { useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "../../context/router";
import { useToast } from "../../context/toast";
import { useDrafts, useEnvironments, useRunTest, useTests } from "../../queries";
import styles from "./styles.module.scss";

const NO_ENV = "__none__";

export interface RunDialogProps {
  open: boolean;
  initialTestId?: string;
  onClose: () => void;
}

/**
 * The global "Run test" dialog: pick a test, pick an environment when the
 * recording needs one (a no-variable test runs without one), optionally keep a
 * Playwright trace, then trigger a replay. Opened from the top bar, a test row, or
 * a dashboard matrix cell.
 */
export function RunDialog({ open, initialTestId, onClose }: RunDialogProps) {
  const titleId = useId();
  const { navigate } = useRouter();
  const { toast } = useToast();
  const tests = useTests();
  const drafts = useDrafts();
  const environments = useEnvironments();
  const runMutation = useRunTest();

  const [testId, setTestId] = useState<string>("");
  const [envId, setEnvId] = useState<string | null>(null);
  const [trace, setTrace] = useState(false);

  // Runnable candidates: the active tests, plus — when the dialog was opened for a
  // specific draft (a baseline-preview run before promotion) — that draft, which is
  // otherwise held out of the active list. AI drafts carry {{baseUrl}}, so they need an
  // environment.
  const candidates = useMemo(() => {
    const active = (tests.data ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      needsEnvironment: t.needsEnvironment,
    }));
    const draft = (drafts.data ?? []).find((d) => d.id === initialTestId);
    return draft
      ? [{ id: draft.id, name: `${draft.name} (draft preview)`, needsEnvironment: true }, ...active]
      : active;
  }, [tests.data, drafts.data, initialTestId]);

  // Seed selection when the dialog opens.
  useEffect(() => {
    if (!open) return;
    const seed = initialTestId ?? candidates[0]?.id ?? "";
    setTestId(seed);
    const t = candidates.find((x) => x.id === seed);
    setEnvId(t && t.needsEnvironment ? null : NO_ENV);
    setTrace(false);
  }, [open, initialTestId, candidates]);

  const selected = useMemo(() => candidates.find((t) => t.id === testId), [candidates, testId]);
  const needsEnv = !!selected?.needsEnvironment;
  const disabled = !selected || (needsEnv && !envId) || runMutation.isPending;

  function selectTest(id: string) {
    setTestId(id);
    const t = candidates.find((x) => x.id === id);
    setEnvId(t && t.needsEnvironment ? null : NO_ENV);
  }

  function submit() {
    if (!selected) return;
    if (needsEnv && (!envId || envId === NO_ENV)) return;
    const environmentId = envId && envId !== NO_ENV ? envId : undefined;
    const envName = environmentId ? environments.data?.find((e) => e.id === environmentId)?.name : null;
    runMutation.mutate(
      { testId: selected.id, environmentId, trace },
      {
        onSuccess: () => {
          toast(`Queued “${selected.name}”${envName ? ` · ${envName}` : ""}`);
          onClose();
          navigate({ name: "runs" });
        },
        onError: (e) => toast(e instanceof Error ? e.message : "Failed to start run"),
      },
    );
  }

  return (
    <Modal open={open} onClose={onClose} width={440} labelledBy={titleId}>
      <ModalHeader
        icon={<Play />}
        title="Run test"
        titleId={titleId}
        subtitle="Configure and launch a replay"
        onClose={onClose}
      />
      <ModalBody>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${titleId}-test`}>
            Test
          </label>
          <Select
            id={`${titleId}-test`}
            ariaLabel="Test"
            value={testId}
            onValueChange={selectTest}
            disabled={candidates.length === 0}
            placeholder="Select a test"
            options={candidates.map((t) => ({ value: t.id, label: t.name }))}
          />
        </div>

        {needsEnv ? (
          <div className={styles.field}>
            <div className={styles.label}>
              Environment <span className={styles.req}>*</span>
            </div>
            <div className={styles.envList}>
              {(environments.data ?? []).map((env) => {
                const sel = envId === env.id;
                return (
                  <button
                    key={env.id}
                    type="button"
                    className={cx(styles.envRow, sel && styles.envRowSel)}
                    onClick={() => setEnvId(env.id)}
                  >
                    <span className={cx(styles.radio, sel && styles.radioSel)}>
                      <span className={styles.radioDot} />
                    </span>
                    <span className={styles.envName}>{env.name}</span>
                    <span className={styles.envUrl}>{env.values.baseUrl ?? ""}</span>
                  </button>
                );
              })}
              {(environments.data ?? []).length === 0 && (
                <div className={styles.envEmpty}>No environments yet — add one under Environments.</div>
              )}
            </div>
          </div>
        ) : (
          <div className={styles.infoBox}>
            <span className={styles.infoIcon}>
              <Info size={16} />
            </span>
            <span>No variables in this recording — it runs without an environment.</span>
          </div>
        )}

        <label className={styles.traceRow}>
          <Switch checked={trace} onCheckedChange={setTrace} />
          <span>
            <span className={styles.traceTitle}>Keep Playwright trace</span>
            <span className={styles.traceSub}>Records a trace you can open in the timeline viewer</span>
          </span>
        </label>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" iconLeft={<Play />} disabled={disabled} loading={runMutation.isPending} onClick={submit}>
          Run now
        </Button>
      </ModalFooter>
    </Modal>
  );
}
