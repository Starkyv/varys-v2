import type { ReactNode, SVGProps } from "react";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "width" | "height"> {
  /** Pixel size (width = height). Defaults to 1em so icons scale with text. */
  size?: number | string;
  /** Accessible label. When omitted the icon is `aria-hidden` (decorative). */
  title?: string;
}

/**
 * Base SVG wrapper for every icon. Inherits `currentColor` (so icon color = text
 * color), sizes to the font by default, and handles the decorative-vs-labelled a11y
 * split. Individual icons render their paths as children through `<IconBase>`.
 */
export function IconBase({ size = "1em", title, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}
