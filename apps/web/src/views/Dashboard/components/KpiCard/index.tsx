import { ArrowDownRight, ArrowUpRight, Badge } from "@varys/ui";
import type { Kpi } from "../../types";
import styles from "./styles.module.scss";

export function KpiCard({ kpi }: { kpi: Kpi }) {
  const { Icon } = kpi;
  const Arrow = kpi.deltaDir === "up" ? ArrowUpRight : ArrowDownRight;
  return (
    <div className={styles.card}>
      <div className={styles.top}>
        <span className={styles.label}>{kpi.label}</span>
        <span className={styles.iconSquare}>
          <Icon size={15} />
        </span>
      </div>
      <div className={styles.valueRow}>
        <span className={styles.value}>{kpi.value}</span>
        <Badge tone={kpi.deltaTone} icon={<Arrow size={13} />}>
          {kpi.delta}
        </Badge>
      </div>
      <div className={styles.sub}>{kpi.sub}</div>
    </div>
  );
}
