import { useRunTest, useTests } from "./queries";
import styles from "./TestsList.module.css";

/**
 * The Tests view: the saved recordings, each runnable on demand. Recording (in the
 * extension) only *saves* a test — this is where you find it and press Run, which
 * triggers a run; the result then shows up under Needs review.
 */
export function TestsList() {
  const { data, isLoading, isError, error } = useTests();
  const run = useRunTest();

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

  return (
    <main className={styles.list}>
      <h1>Tests</h1>

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
        {data.map((t) => (
          <li key={t.id} className={styles.row}>
            <span className={styles.name}>{t.name}</span>
            <span className={styles.time}>{new Date(t.createdAt).toLocaleString()}</span>
            <button
              type="button"
              className={styles.run}
              disabled={run.isPending}
              onClick={() => run.mutate(t.id)}
            >
              Run
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
