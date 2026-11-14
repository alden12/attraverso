/**
 * The calendar (`CAL-3`): the same items as the graph, laid out by date instead of by dependency. A second lens
 * on one dataset rather than a second application, so it takes whatever the toolbar's filters left visible
 * and selecting an item opens the same detail pane.
 *
 * FullCalendar draws the month grid, and only that: everything about which items appear and what they look
 * like is decided here. Version 6, deliberately - 7 had just shipped, on a Temporal polyfill, when this was
 * written, and a month grid is not a reason to be an early adopter.
 */
import { useEffect, useRef } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import type { EventClickArg, EventContentArg, EventInput } from "@fullcalendar/core";
import { STATUSES, type RoadmapItem } from "../scripts/tickets";
import { spanBy, type CalendarDates } from "./calendarDates";

/** One item to place, with the project it came from, since the calendar can show several at once. */
export interface CalendarEntry {
  project: string;
  item: RoadmapItem;
  colour: string;
  /** Across projects, the project's own colour, drawn as a stripe down the item's left edge. */
  projectColour?: string;
}

/** One project in the key under a calendar showing several, which also shows and hides it. */
export interface CalendarProject {
  key: string;
  name: string;
  colour: string;
  hidden: boolean;
  toggle: () => void;
}

interface Props {
  entries: CalendarEntry[];
  /** Whether entries come from more than one project, in which case each is labelled with its project. */
  multiProject: boolean;
  selected: { project: string; ref: string } | null;
  onSelect: (project: string, ref: string) => void;
  /** A day to go to, when an item is shown here from its menu; a new object each time it is asked. */
  focus?: { date: string; nonce: number } | null;
  /** Which dates place the items: planned (the default), or the day each was filed or last changed. */
  dates?: CalendarDates;
  onDates?: (dates: CalendarDates) => void;
  /** The agreed order's button beside "today": its count, whether its pane is open, and what a click does. Absent
   *  when there is no order to show. The calendar has no floating buttons, so this is its way to the list. */
  nextList?: { count: number; open: boolean; toggle: () => void };
  /** The key of projects, when the calendar shows more than one. */
  projects?: CalendarProject[];
}

const DATE_CHOICES: { key: CalendarDates; text: string; hint: string }[] = [
  { key: "planned", text: "planned", hint: "Place items on their start and due dates" },
  { key: "created", text: "created", hint: "Place items on the day they were filed" },
  { key: "updated", text: "modified", hint: "Place items on the day they last changed" },
];

export function Calendar({ entries, multiProject, selected, onSelect, focus = null, dates = "planned", onDates, nextList, projects }: Props) {
  const calendar = useRef<FullCalendar>(null);
  useEffect(() => {
    if (focus !== null) calendar.current?.getApi().gotoDate(focus.date);
  }, [focus]);
  const events: EventInput[] = entries.flatMap(({ project, item, colour, projectColour }) => {
    const span = spanBy(item, dates);
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
        extendedProps: { project, item, projectColour },
      },
    ];
  });

  const isSelected = (project: string, ref: string) => selected?.project === project && selected.ref === ref;

  // Drawn by hand rather than as FullCalendar's default text: the status glyph and the ref are how an item is
  // recognised everywhere else in the viewer, and a done item is struck through here as it is on the graph.
  const renderEvent = ({ event }: EventContentArg) => {
    const { project, item, projectColour } = event.extendedProps as { project: string; item: RoadmapItem; projectColour?: string };
    const status = STATUSES[item.status];
    return (
      <div
        className="cal__event"
        data-project={projectColour !== undefined}
        style={projectColour === undefined ? undefined : ({ "--project": projectColour } as React.CSSProperties)} data-strike={status.strike} data-on={isSelected(project, item.id)} title={`${item.id} [${status.label}] ${item.title}`}>
        {/* The glyph in its status colour, on a dark disc so it reads on any area's colour behind it. */}
        <span className="cal__icon" style={{ color: status.colour }}>
          {status.icon}
        </span>
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
    // `data-dates` lights the chosen button by CSS: the calendar redraws its own toolbar as you page through months,
    // so a class set on the button from here would not survive the next one.
    <div className="cal" data-dates={dates} data-next-open={nextList?.open === true}>
      <div className="cal__grid">
      <FullCalendar
        ref={calendar}
        initialDate={focus?.date}
        plugins={[dayGridPlugin]}
        initialView="dayGridMonth"
        headerToolbar={{
          left: nextList === undefined ? "prev,next today" : "prev,next today nextList",
          center: "title",
          right: onDates === undefined ? "dayGridMonth,dayGridWeek,dayGridDay" : "planned,created,updated dayGridMonth,dayGridWeek,dayGridDay",
        }}
        customButtons={{
          ...Object.fromEntries(DATE_CHOICES.map(({ key, text, hint }) => [key, { text, hint, click: () => onDates?.(key) }])),
          ...(nextList === undefined
            ? {}
            : { nextList: { text: `Next ${nextList.count}`, hint: "The order agreed with set_next", click: nextList.toggle } }),
        }}
        // A day on its own (the "day" button, or a day's "+3 more"): every item at full height with its whole title,
        // for the days too full to read in a week.
        views={{ dayGridDay: { dayMaxEvents: false } }}
        moreLinkClick="dayGridDay"
        // A day's number (and a week's column head) is a link to that day on its own.
        navLinks
        navLinkDayClick="dayGridDay"
        buttonText={{ today: "today", month: "month", week: "week", day: "day" }}
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
      {/* Which colour is which project, and a click shows or hides it: the stripe down each item's left edge. */}
      {projects !== undefined && (
        <div className="cal__key" role="group" aria-label="Projects">
          {projects.map((p) => (
            <button
              key={p.key}
              className="chip"
              data-off={p.hidden}
              aria-pressed={!p.hidden}
              title={p.hidden ? `Show ${p.name}` : `Hide ${p.name}`}
              style={{ "--area": p.colour } as React.CSSProperties}
              onClick={p.toggle}
            >
              <span className="chip__dot" />
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
