import type { Meta, StoryObj } from "@storybook/react";
import { ArrowUpRight, Info } from "../../icons";
import { Badge } from "../Badge";
import { Button } from "../Button";
import { Card, CardHeader } from "./Card";

const meta: Meta<typeof Card> = {
  title: "Components/Card",
  component: Card,
};
export default meta;

type Story = StoryObj<typeof Card>;

/** A KPI stat card, reproduced from the dashboard. */
export const StatCard: Story = {
  render: () => (
    <Card style={{ maxWidth: 360 }}>
      <CardHeader icon={<Info />} title="Page Views" actions={<Info color="var(--color-text-subtle)" />} />
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <span style={{ font: "var(--font-display)", fontSize: "1.875rem", fontWeight: 700, color: "var(--color-text-strong)" }}>
          12,450
        </span>
        <Badge tone="success" icon={<ArrowUpRight />}>15.8%</Badge>
      </div>
    </Card>
  ),
};

export const WithActions: Story = {
  render: () => (
    <Card style={{ maxWidth: 480 }}>
      <CardHeader
        title="Sales Overview"
        actions={
          <>
            <Button variant="secondary" size="sm">Filter</Button>
            <Button variant="secondary" size="sm">Sort</Button>
          </>
        }
      />
      <p style={{ color: "var(--color-text-muted)" }}>Chart goes here.</p>
    </Card>
  ),
};
