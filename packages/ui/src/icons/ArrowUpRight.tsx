import { IconBase, type IconProps } from "./Icon";

/** The positive-delta arrow (↗) from the dashboard stat badges. */
export function ArrowUpRight(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </IconBase>
  );
}
