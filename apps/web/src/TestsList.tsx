import { useEffect, useState } from "react";
import { useEnvironments, useRunTest, useTests } from "./queries";
import styles from "./TestsList.module.css";

/** Remember the last-used environment across reloads, so Run defaults to it. */
const LAST_ENV_KEY = "varys:lastEnvId";

/**
 * The Tests view: the saved recordings, each runnable on demand against a chosen
 * environment. Recording (in the extension) only *saves* a test — this is where you
 * find it, pick an environment, and press Run, which triggers a run; the result then
 * shows up under Needs review.
 *
 * Requirement rule: a test that references variables/secrets (`needsEnvironment`)
 * can't be run without an environment — its Run button is disabled until one is
 * picked. A test with no variables runs with no environment, as before.
 */
export function TestsList() {
  const { data, isLoading, isError, error } = useTests();
  const envs = useEnvironments();
  const run = useRunTest();

  // The environment to run against (shared across the rows), seeded from the last use.
  const [envId, setEnvId] = useState<string>(() => localStorage.getItem(LAST_ENV_KEY) ?? "");

  // Drop a remembered environment that no longer exists, so a stale id can't be sent.
  useEffect(() => {
    if (envId && envs.data && !envs.data.some((e) => e.id === envId)) {
      setEnvId("");
      localStorage.removeItem(LAST_ENV_KEY);
    }
  }, [envId, envs.data]);

  const chooseEnv = (id: string) => {
    setEnvId(id);
    if (id) localStorage.setItem(LAST_ENV_KEY, id);
    else localStorage.removeItem(LAST_ENV_KEY);
  };

  if (isLoading) {
    return (
      <p role="status" className={styles.notice}>
        Loading tests…
      </p>
    );
  }
  if (isError) {
    return (
      <p role="alert" className={styles.error}>
        Couldn’t load tests: {(error as Error).message}
      </p>
    );
  }
  if (!data) return null;
  if (data.length === 0) {
    return <p className={styles.empty}>No saved tests yet — record one with the extension.</p>;
  }

  const noEnvs = !!envs.data && envs.data.length === 0;

  return (
    <main className={styles.list}>
      <h1>Tests</h1>

      <div className={styles.envBar}>
        <label htmlFor="run-env">Run against:</label>
        <select
          id="run-env"
          className={styles.envSelect}
          value={envId}
          onChange={(e) => chooseEnv(e.target.value)}
        >
          <option value="">No environment</option>
          {envs.data?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        {noEnvs && (
          <a className={styles.envHint} href="?view=environments">
            No environments yet — create one
          </a>
        )}
      </div>

      {run.isSuccess && run.data && (
        <p role="status" className={styles.notice}>
          Run started — <a href={`?run=${run.data.runId}`}>view it</a>, or it’ll appear under
          Needs review shortly.
        </p>
      )}
      {run.isError && (
        <p role="alert" className={styles.error}>
          Couldn’t start run: {(run.error as Error).message}
        </p>
      )}

      <ul className={styles.items}>
        {data.map((t) => {
          const blocked = t.needsEnvironment && !envId;
          return (
            <li key={t.id} className={styles.row}>
              <span className={styles.name}>{t.name}</span>
              {t.needsEnvironment && (
                <span className={styles.badge} title="References variables — needs an environment">
                  needs env
                </span>
              )}
              <span className={styles.time}>{new Date(t.createdAt).toLocaleString()}</span>
              <button
                type="button"
                className={styles.run}
                disabled={run.isPending || blocked}
                title={
                  blocked
                    ? "This test references variables — pick an environment to run it."
                    : undefined
                }
                onClick={() => run.mutate({ testId: t.id, environmentId: envId || undefined })}
              >
                Run
              </button>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
