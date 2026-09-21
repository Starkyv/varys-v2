import { isAgentRunRequestInFlight, type TestConfigView } from "@varys/review-contract";
import {
  AlertTriangle,
  Button,
  Card,
  Check,
  Clock,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Play,
  Sparkles,
  cx,
} from "@varys/ui";
import { useEffect, useId, useRef, useState } from "react";
import { BridgeHelperPairing } from "../../../../components/BridgeHelperPairing";
import { EnvironmentPicker } from "../../../../components/EnvironmentPicker";
import { useRouter } from "../../../../context/router";
import { useToast } from "../../../../context/toast";
import {
  useAgentRunRequest,
  useBridgeHelper,
  useEnvironments,
  useRequestAgentRun,
} from "../../../../queries";
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
 *
 * And because the press writes nothing, the gap it opens is shown rather than hidden: the request
 * is followed until it is acknowledged, fulfilled (the author is taken to the Run) or **lapses**.
 * Lapsing is the one that matters — a paired-but-wedged helper has to end in a sentence, not in a
 * spinner the author eventually gives up on.
 */
export function AgentRunControl({ config }: { config: TestConfigView }) {
  const titleId = useId();
  const { navigate } = useRouter();
  const { toast } = useToast();
  const helper = useBridgeHelper();
  const environments = useEnvironments();
  const request = useAgentRunRequest(config.id);
  const run = useRequestAgentRun();
  const [picking, setPicking] = useState(false);
  const [envId, setEnvId] = useState<string | null>(null);

  const phase = request.data?.phase ?? "none";
  const inFlight = isAgentRunRequestInFlight(phase);

  // Follow a request this page is actually waiting on — one pressed here, or one already open when
  // the page loaded (a reload mid-wait, or the author's other tab). NOT one that was already
  // finished when the page opened: the relay keeps a fulfilled request readable for a few minutes
  // so a slow poll still catches its outcome, and following those would bounce the author straight
  // back out of a page they deliberately came to.
  const following = useRef<number | null>(null);
  const followed = useRef<string | null>(null);
  useEffect(() => {
    const state = request.data;
    if (!state?.requestedAt) return;
    if (isAgentRunRequestInFlight(state.phase)) {
      following.current = state.requestedAt;
      return;
    }
    if (state.phase !== "fulfilled" || !state.runId) return;
    if (state.requestedAt !== following.current) return;
    if (followed.current === state.runId) return;
    followed.current = state.runId;
    navigate({ name: "runDetail", runId: state.runId });
  }, [request.data, navigate]);

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
          toast(`Asked your Claude to run “${config.name}”${envName ? ` · ${envName}` : ""}`);
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
          disabled={!paired || !ready || inFlight || run.isPending}
          loading={run.isPending}
          onClick={press}
        >
          Run now
        </Button>
      </div>

      {paired && inFlight && (
        <div className={styles.waiting}>
          <Clock size={15} />
          <span>
            {phase === "acknowledged" ? (
              <>
                <strong>Your Claude has been launched</strong> and is working towards the session.
                This page opens the run the moment it starts.
              </>
            ) : (
              <>
                <strong>Asked your Bridge Helper</strong> — waiting for it to start a session.
                Nothing has been recorded yet; the run exists once your Claude opens it.
              </>
            )}
          </span>
        </div>
      )}

      {paired && phase === "lapsed" && (
        <div className={styles.blocked}>
          <AlertTriangle size={15} />
          <span>
            {request.data?.acknowledgedAt ? (
              <>
                <strong>Your Claude was launched and no run was started.</strong> The session never
                opened, so there is nothing to look at — nothing was created either.
              </>
            ) : (
              <>
                <strong>Your Bridge Helper was asked and did not start a session.</strong> It is
                paired but not answering. Check the helper on your machine, then press Run again.
              </>
            )}
          </span>
        </div>
      )}

      {paired && phase === "fulfilled" && (
        <div className={cx(styles.waiting, styles.started)}>
          <Check size={15} />
          <span>A session started for this test — opening its run.</span>
        </div>
      )}

      {/* Not a signpost to somewhere else: the thing that fixes it is right here. Sending someone
          to another page to "start a helper" was the old copy, and the page it named offers no
          pairing — an instruction that cannot be followed is worse than none. */}
      {!paired && (
        <div className={cx(styles.blocked, styles.pairing)}>
          <div className={styles.blockedHead}>
            <Sparkles size={15} />
            <span>
              <strong>No Bridge Helper is paired</strong>, so there is nothing on your machine to
              run this. Pair one and this button goes live the moment it connects.
            </span>
          </div>
          <BridgeHelperPairing />
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
