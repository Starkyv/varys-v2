import { IconBase, type IconProps } from "./Icon";

/** The negative-delta arrow (↘) from the dashboard stat badges. */
export function ArrowDownRight(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m7 7 10 10" />
      <path d="M17 7v10H7" />
    </IconBase>
  );
}
