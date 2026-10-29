/**
 * The calendar (`CAL-3`): the same items as the graph, laid out by date instead of by dependency. A second lens
 * on one dataset rather than a second application, so it takes whatever the toolbar's filters left visible
 * and selecting an item opens the same detail pane.
 *
 * FullCalendar draws the month grid, and only that: everything about which items appear and what they look
 * like is decided here. Version 6, deliberately - 7 had just shipped, on a Temporal polyfill, when this was
 * written, and a month grid is not a reason to be an early adopter.
 */
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import type { EventClickArg, EventContentArg, EventInput } from "@fullcalendar/core";
import { STATUSES, type RoadmapItem } from "../scripts/tickets";
import { spanOf } from "./calendarDates";

/** One item to place, with the project it came from, since the calendar can show several at once. */
export interface CalendarEntry {
  project: string;
  item: RoadmapItem;
  colour: string;
}

interface Props {
  entries: CalendarEntry[];
  /** Whether entries come from more than one project, in which case each is labelled with its project. */
  multiProject: boolean;
  selected: { project: string; ref: string } | null;
  onSelect: (project: string, ref: string) => void;
}

export function Calendar({ entries, multiProject, selected, onSelect }: Props) {
  const events: EventInput[] = entries.flatMap(({ project, item, colour }) => {
    const span = spanOf(item);
    if (span === null) return [];
    return [
      {
        // Scoped by project, because a ref is unique only within one and two projects can both have a CAL-1.
        id: `${project}:${item.id}`,
        title: item.title,
        start: span.start,
        end: span.end,
        allDay: true,
        backgroundColor: colour,
        borderColor: colour,
        extendedProps: { project, item },
      },
    ];
  });

  const isSelected = (project: string, ref: string) => selected?.project === project && selected.ref === ref;

  // Drawn by hand rather than as FullCalendar's default text: the status glyph and the ref are how an item is
  // recognised everywhere else in the viewer, and a done item is struck through here as it is on the graph.
  const renderEvent = ({ event }: EventContentArg) => {
    const { project, item } = event.extendedProps as { project: string; item: RoadmapItem };
    const status = STATUSES[item.status];
    return (
      <div className="cal__event" data-strike={status.strike} data-on={isSelected(project, item.id)} title={`${item.id} [${status.label}] ${item.title}`}>
        <span className="cal__icon">{status.icon}</span>
        <span className="cal__ref">{multiProject ? `${project}:${item.id}` : item.id}</span>
        <span className="cal__title">{item.title}</span>
      </div>
    );
  };

  const onEventClick = ({ event, jsEvent }: EventClickArg) => {
    jsEvent.preventDefault();
    const { project, item } = event.extendedProps as { project: string; item: RoadmapItem };
    onSelect(project, item.id);
  };

  return (
    <div className="cal">
      <FullCalendar
        plugins={[dayGridPlugin]}
        initialView="dayGridMonth"
        headerToolbar={{ left: "prev,next today", center: "title", right: "dayGridMonth,dayGridWeek" }}
        buttonText={{ today: "today", month: "month", week: "week" }}
        // A day is a day (`CAL-1`): in local time, an all-day span starting at UTC midnight can begin on the
        // previous evening's cell for anyone west of Greenwich.
        timeZone="UTC"
        firstDay={1}
        height="100%"
        events={events}
        eventContent={renderEvent}
        eventClick={onEventClick}
        dayMaxEvents
      />
    </div>
  );
}
