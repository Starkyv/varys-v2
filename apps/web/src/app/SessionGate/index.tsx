import { Spinner } from "@varys/ui";
import { type ReactNode, useEffect, useRef } from "react";
import { useSession } from "../../lib/auth";
import { UNAUTHORIZED_EVENT } from "../../lib/unauthorized";
import { Login } from "../../views/Login";
import styles from "./styles.module.scss";

/**
 * Gates the SPA on a Varys session: a splash while the session first resolves, the Login
 * screen when there is none, the app once signed in.
 *
 * Slice 10 — the client gate (the server-side guard enforces the API). A 401 from any
 * API call re-checks the session ONLY when we currently think we're signed in: on the
 * login screen a 401 is expected, and reacting to it would loop (refetch → splash →
 * Login remount → repeat).
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const { data, isPending, refetch } = useSession();

  // Latest session, read inside the event handler without re-subscribing on every render.
  const sessionRef = useRef(data);
  sessionRef.current = data;
  // Re-entry guard: one in-flight re-check at a time (leading-edge, NOT a trailing
  // debounce — a continuous 401 burst would keep resetting a trailing timer so it never
  // fires, and the stale session would never heal).
  const rechecking = useRef(false);

  useEffect(() => {
    const onUnauthorized = () => {
      // Only a signed-in session that just got rejected is worth re-checking. With no
      // session (the login screen), 401s are expected — ignore them, or we loop.
      if (!sessionRef.current?.user) return;
      if (rechecking.current) return;
      rechecking.current = true;
      // Fire immediately. If the server agrees the session is gone, `data` goes null,
      // the app unmounts (so its queries stop), and Login renders.
      void refetch().finally(() => {
        rechecking.current = false;
      });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [refetch]);

  // Splash only on the very first load. A background refetch while signed in keeps
  // `data` and leaves `isPending` false, so it never blanks the app.
  if (isPending && !data?.user) {
    return (
      <div className={styles.splash}>
        <Spinner size={28} label="Loading Varys" />
      </div>
    );
  }

  if (!data?.user) return <Login />;

  return <>{children}</>;
}
