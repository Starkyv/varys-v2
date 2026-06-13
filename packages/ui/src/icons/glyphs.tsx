import { IconBase, type IconProps } from "./Icon";

/**
 * The Nexus line-glyph icon set — 24×24, `currentColor`, sized to `1em` by default
 * (so an icon inherits the text color and font-size of its slot). Stroke icons use
 * the IconBase defaults; filled icons override `fill`/`stroke` via props.
 *
 * Ported from the Varys design prototype. Every icon is a thin wrapper over
 * `IconBase`, so they all honor the `size` and `title` (a11y) props uniformly.
 */

// ---- Navigation / chrome ----------------------------------------------------

export const Dashboard = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </IconBase>
);

export const Flask = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M9 3h6M10 3v5l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" />
    <path d="M7 14h10" />
  </IconBase>
);

export const Squares = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </IconBase>
);

export const Activity = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M3 12h4l3 8 4-16 3 8h4" />
  </IconBase>
);

export const ListRun = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M4 6h16M4 12h16M4 18h10" />
    <circle cx="19" cy="18" r="2" />
  </IconBase>
);

export const Eye = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </IconBase>
);

export const Database = (p: IconProps) => (
  <IconBase {...p}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
    <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
  </IconBase>
);

export const Menu = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </IconBase>
);

export const Search = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </IconBase>
);

export const Bell = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </IconBase>
);

// ---- Actions / status -------------------------------------------------------

export const Play = (p: IconProps) => (
  <IconBase fill="currentColor" stroke="none" {...p}>
    <path d="M7 5v14l12-7z" />
  </IconBase>
);

export const Grid = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
  </IconBase>
);

export const TrendingUp = (p: IconProps) => (
  <IconBase {...p}>
    <path d="m3 17 6-6 4 4 8-8" />
    <path d="M17 7h4v4" />
  </IconBase>
);

export const Check = (p: IconProps) => (
  <IconBase strokeWidth={2.2} {...p}>
    <path d="m5 12 5 5L20 7" />
  </IconBase>
);

export const X = (p: IconProps) => (
  <IconBase strokeWidth={2.2} {...p}>
    <path d="M6 6 18 18M18 6 6 18" />
  </IconBase>
);

export const Dot = (p: IconProps) => (
  <IconBase fill="currentColor" stroke="none" {...p}>
    <circle cx="12" cy="12" r="4" />
  </IconBase>
);

export const Dash = (p: IconProps) => (
  <IconBase strokeWidth={2.4} {...p}>
    <path d="M6 12h12" />
  </IconBase>
);

export const Clock = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </IconBase>
);

export const AlertTriangle = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4M12 17h.01" />
  </IconBase>
);

// ---- Organization -----------------------------------------------------------

export const Folder = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </IconBase>
);

export const Tag = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M3 7v5l9 9 7-7-9-9H4Z" />
    <circle cx="7.5" cy="7.5" r="1.4" />
  </IconBase>
);

export const Grip = (p: IconProps) => (
  <IconBase fill="currentColor" stroke="none" {...p}>
    <circle cx="9" cy="6" r="1.6" />
    <circle cx="15" cy="6" r="1.6" />
    <circle cx="9" cy="12" r="1.6" />
    <circle cx="15" cy="12" r="1.6" />
    <circle cx="9" cy="18" r="1.6" />
    <circle cx="15" cy="18" r="1.6" />
  </IconBase>
);

export const Plus = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M12 5v14M5 12h14" />
  </IconBase>
);

export const Lock = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </IconBase>
);

export const Inbox = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M3 12h5l2 3h4l2-3h5" />
    <path d="M5 5h14l2 7v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6Z" />
  </IconBase>
);

export const Pencil = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2 2 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </IconBase>
);

export const Trash = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14" />
  </IconBase>
);

export const MoreHorizontal = (p: IconProps) => (
  <IconBase fill="currentColor" stroke="none" {...p}>
    <circle cx="5" cy="12" r="2" />
    <circle cx="12" cy="12" r="2" />
    <circle cx="19" cy="12" r="2" />
  </IconBase>
);

export const ExternalLink = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  </IconBase>
);

// ---- Diff viewer ------------------------------------------------------------

export const Layers = (p: IconProps) => (
  <IconBase {...p}>
    <path d="m12 3 9 5-9 5-9-5Z" />
    <path d="m3 13 9 5 9-5" />
  </IconBase>
);

export const Sliders = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="8" cy="12" r="2" />
    <circle cx="18" cy="18" r="2" />
  </IconBase>
);

export const Timeline = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M5 4v16" />
    <circle cx="5" cy="8" r="2" />
    <circle cx="5" cy="16" r="2" />
    <path d="M9 8h11M9 16h11" />
  </IconBase>
);

export const Columns = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="3" y="4" width="8" height="16" rx="1.5" />
    <rect x="13" y="4" width="8" height="16" rx="1.5" />
  </IconBase>
);

export const SwipeView = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
    <path d="M12 4v16M9 9l-3 3 3 3M15 9l3 3-3 3" />
  </IconBase>
);

export const OnionSkin = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="9" cy="9" r="6" />
    <circle cx="15" cy="15" r="6" />
  </IconBase>
);

export const ArrowLeft = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </IconBase>
);
