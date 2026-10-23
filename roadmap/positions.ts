import type { XYPosition } from "@xyflow/react";

/** Manual layout (node positions + resized box sizes) persists in localStorage keyed by node id (stable
 *  ticket ids / `area:*`), so a layout you arrange by hand survives reload and doc regeneration. New/renamed
 *  ids just fall back to the auto-layout.
 *
 *  Scoped per project since VIEW-4: a node id is a ticket ref, which is unique only *within* a project, so two
 *  projects that both have an `MCP-1` would otherwise share its position and drag each other around. The `v2`
 *  bump is that scoping - a layout arranged before it falls back to the auto-layout once, which is cheap and
 *  self-correcting, unlike silently mixing two projects' layouts together. */
const POSITIONS_KEY = "roadmap.positions.v2";
const SIZES_KEY = "roadmap.sizes.v2";

const scoped = (key: string, project: string): string => `${key}:${project}`;

export interface BoxSize {
  width: number;
  height: number;
}

function load<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function save<T>(key: string, value: Record<string, T>): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota / unavailable storage - manual layout is a convenience, not essential state
  }
}

export const loadPositions = (project: string): Record<string, XYPosition> =>
  load<XYPosition>(scoped(POSITIONS_KEY, project));
export const savePositions = (project: string, positions: Record<string, XYPosition>): void =>
  save(scoped(POSITIONS_KEY, project), positions);

export const loadSizes = (project: string): Record<string, BoxSize> => load<BoxSize>(scoped(SIZES_KEY, project));
export const saveSizes = (project: string, sizes: Record<string, BoxSize>): void =>
  save(scoped(SIZES_KEY, project), sizes);

export function clearLayout(project: string): void {
  try {
    localStorage.removeItem(scoped(POSITIONS_KEY, project));
    localStorage.removeItem(scoped(SIZES_KEY, project));
  } catch {
    // ignore
  }
}
