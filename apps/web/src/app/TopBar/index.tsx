import { Bell, Button, IconButton, Input, Menu, Play, Search } from "@varys/ui";
import { routeHeading, useRouter } from "../../context/router";
import { useRunDialog } from "../../context/run-dialog";
import { useUI } from "../../context/ui";
import styles from "./styles.module.scss";

export function TopBar() {
  const { route, navigate } = useRouter();
  const { toggleSidebar } = useUI();
  const { openRunDialog } = useRunDialog();
  const heading = routeHeading(route);

  return (
    <header className={styles.topbar}>
      <IconButton icon={<Menu />} label="Toggle sidebar" onClick={toggleSidebar} />

      <div className={styles.heading}>
        <div className={styles.title}>{heading.title}</div>
        <div className={styles.subtitle}>{heading.subtitle}</div>
      </div>

      <div className={styles.spacer} />

      <div className={styles.search}>
        <Input
          type="search"
          leadingIcon={<Search size={18} />}
          placeholder="Search tests, runs, checkpoints…"
          aria-label="Search"
        />
      </div>

      <div className={styles.bell}>
        <IconButton icon={<Bell />} label="Alerts" onClick={() => navigate({ name: "needsReview" })} />
        <span className={styles.bellDot} />
      </div>

      <Button variant="primary" iconLeft={<Play />} onClick={() => openRunDialog()}>
        Run test
      </Button>
    </header>
  );
}
