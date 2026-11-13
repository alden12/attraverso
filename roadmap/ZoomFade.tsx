import { useEffect, useState } from "react";
import { Panel, useStore } from "@xyflow/react";

/**
 * The fade from an area's cards to its overview as the graph zooms out (`VIEW-52`), as two CSS variables on the
 * canvas: `--cards`, the cards' opacity, and `--overview`, the overview's. `data-far` marks where the cards are
 * mostly gone, which is where they stop taking clicks so a click lands on the area.
 *
 * Written straight onto the element rather than through React state: zooming changes them every frame, and as
 * state they would re-render every node each time, where as variables only the browser repaints.
 *
 * **Two ramps rather than one crossfade.** The cards fade out over one band of zoom and the overview fades in over
 * another, by default one after the other: both at half strength was an unreadable pile of text. The defaults sit
 * where a card's 13px title goes from small to unreadable, about 8px on screen at 0.6 and 5px at 0.4.
 */
export interface FadeBands {
  /** Zoom at which the cards start to fade, and at which they are gone. */
  cardsFrom: number;
  cardsTo: number;
  /** Zoom at which the overview starts to appear, and at which it is fully shown. */
  overviewFrom: number;
  overviewTo: number;
}

export const DEFAULT_BANDS: FadeBands = { cardsFrom: 0.6, cardsTo: 0.5, overviewFrom: 0.5, overviewTo: 0.4 };

const TUNING_KEY = "attraverso.fade.bands";

/** How far into a band `zoom` is, 0 above its start to 1 past its end (zooming out runs from high to low). */
const ramp = (zoom: number, from: number, to: number): number =>
  from === to ? (zoom <= to ? 1 : 0) : Math.min(Math.max((from - zoom) / (from - to), 0), 1);

/**
 * Dev sliders for the bands, to settle the feel by eye: on the dev server, or anywhere with `?tune` in the URL. Kept in this browser between reloads; "copy" puts the values on the clipboard to make them the defaults.
 */
const tuning =
  typeof window !== "undefined" &&
  // Not under an automated browser on the dev server, where the end-to-end suite runs, since it sits over the graph.
  ((import.meta.env.DEV && !navigator.webdriver) || new URLSearchParams(window.location.search).has("tune"));

function savedBands(): FadeBands {
  if (!tuning) return DEFAULT_BANDS;
  try {
    return { ...DEFAULT_BANDS, ...(JSON.parse(window.localStorage.getItem(TUNING_KEY) ?? "{}") as Partial<FadeBands>) };
  } catch {
    return DEFAULT_BANDS;
  }
}

export function ZoomFade() {
  const zoom = useStore((state) => state.transform[2]);
  const canvas = useStore((state) => state.domNode);
  const [bands, setBands] = useState<FadeBands>(savedBands);

  useEffect(() => {
    if (canvas === null) return;
    const cards = 1 - ramp(zoom, bands.cardsFrom, bands.cardsTo);
    canvas.style.setProperty("--cards", cards.toFixed(3));
    canvas.style.setProperty("--overview", ramp(zoom, bands.overviewFrom, bands.overviewTo).toFixed(3));
    canvas.dataset.far = String(cards < 0.5);
  }, [zoom, canvas, bands]);

  if (!tuning) return null;

  const save = (next: FadeBands) => {
    setBands(next);
    try {
      window.localStorage.setItem(TUNING_KEY, JSON.stringify(next));
    } catch {
      // Unsaved: the sliders still work for this page.
    }
  };
  const set = (key: keyof FadeBands, value: number) => save({ ...bands, [key]: value });
  const slider = (key: keyof FadeBands, label: string) => (
    <label className="fade-tuner__row">
      <span>{label}</span>
      <input type="range" min={0.05} max={1.5} step={0.01} value={bands[key]} onChange={(event) => set(key, Number(event.target.value))} />
      <output>{bands[key].toFixed(2)}</output>
    </label>
  );

  return (
    <Panel position="bottom-center" className="fade-tuner">
      <div className="fade-tuner__head">
        <strong>Fade</strong>
        <span>zoom {zoom.toFixed(2)}</span>
      </div>
      {slider("cardsFrom", "cards start")}
      {slider("cardsTo", "cards gone")}
      {slider("overviewFrom", "overview start")}
      {slider("overviewTo", "overview full")}
      <div className="fade-tuner__actions">
        <button onClick={() => void navigator.clipboard.writeText(JSON.stringify(bands))}>copy</button>
        <button onClick={() => save(DEFAULT_BANDS)}>reset</button>
      </div>
    </Panel>
  );
}
