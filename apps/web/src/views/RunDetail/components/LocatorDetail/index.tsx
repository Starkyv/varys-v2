import type { FingerprintSummary } from "@varys/review-contract";
import { ChevronDown, cx } from "@varys/ui";
import type { ReactNode } from "react";
import styles from "./styles.module.scss";

/**
 * On-demand disclosure of the recorded fingerprint a step's locator was matched
 * against — shown for every step/checkpoint that has an element target, so both a
 * clean match and a "no fingerprint signal matched" failure are explainable inline.
 */
export function LocatorDetail({ target: t, unmatched = false }: { target: FingerprintSummary; unmatched?: boolean }) {
  return (
    <details className={styles.more}>
      <summary className={styles.summary}>
        <ChevronDown size={14} className={styles.summaryChevron} />
        What the locator was looking for
      </summary>
      <div className={styles.moreBody}>
        <p className={styles.moreHint}>
          {unmatched
            ? "A “no fingerprint signal matched” failure means none of these recorded signals uniquely matched a live element — usually because the element has no durable, unique identifier (or one rotated / drifted since recording)."
            : "The recorded signals the matcher resolved this step against. A durable, unique signal (a data-testid, id, or role + name) is what keeps a step locatable as the app changes."}
        </p>
        <dl className={styles.fpGrid}>
          <Field label="Element">
            <code className={styles.code}>{`<${t.tag}>`}</code>
            {t.role && (
              <span className={styles.muted}>
                {" "}
                · role <code className={styles.code}>{t.role}</code>
              </span>
            )}
          </Field>

          <Field label="Accessible name">
            {t.accessibleName ? (
              <>
                <span className={styles.value}>“{t.accessibleName}”</span>
                <span className={styles.muted}> · {t.nameFromAttr ? "from a stable attribute" : "from visible text"}</span>
              </>
            ) : (
              <span className={styles.none}>none recorded</span>
            )}
          </Field>

          <Field label="data-testid">
            {t.testId ? (
              <code className={styles.code}>{t.testId}</code>
            ) : (
              <span className={styles.none}>none — the strongest, most durable signal is absent</span>
            )}
          </Field>

          <Field label="id">
            {t.elementId ? <code className={styles.code}>#{t.elementId}</code> : <span className={styles.none}>none</span>}
          </Field>

          {t.attributes && (
            <Field label="Attributes">
              <span className={styles.chips}>
                {Object.entries(t.attributes).map(([k, v]) => (
                  <code key={k} className={styles.code}>
                    {k}={`"${v}"`}
                  </code>
                ))}
              </span>
            </Field>
          )}

          <Field label="Stable classes">
            {t.stableClasses ? (
              <span className={styles.chips}>
                {t.stableClasses.map((c) => (
                  <code key={c} className={styles.code}>
                    {c}
                  </code>
                ))}
              </span>
            ) : (
              <span className={styles.none}>none — no durable classes to match on</span>
            )}
          </Field>

          {t.moduleClasses && (
            <Field label="Hashed classes">
              <span className={styles.chips}>
                {t.moduleClasses.map((c) => (
                  <code key={c} className={cx(styles.code, styles.codeWeak)}>
                    {c}
                  </code>
                ))}
              </span>
              <span className={styles.muted}> — build-hashed; these rotate per deploy</span>
            </Field>
          )}

          {t.ancestors && (
            <Field label="Ancestors">
              <span className={styles.ancestors}>{t.ancestors.join(" › ")}</span>
            </Field>
          )}

          {t.boundingBox && (
            <Field label="Recorded box">
              <code className={styles.code}>
                {Math.round(t.boundingBox.x)}, {Math.round(t.boundingBox.y)} · {Math.round(t.boundingBox.width)}×
                {Math.round(t.boundingBox.height)} px
              </code>
            </Field>
          )}

          {t.text && (
            <Field label="Visible text">
              <pre className={styles.text}>{t.text}</pre>
            </Field>
          )}
        </dl>
      </div>
    </details>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className={styles.fpKey}>{label}</dt>
      <dd className={styles.fpVal}>{children}</dd>
    </>
  );
}
