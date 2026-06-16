import { Button, Card, Input, Lock } from "@varys/ui";
import { type FormEvent, useEffect, useState } from "react";
import { type AuthMethods, fetchAuthMethods, signIn, signUp } from "../../lib/auth";
import styles from "./styles.module.scss";

type Mode = "signin" | "signup";

/**
 * The login screen — Varys's front door. Rendered by <SessionGate> when there's no
 * session. Which methods show is server-driven (`/auth-config` ← VARYS_AUTH_METHODS):
 * the email/password form and/or a "Continue with Google" button.
 */
export function Login() {
  const [methods, setMethods] = useState<AuthMethods>({ emailPassword: true, google: false });
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchAuthMethods().then((m) => {
      if (alive) setMethods(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res =
        mode === "signin"
          ? await signIn.email({ email, password })
          : await signUp.email({ email, password, name: name.trim() || email });
      // On success the session store updates and <SessionGate> swaps in the app — no
      // navigation needed here. On failure better-auth returns a structured error.
      if (res.error) {
        setError(res.error.message ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function swapMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  async function google() {
    setError(null);
    // Redirects to Google; on return the session is set and <SessionGate> shows the app.
    await signIn.social({ provider: "google", callbackURL: window.location.origin });
  }

  return (
    <div className={styles.screen}>
      <div className={styles.panel}>
        <div className={styles.brand}>
          <span className={styles.mark}>
            <Lock size={18} />
          </span>
          <span className={styles.wordmark}>Varys</span>
        </div>

        <Card className={styles.card}>
          <h1 className={styles.title}>
            {methods.emailPassword && mode === "signup" ? "Create your account" : "Sign in"}
          </h1>
          <p className={styles.subtitle}>
            {methods.emailPassword && mode === "signup"
              ? "Set up an account to get started."
              : "Welcome back — sign in to continue."}
          </p>

          {methods.emailPassword && (
            <form className={styles.form} onSubmit={submit}>
              {mode === "signup" && (
                <label className={styles.field}>
                  <span className={styles.label}>Name</span>
                  <Input
                    type="text"
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                  />
                </label>
              )}

              <label className={styles.field}>
                <span className={styles.label}>Email</span>
                <Input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@datagenie.ai"
                />
              </label>

              <label className={styles.field}>
                <span className={styles.label}>Password</span>
                <Input
                  type="password"
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </label>

              {error && (
                <div className={styles.error} role="alert">
                  {error}
                </div>
              )}

              <Button type="submit" variant="primary" fullWidth loading={busy}>
                {mode === "signin" ? "Sign in" : "Create account"}
              </Button>
            </form>
          )}

          {methods.emailPassword && methods.google && (
            <div className={styles.divider}>
              <span>or</span>
            </div>
          )}

          {methods.google && (
            <Button variant="secondary" fullWidth onClick={google}>
              Continue with Google
            </Button>
          )}

          {!methods.emailPassword && error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}

          {methods.emailPassword && (
            <div className={styles.swap}>
              {mode === "signin" ? (
                <>
                  New to Varys?{" "}
                  <button type="button" className={styles.link} onClick={() => swapMode("signup")}>
                    Create an account
                  </button>
                </>
              ) : (
                <>
                  Already have an account?{" "}
                  <button type="button" className={styles.link} onClick={() => swapMode("signin")}>
                    Sign in
                  </button>
                </>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
