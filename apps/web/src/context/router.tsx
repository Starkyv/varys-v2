import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * A tiny URL-backed router. The control plane is a handful of top-level views plus
 * two detail pages, so a full router library would be overkill — this keeps the
 * existing same-origin deep links working behind the dev proxy / prod ingress:
 *
 *   ?run=<id>        → the run detail / diff viewer
 *   ?test=<id>       → the test detail / config page
 *   ?suiteRun=<id>   → suite runs, with that report selected
 *   ?view=<name>     → a top-level view
 */
export type NavKey =
  | "dashboard"
  | "tests"
  | "drafts"
  | "suites"
  | "runs"
  | "suiteRuns"
  | "needsReview"
  | "environments";

export type Route =
  | { name: "dashboard" }
  | { name: "tests" }
  | { name: "drafts" }
  | { name: "suites" }
  | { name: "runs" }
  | { name: "suiteRuns"; suiteRunId?: string }
  | { name: "needsReview" }
  | { name: "environments" }
  | { name: "runDetail"; runId: string }
  | { name: "testDetail"; testId: string };

const VIEW_PARAM: Record<NavKey, string> = {
  dashboard: "dashboard",
  tests: "tests",
  drafts: "drafts",
  suites: "suites",
  runs: "runs",
  suiteRuns: "suite-runs",
  needsReview: "needs-review",
  environments: "environments",
};
const PARAM_VIEW: Record<string, NavKey> = Object.fromEntries(
  Object.entries(VIEW_PARAM).map(([k, v]) => [v, k as NavKey]),
) as Record<string, NavKey>;

export function parseRoute(loc: Location = window.location): Route {
  const q = new URLSearchParams(loc.search);
  const run = q.get("run");
  if (run) return { name: "runDetail", runId: run };
  const test = q.get("test");
  if (test) return { name: "testDetail", testId: test };
  const suiteRun = q.get("suiteRun");
  if (suiteRun) return { name: "suiteRuns", suiteRunId: suiteRun };
  const view = q.get("view");
  const nav = view ? PARAM_VIEW[view] : undefined;
  if (nav === "suiteRuns") return { name: "suiteRuns" };
  if (nav) return { name: nav } as Route;
  return { name: "dashboard" };
}

export function routeToUrl(route: Route): string {
  switch (route.name) {
    case "runDetail":
      return `?run=${encodeURIComponent(route.runId)}`;
    case "testDetail":
      return `?test=${encodeURIComponent(route.testId)}`;
    case "suiteRuns":
      return route.suiteRunId
        ? `?view=suite-runs&suiteRun=${encodeURIComponent(route.suiteRunId)}`
        : "?view=suite-runs";
    default:
      return `?view=${VIEW_PARAM[route.name as NavKey]}`;
  }
}

/** The sidebar nav item a route belongs under (run detail lives under Runs; test
 *  detail under Tests). */
export function activeNav(route: Route): NavKey {
  if (route.name === "runDetail") return "runs";
  if (route.name === "testDetail") return "tests";
  return route.name as NavKey;
}

interface RouterValue {
  route: Route;
  navigate: (route: Route) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() => parseRoute());

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((next: Route) => {
    window.history.pushState(null, "", routeToUrl(next));
    setRoute(next);
    // Views scroll independently; reset the main scroll region on navigation.
    document.querySelector("[data-scroll-region]")?.scrollTo({ top: 0 });
  }, []);

  const value = useMemo(() => ({ route, navigate }), [route, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRouter must be used within <RouterProvider>");
  return ctx;
}

/** Title + subtitle for the top bar, per route. */
export function routeHeading(route: Route): { title: string; subtitle: string } {
  switch (route.name) {
    case "dashboard":
      return { title: "Dashboard", subtitle: "Visual regression health across every environment" };
    case "tests":
      return { title: "Tests", subtitle: "Organize, file and run your recordings" };
    case "drafts":
      return { title: "Review queue", subtitle: "AI-authored drafts awaiting review & promotion" };
    case "suites":
      return { title: "Suites", subtitle: "Saved selections you run against environments" };
    case "runs":
      return { title: "Runs", subtitle: "Every replay, newest first · live" };
    case "suiteRuns":
      return { title: "Suite runs", subtitle: "Fan-outs of suite × environment" };
    case "needsReview":
      return { title: "Needs review", subtitle: "Checkpoints awaiting a human decision" };
    case "environments":
      return { title: "Environments", subtitle: "Per-deployment variables & secrets" };
    case "runDetail":
      return { title: "Run detail", subtitle: "Replay timeline & diff review" };
    case "testDetail":
      return { title: "Test detail", subtitle: "Waits & thresholds — applied on the next run" };
  }
}
