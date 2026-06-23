import type { EnvironmentView, TestVariable } from "@varys/review-contract";
import {
  AlertTriangle,
  Button,
  Check,
  cx,
  Info,
  Lock,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Play,
  Select,
  Switch,
} from "@varys/ui";
import { useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "../../context/router";
import { useToast } from "../../context/toast";
import { useDrafts, useEnvironments, useRunTest, useTests } from "../../queries";
import styles from "./styles.module.scss";

const NO_ENV = "__none__";

/** Does the environment supply this variable? Secrets are matched by name (their values
 *  are write-only and never returned); plain values must be a present key. This mirrors
 *  exactly what the worker's resolver reads, so a "satisfied" check here means the run
 *  won't fail with an "unresolved variable" for that token. */
function isSatisfied(v: TestVariable, env: EnvironmentView): boolean {
  return v.kind === "secret" ? env.secretNames.includes(v.name) : v.name in env.values;
}

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
  // Only fetch while the dialog is open. RunDialog is mounted app-wide (above the auth
  // gate, in RunDialogProvider), so fetching unconditionally would hammer these guarded
  // routes with 401s on the login screen. It's only ever opened from inside the authed app.
  const tests = useTests({ enabled: open });
  const drafts = useDrafts({ enabled: open });
  const environments = useEnvironments({ enabled: open });
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
      variables: t.variables,
    }));
    const draft = (drafts.data ?? []).find((d) => d.id === initialTestId);
    // Drafts aren't listed with their variables; they still need an environment
    // (AI drafts carry {{baseUrl}}), so the env picker shows without the per-variable check.
    return draft
      ? [
          { id: draft.id, name: `${draft.name} (draft preview)`, needsEnvironment: true, variables: [] as TestVariable[] },
          ...active,
        ]
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

  // The chosen environment (a real one, not the "no environment" sentinel) and how it
  // measures up against the test's declared variables — the pre-flight check that turns a
  // mid-run "unresolved variable" failure into something visible before the run starts.
  const selectedEnv = useMemo(
    () => (envId && envId !== NO_ENV ? environments.data?.find((e) => e.id === envId) : undefined),
    [environments.data, envId],
  );
  const requiredVars = selected?.variables ?? [];
  const missingVars = selectedEnv ? requiredVars.filter((v) => !isSatisfied(v, selectedEnv)) : [];
  const blockedByVars = !!selectedEnv && missingVars.length > 0;

  const disabled = !selected || (needsEnv && !envId) || blockedByVars || runMutation.isPending;

  function selectTest(id: string) {
    setTestId(id);
    const t = candidates.find((x) => x.id === id);
    setEnvId(t && t.needsEnvironment ? null : NO_ENV);
  }

  function submit() {
    if (!selected) return;
    if (needsEnv && (!envId || envId === NO_ENV)) return;
    if (blockedByVars) return; // the chosen environment is missing a value this test needs
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

            {requiredVars.length > 0 && (
              <div className={styles.varSection}>
                <div className={styles.varHeading}>Variables this test needs</div>
                <ul className={styles.varList}>
                  {requiredVars.map((v) => {
                    // null until an environment is picked (neutral); then satisfied / missing.
                    const ok = selectedEnv ? isSatisfied(v, selectedEnv) : null;
                    return (
                      <li
                        key={`${v.kind}:${v.name}`}
                        className={cx(
                          styles.varRow,
                          ok === true && styles.varOk,
                          ok === false && styles.varMissing,
                        )}
                      >
                        <span className={styles.varIcon}>
                          {ok === true ? (
                            <Check size={14} />
                          ) : ok === false ? (
                            <AlertTriangle size={14} />
                          ) : (
                            <span className={styles.varDot} />
                          )}
                        </span>
                        <span className={styles.varName}>{v.name}</span>
                        {v.kind === "secret" && (
                          <span className={styles.varBadge}>
                            <Lock size={11} /> secret
                          </span>
                        )}
                        {ok === false && <span className={styles.varState}>not set</span>}
                      </li>
                    );
                  })}
                </ul>
                {blockedByVars && (
                  <div className={styles.varWarn}>
                    <span className={styles.varWarnIcon}>
                      <AlertTriangle size={16} />
                    </span>
                    <span>
                      “{selectedEnv?.name}” is missing {missingVars.length === 1 ? "a value" : "values"} this
                      test needs — add {missingVars.map((v) => v.name).join(", ")} under Environments, then run.
                    </span>
                  </div>
                )}
              </div>
            )}
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
