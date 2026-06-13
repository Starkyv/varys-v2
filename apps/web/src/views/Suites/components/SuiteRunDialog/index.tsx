import { Button, Check, cx, Modal, ModalBody, ModalFooter, ModalHeader, Play, Squares, Switch } from "@varys/ui";
import { useEffect, useId, useState } from "react";
import { useRouter } from "../../../../context/router";
import { useToast } from "../../../../context/toast";
import { useEnvironments, useTriggerSuiteRun } from "../../../../queries";
import styles from "./styles.module.scss";

export interface SuiteRunTarget {
  id: string;
  name: string;
  testCount: number;
}

export function SuiteRunDialog({ suite, onClose }: { suite: SuiteRunTarget | null; onClose: () => void }) {
  const titleId = useId();
  const { navigate } = useRouter();
  const { toast } = useToast();
  const environments = useEnvironments();
  const trigger = useTriggerSuiteRun();

  const [envIds, setEnvIds] = useState<string[]>([]);
  const [trace, setTrace] = useState(false);

  useEffect(() => {
    if (suite) {
      setEnvIds([]);
      setTrace(false);
    }
  }, [suite]);

  const open = suite !== null;
  const envCount = envIds.length;
  const total = (suite?.testCount ?? 0) * envCount;
  const disabled = envCount === 0 || trigger.isPending;

  function toggleEnv(id: string) {
    setEnvIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  function submit() {
    if (!suite || envCount === 0) return;
    trigger.mutate(
      { suiteId: suite.id, environmentIds: envIds, trace },
      {
        onSuccess: () => {
          toast(`Queued “${suite.name}” · ${suite.testCount}×${envCount} = ${total} runs`);
          onClose();
          navigate({ name: "suiteRuns" });
        },
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t start suite run"),
      },
    );
  }

  return (
    <Modal open={open} onClose={onClose} width={460} labelledBy={titleId}>
      <ModalHeader
        icon={<Squares />}
        title="Run suite"
        titleId={titleId}
        subtitle={suite ? `${suite.name} · ${suite.testCount} tests` : ""}
        onClose={onClose}
      />
      <ModalBody>
        <div className={styles.label}>
          Environments <span className={styles.req}>*</span>{" "}
          <span className={styles.hint}>— fan out across each</span>
        </div>
        <div className={styles.envGrid}>
          {(environments.data ?? []).map((env) => {
            const sel = envIds.includes(env.id);
            return (
              <button key={env.id} type="button" className={cx(styles.env, sel && styles.envSel)} onClick={() => toggleEnv(env.id)}>
                <span className={cx(styles.check, sel && styles.checkOn)}>{sel && <Check size={11} />}</span>
                <span className={styles.envName}>{env.name}</span>
              </button>
            );
          })}
          {(environments.data ?? []).length === 0 && (
            <div className={styles.envEmpty}>No environments yet — add one under Environments.</div>
          )}
        </div>
        <label className={styles.traceRow}>
          <Switch checked={trace} onCheckedChange={setTrace} />
          <span className={styles.traceTitle}>Keep Playwright trace</span>
        </label>
      </ModalBody>
      <ModalFooter
        leading={
          <span>
            <strong className={styles.total}>{total}</strong> child run{total === 1 ? "" : "s"}
          </span>
        }
      >
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" iconLeft={<Play size={15} />} disabled={disabled} loading={trigger.isPending} onClick={submit}>
          Run suite
        </Button>
      </ModalFooter>
    </Modal>
  );
}
