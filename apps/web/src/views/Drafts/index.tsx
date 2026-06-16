import {
  AlertTriangle,
  Badge,
  Button,
  Eye,
  Inbox,
  EmptyState,
  ErrorState,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Pencil,
  Play,
  Skeleton,
  Trash,
} from "@varys/ui";
import { motion, useReducedMotion } from "framer-motion";
import { useId, useState } from "react";
import type { DraftSummary } from "@varys/review-contract";
import { LiveIndicator } from "../../components/LiveIndicator";
import { useRouter } from "../../context/router";
import { useRunDialog } from "../../context/run-dialog";
import { useToast } from "../../context/toast";
import { relativeTime } from "../../lib/format";
import { useDiscardDraft, useDrafts } from "../../queries";
import { PromoteDialog } from "./components/PromoteDialog";
import styles from "./styles.module.scss";

/**
 * The AI-authored Draft review queue (Slice 14). Each draft is a real test held out of
 * suites/schedules until a human reviews it in the test-detail editor, seeds baselines,
 * and promotes it (folder + tags + active) — or discards it. Promotion lives here, in
 * the web UI; it is never an agent tool, so Claude cannot self-promote.
 */
export function Drafts() {
  const queue = useDrafts();
  const discard = useDiscardDraft();
  const { navigate } = useRouter();
  const { openRunDialog } = useRunDialog();
  const { toast } = useToast();
  const reduce = useReducedMotion();
  const [promoting, setPromoting] = useState<DraftSummary | null>(null);
  const [discarding, setDiscarding] = useState<DraftSummary | null>(null);
  const discardTitleId = useId();

  if (queue.isLoading) {
    return (
      <div className={styles.loading}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={84} radius="var(--radius-xl)" />
        ))}
      </div>
    );
  }

  if (queue.isError) {
    return (
      <ErrorState
        title="Review queue unavailable"
        description="GET /drafts failed to load."
        onRetry={() => queue.refetch()}
      />
    );
  }

  const data = queue.data ?? [];
  if (data.length === 0) {
    return (
      <EmptyState
        icon={<Inbox />}
        tone="neutral"
        title="No drafts to review"
        description="Tests authored by Claude through the MCP server land here for a human to review and promote. Point Claude at an app and ask it to author a test."
      />
    );
  }

  return (
    <div>
      <div className={styles.head}>
        <span className={styles.count}>
          <strong>{data.length}</strong> draft{data.length === 1 ? "" : "s"} awaiting review
        </span>
        <span className={styles.spacer} />
        <LiveIndicator />
      </div>

      <div className={styles.list}>
        {data.map((d, i) => (
          <motion.div
            key={d.id}
            className={styles.row}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: Math.min(i, 8) * 0.04 }}
          >
            <span className={styles.glyph}>
              <Pencil size={18} />
            </span>
            <div className={styles.body}>
              <div className={styles.titleRow}>
                <span className={styles.name}>{d.name}</span>
                <Badge tone="primary" appearance="soft" size="sm">
                  AI-authored
                </Badge>
                {d.checkpointCount === 0 ? (
                  <Badge tone="warning" appearance="soft" size="sm" icon={<AlertTriangle size={12} />}>
                    No checkpoints
                  </Badge>
                ) : (
                  <span className={styles.checkpoints}>
                    {d.checkpointCount} checkpoint{d.checkpointCount === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              {d.intent && <div className={styles.intent}>“{d.intent}”</div>}
              <div className={styles.meta}>Authored {relativeTime(d.createdAt)}</div>
            </div>
            <div className={styles.actions}>
              <Button
                variant="ghost"
                iconLeft={<Eye size={15} />}
                onClick={() => navigate({ name: "testDetail", testId: d.id })}
              >
                Open
              </Button>
              <Button
                variant="secondary"
                iconLeft={<Play size={14} />}
                onClick={() => openRunDialog(d.id)}
              >
                Run preview
              </Button>
              <Button variant="primary" onClick={() => setPromoting(d)}>
                Promote
              </Button>
              <Button
                variant="ghost"
                aria-label={`Discard ${d.name}`}
                iconLeft={<Trash size={15} />}
                onClick={() => setDiscarding(d)}
              />
            </div>
          </motion.div>
        ))}
      </div>

      <PromoteDialog draft={promoting} open={promoting !== null} onClose={() => setPromoting(null)} />

      <Modal open={discarding !== null} onClose={() => setDiscarding(null)} width={420} labelledBy={discardTitleId}>
        <ModalHeader
          icon={<AlertTriangle size={20} />}
          title="Discard draft?"
          titleId={discardTitleId}
          onClose={() => setDiscarding(null)}
        />
        <ModalBody>
          <p className={styles.confirmText}>
            Discarding <strong>{discarding?.name}</strong> permanently deletes this draft and its
            authoring history. <strong>This cannot be undone.</strong>
          </p>
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={() => setDiscarding(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={discard.isPending}
            onClick={() => {
              if (!discarding) return;
              const name = discarding.name;
              discard.mutate(discarding.id, {
                onSuccess: () => {
                  toast(`Discarded “${name}”`);
                  setDiscarding(null);
                },
                onError: (e) => toast((e as Error).message),
              });
            }}
          >
            Discard
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}
