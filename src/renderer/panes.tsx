import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import {
  DEFAULT_INSPECTOR_PANE_WIDTH,
  DEFAULT_NAVIGATION_PANE_WIDTH,
  MAXIMUM_INSPECTOR_PANE_WIDTH,
  MAXIMUM_NAVIGATION_PANE_WIDTH,
  MINIMUM_INSPECTOR_PANE_WIDTH,
  MINIMUM_NAVIGATION_PANE_WIDTH,
  MINIMUM_PRIMARY_PANE_WIDTH,
} from "../shared/preferences";

export type PaneName = "navigation" | "inspector";
export type PaneWidths = Record<PaneName, number>;
export type PaneShellStyle = CSSProperties & {
  "--navigation-pane-width": string;
  "--inspector-pane-width": string;
  "--primary-pane-min-width": string;
};

export const COMPACT_LAYOUT_MEDIA = "(max-width: 1080px)";

export const DEFAULT_PANE_WIDTHS: PaneWidths = {
  navigation: DEFAULT_NAVIGATION_PANE_WIDTH,
  inspector: DEFAULT_INSPECTOR_PANE_WIDTH,
};

const PANE_DIVIDER_INSTRUCTIONS = "Drag to resize; double-click or press Enter to reset.";
const panePresentation = {
  navigation: { label: "Navigation", physicalDirection: 1 },
  inspector: { label: "Inspector", physicalDirection: -1 },
} as const;

function clampPaneWidth(width: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Math.round(width)));
}

export function constrainedPaneWidths(shellWidth: number, preferred: PaneWidths): PaneWidths {
  let navigation = clampPaneWidth(preferred.navigation, MINIMUM_NAVIGATION_PANE_WIDTH, MAXIMUM_NAVIGATION_PANE_WIDTH);
  let inspector = clampPaneWidth(preferred.inspector, MINIMUM_INSPECTOR_PANE_WIDTH, MAXIMUM_INSPECTOR_PANE_WIDTH);
  let excess = Math.max(0, navigation + inspector + MINIMUM_PRIMARY_PANE_WIDTH - shellWidth);
  const inspectorReduction = Math.min(excess, inspector - MINIMUM_INSPECTOR_PANE_WIDTH);
  inspector -= inspectorReduction;
  excess -= inspectorReduction;
  navigation -= Math.min(excess, navigation - MINIMUM_NAVIGATION_PANE_WIDTH);
  return { navigation, inspector };
}

type PaneDividerProps = {
  pane: PaneName;
  controls: string;
  width: number;
  preferredWidth: number;
  defaultWidth: number;
  minimum: number;
  maximum: number;
  enabled: boolean;
  onPreview(width: number): void;
  onCommit(width: number): void;
};

type PaneDrag = {
  pointerId: number;
  startX: number;
  startWidth: number;
  preferredWidth: number;
  currentWidth: number;
};

export function PaneDivider({ pane, controls, width, preferredWidth, defaultWidth, minimum, maximum, enabled, onPreview, onCommit }: PaneDividerProps) {
  const descriptionId = useId();
  const divider = useRef<HTMLDivElement>(null);
  const drag = useRef<PaneDrag | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [tooltipDismissed, setTooltipDismissed] = useState(false);
  const [tooltipHovered, setTooltipHovered] = useState(false);
  const [tooltipFocused, setTooltipFocused] = useState(false);
  const { label, physicalDirection } = panePresentation[pane];
  const endDrag = (commit: boolean, element = divider.current) => {
    const active = drag.current;
    if (!active) return;
    drag.current = undefined;
    if (commit && active.currentWidth !== active.startWidth) onCommit(active.currentWidth);
    else onPreview(active.preferredWidth);
    setDragging(false);
    document.body.classList.remove("pane-resizing");
    if (element?.hasPointerCapture(active.pointerId)) element.releasePointerCapture(active.pointerId);
  };
  useEffect(() => {
    const media = matchMedia(COMPACT_LAYOUT_MEDIA);
    const cancelWhenCompact = () => {
      if (!media.matches) return;
      endDrag(false);
      if (document.activeElement === divider.current) document.getElementById("content")?.focus();
    };
    cancelWhenCompact();
    media.addEventListener("change", cancelWhenCompact);
    return () => {
      media.removeEventListener("change", cancelWhenCompact);
      document.body.classList.remove("pane-resizing");
    };
  }, []);
  useEffect(() => {
    if (!enabled) {
      endDrag(false);
      if (document.activeElement === divider.current) document.getElementById("content")?.focus();
    }
  }, [enabled]);
  useEffect(() => {
    if (!tooltipHovered && !tooltipFocused) setTooltipDismissed(false);
  }, [tooltipFocused, tooltipHovered]);
  useEffect(() => {
    if (!tooltipHovered && !tooltipFocused) return;
    const dismissTooltip = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setTooltipDismissed(true);
    };
    window.addEventListener("keydown", dismissTooltip);
    return () => window.removeEventListener("keydown", dismissTooltip);
  }, [tooltipFocused, tooltipHovered]);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && drag.current) {
      event.preventDefault();
      endDrag(false, event.currentTarget);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onPreview(defaultWidth);
      onCommit(defaultWidth);
      return;
    }
    let next: number | undefined;
    if (event.key === "Home") next = physicalDirection > 0 ? minimum : maximum;
    else if (event.key === "End") next = physicalDirection > 0 ? maximum : minimum;
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const physicalDelta = (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 50 : 10);
      next = width + physicalDelta * physicalDirection;
    }
    if (next === undefined) return;
    event.preventDefault();
    const resized = clampPaneWidth(next, minimum, maximum);
    if (resized === width) return;
    onPreview(resized);
    onCommit(resized);
  };
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!enabled || event.button !== 0 || !event.isPrimary || event.target !== event.currentTarget) return;
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
      preferredWidth,
      currentWidth: width,
    };
    setDragging(true);
    document.body.classList.add("pane-resizing");
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const resized = clampPaneWidth(
      active.startWidth + (event.clientX - active.startX) * physicalDirection,
      minimum,
      maximum,
    );
    active.currentWidth = resized;
    onPreview(resized);
  };
  const reset = () => {
    onPreview(defaultWidth);
    onCommit(defaultWidth);
  };
  return <div
    ref={divider}
    className={`pane-divider pane-divider-${pane}${dragging ? " is-active" : ""}${tooltipDismissed ? " tooltip-dismissed" : ""}`}
    role="separator"
    aria-label={`Resize ${label}`}
    aria-controls={controls}
    aria-describedby={descriptionId}
    aria-orientation="vertical"
    aria-valuemin={minimum}
    aria-valuemax={maximum}
    aria-valuenow={width}
    aria-valuetext={`${width} pixels`}
    tabIndex={enabled ? 0 : -1}
    onDoubleClick={(event) => { if (event.target === event.currentTarget) reset(); }}
    onKeyDown={handleKeyDown}
    onMouseEnter={() => setTooltipHovered(true)}
    onMouseLeave={() => setTooltipHovered(false)}
    onFocus={() => setTooltipFocused(true)}
    onBlur={() => setTooltipFocused(false)}
    onPointerDown={handlePointerDown}
    onPointerMove={handlePointerMove}
    onPointerUp={(event) => endDrag(enabled && !matchMedia(COMPACT_LAYOUT_MEDIA).matches, event.currentTarget)}
    onPointerCancel={(event) => endDrag(false, event.currentTarget)}
    onLostPointerCapture={() => endDrag(false)}
  >
    <span className="pane-divider-tooltip" aria-hidden="true">{PANE_DIVIDER_INSTRUCTIONS}</span>
    <span id={descriptionId} className="visually-hidden">{PANE_DIVIDER_INSTRUCTIONS}</span>
  </div>;
}
