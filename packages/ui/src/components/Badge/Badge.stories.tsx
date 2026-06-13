import type { Meta, StoryObj } from "@storybook/react";
import { ArrowDownRight, ArrowUpRight } from "../../icons";
import { Badge } from "./Badge";

const meta: Meta<typeof Badge> = {
  title: "Components/Badge",
  component: Badge,
  args: { children: "Label", tone: "neutral", appearance: "soft" },
  argTypes: {
    tone: { control: "inline-radio", options: ["neutral", "primary", "success", "warning", "danger", "info"] },
    appearance: { control: "inline-radio", options: ["soft", "solid", "outline"] },
  },
};
export default meta;

type Story = StoryObj<typeof Badge>;

export const Soft: Story = {};

/** The dashboard stat-card deltas. */
export const Deltas: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 12 }}>
      <Badge tone="success" icon={<ArrowUpRight />}>15.8%</Badge>
      <Badge tone="danger" icon={<ArrowDownRight />}>34.0%</Badge>
    </div>
  ),
};

/** Varys run statuses. */
export const RunStatuses: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 12 }}>
      <Badge tone="success" dot>Passed</Badge>
      <Badge tone="warning" dot>Needs review</Badge>
      <Badge tone="danger" dot>Failed</Badge>
      <Badge tone="info" dot>Healed</Badge>
    </div>
  ),
};
