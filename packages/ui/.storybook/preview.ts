import type { Preview } from "@storybook/react";
// Load the design-system styles (tokens + themes + reset) into the canvas.
import "../src/index.scss";

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: "page",
      values: [
        { name: "page", value: "#eef0f4" },
        { name: "surface", value: "#ffffff" },
        { name: "dark", value: "#0d0f17" },
      ],
    },
  },
};

export default preview;
