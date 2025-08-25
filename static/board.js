/* global document, window, fetch */
const csrf = document
  .querySelector('meta[name="csrf-token"]')
  .getAttribute("content");

let TASKS_CACHE = null;
async function getTasksCache() {
  if (TASKS_CACHE) return TASKS_CACHE;
  const r = await fetch("/api/tasks");
  const j = await r.json();
  TASKS_CACHE = j.tasks || [];
  return TASKS_CACHE;
}

function postJSON(url, body) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
    },
    body: JSON.stringify(body || {}),
  }).then(async (r) => {
    if (!r.ok) {
      const msg = await r.text();
      throw new Error(msg || r.statusText);
    }
    return r.json();
  });
}

function parseIdList(text) {
  if (!text) return [];
  return text
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

document.addEventListener("DOMContentLoaded", () => {
  const modal = document.getElementById("create-modal");
  const cancelBtn = document.getElementById("cancel-create");
  const createForm = document.getElementById("create-task-form");
  const plusFab = document.getElementById("plus-fab");
  const modalClose = document.getElementById("modal-close");
  if (plusFab) plusFab.addEventListener("click", () => modal.showModal());
  if (cancelBtn) cancelBtn.addEventListener("click", () => modal.close());
  if (modalClose) modalClose.addEventListener("click", () => modal.close());

  if (createForm) {
    createForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(createForm);
      const title = String(fd.get("title") || "").trim();
      let week = Number(fd.get("week") || 0);
      const priority = Number(fd.get("priority") || 2);
      const description = String(fd.get("description") || "");
      const subtasksRaw = String(fd.get("subtasks") || "");
      const depIds = parseIdList(String(fd.get("depends_on") || ""));
      if (!title) {
        alert("Title is required");
        return;
      }
      try {
        // Week must be > max(dep.week)
        if (depIds.length) {
          const tasks = await getTasksCache();
          const depWeeks = depIds
            .map((id) => tasks.find((t) => t.id === id))
            .filter(Boolean)
            .map((t) => Number(t.week || 0));
          const minWeek = (Math.max(0, ...depWeeks) || 0) + 1;
          if (!week || week < minWeek) week = minWeek;
        }

        const res = await postJSON("/api/tasks", {
          title,
          week,
          priority,
          description,
        });
        const taskId = res.task.id;

        // Subtasks
        const lines = subtasksRaw
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const line of lines) {
          // eslint-disable-next-line no-await-in-loop
          await postJSON("/api/subtasks", { task_id: taskId, title: line });
        }

        // Dependencies
        for (const dep of depIds) {
          // eslint-disable-next-line no-await-in-loop
          await postJSON("/api/dependencies", {
            task_id: taskId,
            depends_on_id: dep,
          });
        }

        modal.close();
        window.location.reload();
      } catch (err) {
        alert("Create failed: " + err.message);
      }
    });
  }

  // Board interactions (same as before, trimmed) ...
  const board = document.getElementById("board");
  if (!board) return;

  board.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action='toggle-task-status']");
    if (!btn) return;
    const card = btn.closest(".card");
    const id = Number(card.dataset.taskId);
    const isDone = card.classList.contains("done");
    if (card.classList.contains("blocked") && !isDone) {
      alert("Task is blocked by dependencies. Complete prerequisites first.");
      return;
    }
    const newStatus = isDone ? "todo" : "done";
    try {
      const res = await postJSON(`/api/tasks/${id}/status`, {
        status: newStatus,
      });
      card.classList.remove("todo", "in_progress", "done", "blocked");
      card.classList.add(res.task.status);
      btn.textContent = res.task.status === "done" ? "✓" : " ";
      const badge = card.querySelector(".badge.status");
      if (badge) {
        badge.textContent = res.task.status;
        badge.className = "badge status " + res.task.status;
      }
      const bar = card.querySelector(".progress .bar");
      if (bar && res.task)
        bar.style.width = `${Math.round(res.task.progress)}%`;
      card
        .querySelectorAll(
          'input[type="checkbox"][data-action="toggle-subtask"]',
        )
        .forEach((chk) => {
          // eslint-disable-next-line no-param-reassign
          chk.disabled = res.task.status === "blocked";
        });
    } catch (err) {
      alert("Update failed: " + err.message);
    }
  });

  board.addEventListener("change", async (e) => {
    const box = e.target.closest(
      'input[type="checkbox"][data-action="toggle-subtask"]',
    );
    if (!box || box.disabled) return;
    const li = box.closest("li[data-subtask-id]");
    const subtaskId = Number(li.dataset.subtaskId);
    try {
      const res = await postJSON(`/api/subtasks/${subtaskId}/toggle`);
      const card = box.closest(".card");
      if (card && res.task) {
        card.classList.remove("todo", "in_progress", "done", "blocked");
        card.classList.add(res.task.status);
        const badge = card.querySelector(".badge.status");
        if (badge) {
          badge.textContent = res.task.status;
          badge.className = "badge status " + res.task.status;
        }
        const bar = card.querySelector(".progress .bar");
        if (bar) bar.style.width = `${Math.round(res.task.progress)}%`;
      }
    } catch (err) {
      alert("Toggle failed: " + err.message);
      box.checked = !box.checked;
    }
  });

  board.addEventListener("click", async (e) => {
    const delBtn = e.target.closest("[data-action='delete-subtask']");
    if (!delBtn) return;
    const li = delBtn.closest("li[data-subtask-id]");
    const subtaskId = Number(li.dataset.subtaskId);
    try {
      await postJSON(`/api/subtasks/${subtaskId}/delete`);
      window.location.reload();
    } catch (err) {
      alert("Delete subtask failed: " + err.message);
    }
  });

  board.addEventListener("keydown", async (e) => {
    const input = e.target.closest("input[data-action='new-subtask-input']");
    if (!input || input.disabled) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const card = input.closest(".card");
      const id = Number(card.dataset.taskId);
      const title = input.value.trim();
      if (!title) return;
      try {
        await postJSON("/api/subtasks", { task_id: id, title });
        window.location.reload();
      } catch (err) {
        alert("Add subtask failed: " + err.message);
      }
    }
  });
});
