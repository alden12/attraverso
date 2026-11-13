import { useEffect } from "react";
import { useStore } from "@xyflow/react";

/**
 * The fade from an area's cards to its overview as the graph zooms out (`VIEW-52`), as two CSS variables on the
 * canvas: `--cards`, the cards' opacity, and `--overview`, the overview's. `data-far` marks where the cards are
 * mostly gone, which is where they stop taking clicks so a click lands on the area.
 *
 * Written straight onto the element rather than through React state: zooming changes them every frame, and as
 * state they would re-render every node each time, where as variables only the browser repaints.
 *
 * **Two bands, so each can be tuned.** The cards fade out over one band of zoom and the overview fades in over
 * another. Set by eye on this repo's plan (2026-11-13), first with dev sliders and then refined by hand: one
 * crossfade from 0.35 to 0.1, which leaves the cards in place past the point their text is legible, since their
 * shapes and edges still say where things are after their words stop, and finishes before the floor at 0.05.
 */
export interface FadeBands {
  /** Zoom at which the cards start to fade, and at which they are gone. */
  cardsFrom: number;
  cardsTo: number;
  /** Zoom at which the overview starts to appear, and at which it is fully shown. */
  overviewFrom: number;
  overviewTo: number;
}

export const FADE_BANDS: FadeBands = { cardsFrom: 0.35, cardsTo: 0.1, overviewFrom: 0.35, overviewTo: 0.1 };

/** How far into a band `zoom` is, 0 above its start to 1 past its end (zooming out runs from high to low). */
const ramp = (zoom: number, from: number, to: number): number =>
  from === to ? (zoom <= to ? 1 : 0) : Math.min(Math.max((from - zoom) / (from - to), 0), 1);

export function ZoomFade() {
  const zoom = useStore((state) => state.transform[2]);
  const canvas = useStore((state) => state.domNode);

  useEffect(() => {
    if (canvas === null) return;
    const cards = 1 - ramp(zoom, FADE_BANDS.cardsFrom, FADE_BANDS.cardsTo);
    canvas.style.setProperty("--cards", cards.toFixed(3));
    canvas.style.setProperty("--overview", ramp(zoom, FADE_BANDS.overviewFrom, FADE_BANDS.overviewTo).toFixed(3));
    canvas.dataset.far = String(cards < 0.5);
  }, [zoom, canvas]);

  return null;
}
