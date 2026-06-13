import type { Meta, StoryObj } from "@storybook/react";
import { ChevronDown } from "../../icons";
import { Button } from "./Button";

const meta: Meta<typeof Button> = {
  title: "Components/Button",
  component: Button,
  args: { children: "Run test" },
  argTypes: {
    variant: { control: "inline-radio", options: ["primary", "secondary", "ghost", "danger"] },
    size: { control: "inline-radio", options: ["sm", "md", "lg"] },
  },
};
export default meta;

type Story = StoryObj<typeof Button>;

export const Primary: Story = { args: { variant: "primary" } };
export const Secondary: Story = {
  args: { variant: "secondary", children: "Monthly", iconRight: <ChevronDown /> },
};
export const Ghost: Story = { args: { variant: "ghost", children: "Filter" } };
export const Danger: Story = { args: { variant: "danger", children: "Reject" } };
export const Loading: Story = { args: { loading: true } };

export const AllVariants: Story = {
  render: (args) => (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <Button {...args} variant="primary">Primary</Button>
      <Button {...args} variant="secondary">Secondary</Button>
      <Button {...args} variant="ghost">Ghost</Button>
      <Button {...args} variant="danger">Danger</Button>
    </div>
  ),
};
