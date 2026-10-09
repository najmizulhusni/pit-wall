/*
  Calendar export. Builds an iCalendar (RFC 5545) file from the schedule, entirely in the browser,
  so a fan anywhere gets every session in their own calendar, in their own time zone.
  Stable UIDs mean importing again updates events instead of duplicating them.
*/
(function (root) {
  "use strict";
  // Minutes each session occupies in a calendar. Races are scheduled for two hours.
  const LEN = { "Practice 1": 60, "Practice 2": 60, "Practice 3": 60, "Sprint qualifying": 45, Sprint: 60, Qualifying: 60, Race: 120 };

  const stamp = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const text = s => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  // Long lines are folded: CRLF plus one space, at most 75 characters per physical line.
  const fold = line => {
    const out = [];
    let rest = line;
    while (rest.length > 75) { out.push(rest.slice(0, 75)); rest = " " + rest.slice(75); }
    out.push(rest);
    return out.join("\r\n");
  };
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  /* races: schedule entries with { season, round, name, circuit, locality, sessions: [[name, Date], ...] } */
  function build(races, { now = new Date(), from = 0, alarmMinutes = 15 } = {}) {
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Pit Wall//Formula 1 sessions//EN",
      "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Formula 1"
    ];
    let count = 0;
    races.forEach(r => r.sessions.forEach(([name, start]) => {
      if (typeof start?.getTime !== "function" || start.getTime() < from) return;
      const end = new Date(start.getTime() + (LEN[name] || 60) * 60000);
      lines.push(
        "BEGIN:VEVENT",
        `UID:${r.season}-r${r.round}-${slug(name)}@pitwall`,
        `DTSTAMP:${stamp(now)}`,
        `DTSTART:${stamp(start)}`,
        `DTEND:${stamp(end)}`,
        fold(`SUMMARY:${text(`F1 ${r.name}: ${name}`)}`),
        fold(`LOCATION:${text(`${r.circuit}, ${r.locality}`)}`),
        fold(`DESCRIPTION:${text(`Round ${r.round} of the ${r.season} season.`)}`),
        "BEGIN:VALARM", "ACTION:DISPLAY", fold(`DESCRIPTION:${text(`${name} starts soon`)}`), `TRIGGER:-PT${alarmMinutes}M`, "END:VALARM",
        "END:VEVENT"
      );
      count++;
    }));
    lines.push("END:VCALENDAR");
    return { text: lines.join("\r\n") + "\r\n", count };
  }

  function download(filename, body) {
    const url = URL.createObjectURL(new Blob([body], { type: "text/calendar;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  root.ICS = { build, download, LEN };
})(typeof window !== "undefined" ? window : globalThis);
