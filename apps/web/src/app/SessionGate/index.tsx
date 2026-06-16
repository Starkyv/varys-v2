import { Spinner } from "@varys/ui";
import { type ReactNode, useEffect } from "react";
import { useSession } from "../../lib/auth";
import { UNAUTHORIZED_EVENT } from "../../lib/unauthorized";
import { Login } from "../../views/Login";
import styles from "./styles.module.scss";

/**
 * Gates the SPA on a Varys session: a splash while the session resolves, the Login
 * screen when there is none, the app once signed in.
 *
 * Slice 10 / Issue 1 — this is the CLIENT gate (it decides what the SPA renders). The
 * server-side guard that actually enforces the API (deny-by-default + 401) lands in
 * Issue 2; until then the API is still open, but the UI already requires a sign-in.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const { data, isPending, refetch } = useSession();

  // A 401 from any API call (session expired/revoked mid-use) → re-check the session.
  // If the server agrees it's gone, `refetch` sets `data` to null and Login renders.
  useEffect(() => {
    const onUnauthorized = () => {
      void refetch();
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [refetch]);

  if (isPending) {
    return (
      <div className={styles.splash}>
        <Spinner size={28} label="Loading Varys" />
      </div>
    );
  }

  if (!data) return <Login />;

  return <>{children}</>;
}
