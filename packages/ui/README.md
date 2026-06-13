# @varys/ui — Varys Design System

The **"Nexus"** visual language: design tokens, themes, and primitive React
components. Single source of truth for the web app's look, and a self-contained,
droppable design-system folder.

## Structure

```
src/
  tokens/        TypeScript source of truth (colors, spacing, type, …) — JS-land values
  themes/        tokens → CSS custom properties; light/dark + per-brand (data-brand)
  foundations/   reset, base element styles, SCSS mixins
  components/    React + SCSS-module primitives (Button, Badge, Card, …)
  icons/         SVG-as-component + <IconBase> wrapper
  hooks/         useTheme, useMediaQuery
  utils/         cx (className combiner)
  types/         shared prop types
  index.ts       public API barrel
  index.scss     stylesheet entry (import once at the app root)
```

## Usage

```ts
// once, at the app root (main.tsx)
import "@varys/ui/styles.scss";

// anywhere
import { Button, Card, CardHeader, Badge, useTheme } from "@varys/ui";
import { dataViz, colors } from "@varys/ui/tokens"; // raw values for charts/JS
```

## Theming

Tokens resolve through CSS custom properties, so theming is an attribute flip:

```tsx
const { theme, toggleTheme, setBrand } = useTheme();
// document.documentElement gets data-theme="dark" / data-brand="acme"
```

- **Color mode** — `data-theme="light" | "dark"`
- **Brand** — `data-brand="acme" | "globex"` (default "nexus" = no attribute)

Add a customer brand by copying `themes/brands/acme.scss`, overriding only the
`--color-brand-*` ramp, and registering it in `index.scss`.

## Conventions

- Components consume `var(--token)`, never raw hex. JS consumers (charts, the
  extension overlay) import from `@varys/ui/tokens`.
- One component per folder: `Name.tsx` · `Name.module.scss` · `Name.types.ts` ·
  `Name.stories.tsx` · `index.ts`.
- Tests are intentionally omitted (project testing posture); add `Name.test.tsx`
  if that changes.

## Storybook

Config lives in `.storybook/`. Storybook deps aren't installed by default — run
`pnpm add -D storybook @storybook/react-vite` in this package, then `pnpm storybook`.
