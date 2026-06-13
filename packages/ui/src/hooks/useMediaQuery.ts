import { useEffect, useState } from "react";
import { breakpoint, type BreakpointToken } from "../tokens/breakpoints";

/**
 * Subscribe to a media query, returning whether it currently matches.
 * Pass a raw query string or a named breakpoint (min-width).
 *
 *   const isDesktop = useMediaQuery("lg");
 *   const isWide = useMediaQuery("(min-width: 1440px)");
 */
export function useMediaQuery(query: BreakpointToken | string): boolean {
  const resolved =
    query in breakpoint ? `(min-width: ${breakpoint[query as BreakpointToken]}px)` : query;

  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(resolved).matches : false,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(resolved);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [resolved]);

  return matches;
}
