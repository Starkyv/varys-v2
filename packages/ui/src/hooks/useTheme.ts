import { useCallback, useEffect, useState } from "react";
import type { BrandName, ThemeName } from "../types";

/**
 * Read & control the active color theme and brand by setting `data-theme` /
 * `data-brand` on a target element (default: <html>). Theme switching is just an
 * attribute flip — every token re-resolves through CSS custom properties.
 */
export function useTheme(target?: HTMLElement) {
  const getEl = useCallback(
    () => target ?? (typeof document !== "undefined" ? document.documentElement : null),
    [target],
  );

  const [theme, setThemeState] = useState<ThemeName>(() => {
    const el = getEl();
    return (el?.getAttribute("data-theme") as ThemeName) ?? "light";
  });
  const [brand, setBrandState] = useState<BrandName>(() => {
    const el = getEl();
    return (el?.getAttribute("data-brand") as BrandName) ?? "nexus";
  });

  const setTheme = useCallback(
    (next: ThemeName) => {
      getEl()?.setAttribute("data-theme", next);
      setThemeState(next);
    },
    [getEl],
  );

  const setBrand = useCallback(
    (next: BrandName) => {
      const el = getEl();
      if (!el) return;
      // "nexus" is the bare default — clear the attribute rather than setting it.
      if (next === "nexus") el.removeAttribute("data-brand");
      else el.setAttribute("data-brand", next);
      setBrandState(next);
    },
    [getEl],
  );

  const toggleTheme = useCallback(
    () => setTheme(theme === "dark" ? "light" : "dark"),
    [theme, setTheme],
  );

  // Keep state in sync if the attribute is changed elsewhere.
  useEffect(() => {
    const el = getEl();
    if (!el || typeof MutationObserver === "undefined") return;
    const obs = new MutationObserver(() => {
      setThemeState((el.getAttribute("data-theme") as ThemeName) ?? "light");
      setBrandState((el.getAttribute("data-brand") as BrandName) ?? "nexus");
    });
    obs.observe(el, { attributes: true, attributeFilter: ["data-theme", "data-brand"] });
    return () => obs.disconnect();
  }, [getEl]);

  return { theme, setTheme, toggleTheme, brand, setBrand };
}
