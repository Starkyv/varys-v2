import type { DraftSummary } from "@varys/review-contract";
import {
  AlertTriangle,
  Badge,
  Button,
  Eye,
  Inbox,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Search,
  SegmentedControl,
  Skeleton,
} from "@varys/ui";
import { useId, useMemo, useState } from "react";
import { LiveIndicator } from "../../components/LiveIndicator";
import { useRouter } from "../../context/router";
import { useRunDialog } from "../../context/run-dialog";
import { useToast } from "../../context/toast";
import { relativeTime } from "../../lib/format";
import { useDiscardDraft, useDrafts } from "../../queries";
import { DraftInspector } from "./components/DraftInspector";
import { PromoteDialog } from "./components/PromoteDialog";
import styles from "./styles.module.scss";

type Filter = "all" | "has" | "none";
type Sort = "newest" | "oldest";

/** A draft authored within the last two minutes reads as "just landed". */
const NEW_WINDOW_MS = 2 * 60 * 1000;

/**
 * The AI-authored Draft review queue (Slice 14) — a master-detail review surface
 * (recreated from the Claude Design review-queue mock): a filterable/sortable list of
 * drafts beside an inspector that shows what each draft asserts (its authoring-preview
 * screenshots), its steering intent, and the review actions. Promotion lives here in the
 * web UI; it is never an agent tool, so Claude cannot self-promote.
 */
export function Drafts() {
  const queue = useDrafts();
  const discard = useDiscardDraft();
  const { navigate } = useRouter();
  const { openRunDialog } = useRunDialog();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<DraftSummary | null>(null);
  const [discarding, setDiscarding] = useState<DraftSummary | null>(null);
  const discardTitleId = useId();

  const all = queue.data ?? [];

  // Filter + search + sort, derived on render (the list is small and polled).
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all
      .filter((d) => {
        if (filter === "has" && d.checkpointCount === 0) return false;
        if (filter === "none" && d.checkpointCount > 0) return false;
        if (q && !`${d.name} ${d.intent ?? ""}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        const newestFirst = b.createdAt.localeCompare(a.createdAt);
        return sort === "newest" ? newestFirst : -newestFirst;
      });
  }, [all, search, filter, sort]);

  // The inspected draft: keep the selection if it's still shown, else fall back to the first.
  const selected = shown.find((d) => d.id === selectedId) ?? shown[0] ?? null;

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
        title="Couldn’t load the review queue"
        description="GET /drafts failed — your drafts are safe, this is a temporary read failure."
        onRetry={() => queue.refetch()}
      />
    );
  }

  if (all.length === 0) {
    return (
      <EmptyState
        icon={<Inbox />}
        tone="neutral"
        title="No drafts to review"
        description="Point Claude at your app through the MCP server and ask it to author a test. New drafts land here the moment a recording finishes."
      />
    );
  }

  const shownLabel =
    shown.length === all.length
      ? `${all.length} draft${all.length === 1 ? "" : "s"}`
      : `${shown.length} of ${all.length} drafts`;

  return (
    <div>
      <div className={styles.head}>
        <span className={styles.count}>
          <strong>{shownLabel}</strong>
        </span>
        <Badge tone="primary" appearance="soft" size="sm">
          AI-authored
        </Badge>
        <span className={styles.spacer} />
        <div className={styles.searchWrap}>
          <Input
            type="search"
            inputSize="sm"
            leadingIcon={<Search size={16} />}
            placeholder="Search name or intent…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search drafts"
          />
        </div>
        <SegmentedControl<Filter>
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "has", label: "Has checkpoints" },
            { value: "none", label: "No checkpoints" },
          ]}
        />
        <SegmentedControl<Sort>
          value={sort}
          onValueChange={setSort}
          options={[
            { value: "newest", label: "Newest" },
            { value: "oldest", label: "Oldest" },
          ]}
        />
      </div>

      <div className={styles.grid}>
        <div className={styles.listCard}>
          <div className={styles.listHead}>
            <span className={styles.listHeadLabel}>Drafts</span>
            <LiveIndicator label="Live · 5s" />
          </div>

          {shown.length === 0 ? (
            <div className={styles.listEmpty}>
              <span className={styles.listEmptyIcon}>
                <Search size={18} />
              </span>
              No drafts match your filters.
            </div>
          ) : (
            <div className={styles.list}>
              {shown.map((d) => {
                const isNew = Date.now() - new Date(d.createdAt).getTime() < NEW_WINDOW_MS;
                const zero = d.checkpointCount === 0;
                return (
                  <button
                    type="button"
                    key={d.id}
                    className={`${styles.row} ${selected?.id === d.id ? styles.rowSel : ""}`}
                    onClick={() => setSelectedId(d.id)}
                  >
                    <span className={styles.thumb}>
                      {d.previewUrl ? <img src={d.previewUrl} alt="" loading="lazy" /> : <Eye size={16} />}
                    </span>
                    <span className={styles.rowBody}>
                      <span className={styles.rowTitle}>
                        <span className={styles.rowName}>{d.name}</span>
                        {isNew && <span className={styles.newBadge}>NEW</span>}
                      </span>
                      <span className={styles.rowMeta}>
                        {zero ? (
                          <Badge tone="warning" appearance="soft" size="sm" icon={<AlertTriangle size={11} />}>
                            Asserts nothing
                          </Badge>
                        ) : (
                          <span className={styles.cpPill}>
                            {d.checkpointCount} checkpoint{d.checkpointCount === 1 ? "" : "s"}
                          </span>
                        )}
                        <span className={styles.rowTime}>{relativeTime(d.createdAt)}</span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className={styles.inspector}>
          {selected ? (
            <DraftInspector
              key={selected.id}
              draft={selected}
              onPromote={() => setPromoting(selected)}
              onDiscard={() => setDiscarding(selected)}
              onRunPreview={() => openRunDialog(selected.id)}
              onOpenEditor={() => navigate({ name: "testDetail", testId: selected.id })}
            />
          ) : (
            <div className={styles.inspectorEmpty}>
              <span className={styles.inspectorEmptyIcon}>
                <Eye size={20} />
              </span>
              Select a draft to inspect it here.
            </div>
          )}
        </div>
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
            recording. <strong>This cannot be undone.</strong>
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
