import { useEffect } from "react";
import { useStore } from "@xyflow/react";

/**
 * How far out the graph is, as `--far` on the canvas from 0 (cards readable) to 1 (they are specks), for the
 * fade from an area's cards to its overview (`VIEW-52`). `data-far` marks the far half, where the cards stop
 * taking clicks so a click lands on the area.
 *
 * Written straight onto the element rather than through React state: zooming changes it every frame, and as
 * state it would re-render every node each time, where as a variable only the browser repaints.
 *
 * The band is where a card's 13px title goes from small to unreadable: at 0.6 it is about 8px on screen, at 0.4
 * about 5px. Above it nothing changes; below it the map is areas.
 */
export const FADE_FROM = 0.6;
export const FADE_TO = 0.4;

export function ZoomFade() {
  const zoom = useStore((state) => state.transform[2]);
  const canvas = useStore((state) => state.domNode);
  useEffect(() => {
    if (canvas === null) return;
    const far = Math.min(Math.max((FADE_FROM - zoom) / (FADE_FROM - FADE_TO), 0), 1);
    canvas.style.setProperty("--far", far.toFixed(3));
    canvas.dataset.far = String(far > 0.5);
  }, [zoom, canvas]);
  return null;
}
