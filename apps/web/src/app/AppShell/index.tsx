import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import { type Route, useRouter } from "../../context/router";
import { Sidebar } from "../Sidebar";
import { TopBar } from "../TopBar";
import styles from "./styles.module.scss";

/** A stable key per "page", so switching views animates but in-view updates don't. */
function pageKey(route: Route): string {
  if (route.name === "runDetail") return `runDetail:${route.runId}`;
  if (route.name === "testDetail") return `testDetail:${route.testId}`;
  return route.name;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { route } = useRouter();
  const reduce = useReducedMotion();

  return (
    <div className={styles.shell}>
      <Sidebar />
      <div className={styles.column}>
        <TopBar />
        <main className={styles.main} data-scroll-region>
          <div className={styles.container}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={pageKey(route)}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
                transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>
    </div>
  );
}
