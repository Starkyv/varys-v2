import type { TestConfigView } from "@varys/review-contract";
import {
  Button,
  Card,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Play,
  Sparkles,
} from "@varys/ui";
import { useId, useState } from "react";
import { EnvironmentPicker } from "../../../../components/EnvironmentPicker";
import { useRouter } from "../../../../context/router";
import { useToast } from "../../../../context/toast";
import { useBridgeHelper, useEnvironments, useRequestAgentRun } from "../../../../queries";
import styles from "./styles.module.scss";

/**
 * The Run control for an **Agent-Driven Test** — the one kind Varys cannot run itself.
 *
 * Pressing it sends a command down the channel the **Bridge Helper** is already holding open, and
 * the user's own Claude starts an **Agent Run Session** under their own subscription. Varys still
 * supplies no browser, holds no credential that can summon a model, and observes no driving; what
 * changes is only which finger starts it.
 *
 * It creates NOTHING. The Run comes into existence when Claude calls `start_agent_run`, which is
 * where the `missing` rows are seeded and the Wall-Clock Lease is stamped — so the copy promises a
 * request was sent, never that a run has started. A Run created at the press would be a Run with
 * no session behind it, and a wedged helper would leave it sitting as a failure nobody attempted.
 *
 * With no helper paired the control is visibly disabled and says why, rather than being absent or
 * silently inert: "nothing happened and I don't know why" is the failure this whole surface exists
 * to replace.
 */
export function AgentRunControl({ config }: { config: TestConfigView }) {
  const titleId = useId();
  const { navigate } = useRouter();
  const { toast } = useToast();
  const helper = useBridgeHelper();
  const environments = useEnvironments();
  const run = useRequestAgentRun();
  const [picking, setPicking] = useState(false);
  const [envId, setEnvId] = useState<string | null>(null);

  const paired = helper.data?.helperConnected === true;
  // An Agent-Driven Test's journey starts wherever its environment says, and the environment also
  // decides which approved baselines the captures are compared against — so the choice is offered
  // whenever there is one to make. With no environments defined there is nothing to ask about and
  // the request carries none, which `start_agent_run` resolves to the `default` fallback exactly
  // as it does for a session started by hand.
  const hasEnvironments = (environments.data ?? []).length > 0;
  // Held until the list has actually arrived. Pressing Run mid-fetch would read "no environments"
  // and send a request naming none — silently choosing on the author's behalf, which is the one
  // thing this control must never do.
  const ready = !environments.isLoading;

  function send(environmentId: string | null) {
    run.mutate(
      { testId: config.id, environmentId: environmentId ?? undefined },
      {
        onSuccess: () => {
          setPicking(false);
          const envName = environmentId
            ? environments.data?.find((e) => e.id === environmentId)?.name
            : null;
          toast(
            `Asked your Claude to run “${config.name}”${envName ? ` · ${envName}` : ""} — it appears in Runs once the session starts.`,
          );
        },
        // The server's message IS the refusal: which of the reasons it was, in words a person can
        // act on. Replacing it with a generic failure would throw away the only useful content.
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t ask your Claude to run this"),
      },
    );
  }

  function press() {
    if (hasEnvironments) {
      setEnvId(null);
      setPicking(true);
      return;
    }
    send(null);
  }

  return (
    <Card className={styles.card}>
      <div className={styles.head}>
        <div>
          <h2 className={styles.title}>Run this test</h2>
          <p className={styles.hint}>
            Varys asks the Claude you have paired to walk these instructions on your machine, under
            your own subscription. Nothing is recorded until that session starts — the run appears
            under Runs when it does.
          </p>
        </div>
        <Button
          variant="primary"
          iconLeft={<Play size={14} />}
          disabled={!paired || !ready || run.isPending}
          loading={run.isPending}
          onClick={press}
        >
          Run now
        </Button>
      </div>

      {!paired && (
        <div className={styles.blocked}>
          <Sparkles size={15} />
          <span>
            <strong>No Bridge Helper is paired</strong>, so there is nothing on your machine to run
            this. Open <strong>Author with AI</strong>, start a helper and enter its pairing code —
            this button goes live as soon as it connects.
          </span>
          <Button variant="ghost" size="sm" onClick={() => navigate({ name: "author" })}>
            Author with AI
          </Button>
        </div>
      )}

      <Modal open={picking} onClose={() => setPicking(false)} width={440} labelledBy={titleId}>
        <ModalHeader
          icon={<Play />}
          title="Run with your Claude"
          titleId={titleId}
          subtitle={config.name}
          onClose={() => setPicking(false)}
        />
        <ModalBody>
          <div className={styles.field}>
            <div className={styles.label}>Environment</div>
            <p className={styles.fieldHint}>
              Decides where the journey starts and which approved baselines each capture is
              compared against.
            </p>
            <EnvironmentPicker
              ariaLabel="Environment to run against"
              environments={environments.data ?? []}
              value={envId}
              onChange={setEnvId}
              noneOption={{ label: "No environment", hint: "default" }}
            />
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={() => setPicking(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            iconLeft={<Play />}
            loading={run.isPending}
            disabled={run.isPending}
            onClick={() => send(envId)}
          >
            Run now
          </Button>
        </ModalFooter>
      </Modal>
    </Card>
  );
}
