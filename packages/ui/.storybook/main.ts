import type { StorybookConfig } from "@storybook/react-vite";

/**
 * Storybook config. Deps are NOT installed by default — to run the catalog:
 *   pnpm add -D storybook @storybook/react-vite @storybook/react @vitejs/plugin-react
 *   pnpm storybook
 */
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: [],
  framework: { name: "@storybook/react-vite", options: {} },
};

export default config;
