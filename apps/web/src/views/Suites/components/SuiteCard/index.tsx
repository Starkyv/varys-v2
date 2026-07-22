import type { SuiteSummary } from "@varys/review-contract";
import { Button, Pencil, Play, Squares } from "@varys/ui";
import { formatActor } from "../../../../lib/format";
import styles from "./styles.module.scss";

export function SuiteCard({
  suite,
  onRun,
  onEdit,
}: {
  suite: SuiteSummary;
  onRun: () => void;
  onEdit: () => void;
}) {
  return (
    <div className={styles.card}>
      <div className={styles.top}>
        <span className={styles.icon}>
          <Squares size={20} />
        </span>
        <div className={styles.text}>
          <div className={styles.name}>{suite.name}</div>
          <div className={styles.count}>
            {suite.testCount} test{suite.testCount === 1 ? "" : "s"}
            {suite.folderCount > 0 && (
              <span> · {suite.folderCount} folder{suite.folderCount === 1 ? "" : "s"}</span>
            )}
            {suite.createdBy && (
              <span title={`Created by ${suite.createdBy}`}> · by {formatActor(suite.createdBy)}</span>
            )}
          </div>
        </div>
      </div>
      <div className={styles.actions}>
        <Button variant="primary" size="sm" fullWidth iconLeft={<Play size={14} />} onClick={onRun}>
          Run
        </Button>
        <Button variant="secondary" size="sm" iconLeft={<Pencil size={14} />} onClick={onEdit}>
          Edit
        </Button>
      </div>
    </div>
  );
}
