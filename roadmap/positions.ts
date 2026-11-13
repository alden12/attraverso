import type { LayoutMemory } from "./graph";

/** The layout's memory and hand-resized box sizes persist in localStorage keyed by node id (stable ticket ids /
 *  `area:*`), so the map - including anything arranged by hand - survives reload and doc regeneration. New or
 *  renamed ids are placed by the layout as newcomers.
 *
 *  Scoped per project since VIEW-4: a node id is a ticket ref, which is unique only *within* a project, so two
 *  projects that both have an `MCP-1` would otherwise share its position and drag each other around. The `v2`
 *  bump is that scoping - a layout arranged before it falls back to the auto-layout once, which is cheap and
 *  self-correcting, unlike silently mixing two projects' layouts together. */
const POSITIONS_KEY = "roadmap.positions.v2";
/** The layout's memory (`VIEW-23.1`): every node's last position, which replaced remembering only dragged ones.
 *  A layout arranged under `POSITIONS_KEY` is not carried over: it starts afresh once, and the old key is still
 *  cleared by a reset so it does not linger. */
const MEMORY_KEY = "roadmap.layout.v1";
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

export const loadMemory = (project: string): LayoutMemory => load<{ x: number; y: number }>(scoped(MEMORY_KEY, project));
export const saveMemory = (project: string, memory: LayoutMemory): void => save(scoped(MEMORY_KEY, project), memory);

export const loadSizes = (project: string): Record<string, BoxSize> => load<BoxSize>(scoped(SIZES_KEY, project));
export const saveSizes = (project: string, sizes: Record<string, BoxSize>): void =>
  save(scoped(SIZES_KEY, project), sizes);

export function clearLayout(project: string): void {
  try {
    localStorage.removeItem(scoped(MEMORY_KEY, project));
    localStorage.removeItem(scoped(POSITIONS_KEY, project));
    localStorage.removeItem(scoped(SIZES_KEY, project));
  } catch {
    // ignore
  }
}
