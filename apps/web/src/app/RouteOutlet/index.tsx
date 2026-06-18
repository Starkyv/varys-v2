import { useRouter } from "../../context/router";
import { Author } from "../../views/Author";
import { Dashboard } from "../../views/Dashboard";
import { Drafts } from "../../views/Drafts";
import { Environments } from "../../views/Environments";
import { NeedsReview } from "../../views/NeedsReview";
import { RunDetail } from "../../views/RunDetail";
import { Runs } from "../../views/Runs";
import { SuiteRuns } from "../../views/SuiteRuns";
import { Suites } from "../../views/Suites";
import { TestDetail } from "../../views/TestDetail";
import { Tests } from "../../views/Tests";

/** Renders the view for the current route. The page transition lives in AppShell. */
export function RouteOutlet() {
  const { route } = useRouter();
  switch (route.name) {
    case "dashboard":
      return <Dashboard />;
    case "tests":
      return <Tests />;
    case "drafts":
      return <Drafts />;
    case "author":
      return <Author />;
    case "suites":
      return <Suites />;
    case "runs":
      return <Runs />;
    case "suiteRuns":
      return <SuiteRuns />;
    case "needsReview":
      return <NeedsReview />;
    case "environments":
      return <Environments />;
    case "runDetail":
      return <RunDetail runId={route.runId} />;
    case "testDetail":
      return <TestDetail testId={route.testId} />;
  }
}
