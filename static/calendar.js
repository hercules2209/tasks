/* global document, FullCalendar, fetch, window */
function addOneDay(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
function statusColor(status) {
  if (status === "done") return "#89dd13";
  if (status === "in_progress") return "#7aa2f7";
  if (status === "blocked") return "#f7768e";
  return "#9aa3b2";
}

document.addEventListener("DOMContentLoaded", async () => {
  const el = document.getElementById("fc");
  const cal = new FullCalendar.Calendar(el, {
    initialView: "dayGridMonth",
    height: "auto",
    headerToolbar: {
      left: "prev,next today",
      center: "title",
      right: "dayGridMonth",
    },
    buttonText: {
      today: "today",
      month: "month",
      prev: "‹",
      next: "›",
    },
    eventClick(info) {
      info.jsEvent.preventDefault();
      window.location.href = `/tasks/${info.event.id}`;
    },
    eventContent(arg) {
      const s = arg.event.extendedProps.status || "todo";
      const dot = `<span class="cal-dot" style="background:${statusColor(s)}"></span>`;
      const title = `<span class="cal-title">${arg.event.title}</span>`;
      return { html: `${dot}${title}` };
    },
  });

  const r = await fetch("/api/tasks");
  const j = await r.json();
  const evs = (j.tasks || []).map((t) => {
    const title = `W${t.week || "?"}: ${t.title}`;
    return {
      id: String(t.id),
      title,
      start: t.start_date || t.started_at || undefined,
      end: addOneDay(t.end_date || t.completed_at || t.start_date),
      color: "#0f131a",
      textColor: "#cbd5e1",
      borderColor: "#2a2f3e",
      extendedProps: { status: t.status },
    };
  });

  cal.addEventSource(evs);
  cal.render();
});
