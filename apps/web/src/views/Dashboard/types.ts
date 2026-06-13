import type { IconProps, Intent } from "@varys/ui";
import type { ComponentType } from "react";

/**
 * The presentational shape a `KpiCard` renders. The API returns raw figures
 * (`DashboardSummary`); the dashboard maps those into these display props —
 * formatting the value, picking the tone/direction, and attaching the icon
 * (a React component, so it can't come from the API).
 */
export interface Kpi {
  label: string;
  value: string;
  delta: string;
  deltaTone: Extract<Intent, "success" | "warning" | "danger">;
  deltaDir: "up" | "down";
  sub: string;
  Icon: ComponentType<IconProps>;
}
