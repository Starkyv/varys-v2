import {
  Activity,
  ChevronDown,
  cx,
  Dashboard,
  Database,
  Eye,
  Flask,
  type IconProps,
  Inbox,
  ListRun,
  Pencil,
  Puzzle,
  Squares,
} from "@varys/ui";
import { motion } from "framer-motion";
import type { ComponentType } from "react";
import { activeNav, type NavKey, type Route, useRouter } from "../../context/router";
import { useUI } from "../../context/ui";
import { useSession } from "../../lib/auth";
import { initials } from "../../lib/user";
import { useDrafts, useNeedsReview } from "../../queries";
import styles from "./styles.module.scss";

interface NavGroup {
  label: string;
  items: { key: NavKey; name: string; Icon: ComponentType<IconProps> }[];
}

const GROUPS: NavGroup[] = [
  { label: "Monitor", items: [{ key: "dashboard", name: "Dashboard", Icon: Dashboard }] },
  {
    label: "Library",
    items: [
      { key: "tests", name: "Tests", Icon: Flask },
      { key: "author", name: "Author with AI", Icon: Pencil },
      { key: "drafts", name: "Review queue", Icon: Inbox },
      { key: "suites", name: "Suites", Icon: Squares },
    ],
  },
  {
    label: "Execution",
    items: [
      { key: "runs", name: "Runs", Icon: Activity },
      { key: "suiteRuns", name: "Suite runs", Icon: ListRun },
      { key: "needsReview", name: "Needs review", Icon: Eye },
    ],
  },
  {
    label: "Configure",
    items: [
      { key: "environments", name: "Environments", Icon: Database },
      { key: "extension", name: "Browser extension", Icon: Puzzle },
    ],
  },
];

export function Sidebar() {
  const { route, navigate } = useRouter();
  const { sidebarCollapsed } = useUI();
  const needsReview = useNeedsReview();
  const drafts = useDrafts();
  const active = activeNav(route);
  const reviewCount = needsReview.data?.length ?? 0;
  const draftCount = drafts.data?.length ?? 0;

  // The signed-in identity, same source as the top bar's <UserMenu>.
  const user = useSession().data?.user;
  const accountName = user?.name || user?.email || "Signed in";
  // Show the email as the secondary line — unless the name is already the email
  // (no display name set), in which case there's nothing more to show.
  const accountSub = user?.name ? user.email : "";

  return (
    <aside className={cx(styles.sidebar, sidebarCollapsed && styles.collapsed)}>
      <div className={styles.brand}>
        <span className={styles.logo}>V</span>
        {!sidebarCollapsed && (
          <span className={styles.brandText}>
            <span className={styles.brandName}>Varys</span>
            <span className={styles.brandSub}>Visual regression</span>
          </span>
        )}
      </div>

      <nav className={styles.nav}>
        {GROUPS.map((group) => (
          <div key={group.label} className={styles.group}>
            {!sidebarCollapsed && <div className={styles.groupLabel}>{group.label}</div>}
            {group.items.map(({ key, name, Icon }) => {
              const isActive = active === key;
              const count = key === "needsReview" ? reviewCount : key === "drafts" ? draftCount : 0;
              return (
                <button
                  key={key}
                  type="button"
                  title={name}
                  aria-current={isActive ? "page" : undefined}
                  className={cx(styles.item, isActive && styles.itemActive)}
                  onClick={() => navigate({ name: key } as Route)}
                >
                  {isActive && (
                    <motion.span layoutId="nav-pill" className={styles.pill} transition={{ type: "spring", stiffness: 520, damping: 40 }} />
                  )}
                  <span className={styles.itemIcon}>
                    <Icon size={19} />
                  </span>
                  {!sidebarCollapsed && <span className={styles.itemLabel}>{name}</span>}
                  {count > 0 && !sidebarCollapsed && <span className={styles.count}>{count}</span>}
                  {count > 0 && sidebarCollapsed && <span className={styles.countDot} />}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className={styles.footer}>
        <button type="button" className={styles.account} title={accountName}>
          <span className={styles.avatar}>{initials(accountName)}</span>
          {!sidebarCollapsed && (
            <>
              <span className={styles.accountText}>
                <span className={styles.accountName}>{accountName}</span>
                {accountSub && <span className={styles.accountRole}>{accountSub}</span>}
              </span>
              <span className={styles.accountChevron}>
                <ChevronDown size={16} />
              </span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
