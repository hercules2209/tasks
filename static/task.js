/* global document, fetch, window, TomSelect */
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

async function computeMinWeekFromDeps(depIds) {
  const tasks = await getTasksCache();
  const weeks = depIds
    .map((id) => tasks.find((t) => t.id === id))
    .filter(Boolean)
    .map((t) => Number(t.week || 0));
  return (Math.max(0, ...weeks) || 0) + 1;
}

function parseIdList(text) {
  if (!text) return [];
  return text
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

document.addEventListener("DOMContentLoaded", async () => {
  const el = document.querySelector(".task-view");
  const taskId = Number(el.dataset.taskId);
  const weekInput = document.getElementById("task-week");

  async function enforceWeekMin() {
    const existingIds = parseIdList(
      (document.getElementById("existing-dep-ids")?.value || "").toString(),
    );
    const minWeek = await computeMinWeekFromDeps(existingIds);
    if (weekInput) {
      weekInput.min = String(minWeek);
      weekInput.placeholder = `≥ ${minWeek}`;
      if (!weekInput.value || Number(weekInput.value) < minWeek) {
        weekInput.value = String(minWeek);
      }
      weekInput.title = `Week must be after all dependencies (min ${minWeek}).`;
    }
  }
  await enforceWeekMin();

  // Save edits
  document.getElementById("save-task").addEventListener("click", async () => {
    const title = document.getElementById("task-title").textContent.trim();
    const description = document.getElementById("task-desc").value.trim();
    const priority = Number(document.getElementById("task-priority").value);
    let week = Number(weekInput.value || 0);

    // Ensure week obeys min before saving
    const existingIds = parseIdList(
      (document.getElementById("existing-dep-ids")?.value || "").toString(),
    );
    const minWeek = await computeMinWeekFromDeps(existingIds);
    if (!week || week < minWeek) week = minWeek;

    try {
      await postJSON(`/api/tasks/${taskId}/edit`, {
        title,
        description,
        priority,
        week,
      });
      window.location.reload();
    } catch (err) {
      alert("Save failed: " + err.message);
    }
  });

  // Status change
  document
    .getElementById("task-status")
    .addEventListener("change", async (e) => {
      try {
        await postJSON(`/api/tasks/${taskId}/status`, {
          status: e.target.value,
        });
        window.location.reload();
      } catch (err) {
        alert("Status change failed: " + err.message);
        e.target.value = "todo";
      }
    });

  // Toggle subtask
  document.querySelector(".task-view").addEventListener("change", async (e) => {
    const chk = e.target.closest(
      'input[type="checkbox"][data-action="toggle-subtask"]',
    );
    if (!chk || chk.disabled) return;
    const li = chk.closest("li[data-subtask-id]");
    const subtaskId = Number(li.dataset.subtaskId);
    try {
      await postJSON(`/api/subtasks/${subtaskId}/toggle`);
    } catch (err) {
      alert("Toggle failed: " + err.message);
      chk.checked = !chk.checked;
    }
  });

  // Add subtask
  document
    .querySelector(".task-view")
    .addEventListener("keydown", async (e) => {
      const input = e.target.closest('input[data-action="new-subtask-input"]');
      if (!input || input.disabled) return;
      if (e.key === "Enter") {
        e.preventDefault();
        const title = input.value.trim();
        if (!title) return;
        try {
          await postJSON("/api/subtasks", { task_id: taskId, title });
          window.location.reload();
        } catch (err) {
          alert("Add subtask failed: " + err.message);
        }
      }
    });

  // Delete subtask
  document.querySelector(".task-view").addEventListener("click", async (e) => {
    const delBtn = e.target.closest('[data-action="delete-subtask"]');
    if (!delBtn || delBtn.disabled) return;
    const li = delBtn.closest("li[data-subtask-id]");
    const subtaskId = Number(li.dataset.subtaskId);
    try {
      await postJSON(`/api/subtasks/${subtaskId}/delete`);
      window.location.reload();
    } catch (err) {
      alert("Delete subtask failed: " + err.message);
    }
  });

  // Dependency selector (Tom Select)
  try {
    const existing = parseIdList(
      (document.getElementById("existing-dep-ids")?.value || "").toString(),
    );
    const tasks = await getTasksCache();
    const options = tasks
      .filter((t) => t.id !== taskId && !existing.includes(t.id))
      .map((t) => ({
        value: String(t.id),
        text: `#${t.id} · W${t.week || "?"} · ${t.title}`,
      }));
    const select = new TomSelect("#dep-select", {
      options,
      create: false,
      searchField: ["text"],
      maxItems: 1,
      placeholder: "Search task…",
    });

    document
      .getElementById("add-dep-form")
      .addEventListener("submit", async (e) => {
        e.preventDefault();
        const val = select.getValue();
        if (!val) return;

        // Enforce week > dep.week
        const depTask = tasks.find((t) => String(t.id) === String(val));
        const depWeek = Number(depTask?.week || 0);
        const minWeek = depWeek + 1;
        if (
          weekInput &&
          (!weekInput.value || Number(weekInput.value) < minWeek)
        ) {
          weekInput.value = String(minWeek);
          weekInput.min = String(minWeek);
          weekInput.placeholder = `≥ ${minWeek}`;
          weekInput.title = `Week must be after dependency (#${depTask?.id}).`;
        }

        try {
          await postJSON("/api/dependencies", {
            task_id: taskId,
            depends_on_id: Number(val),
          });
          window.location.reload();
        } catch (err) {
          alert("Add dependency failed: " + err.message);
        }
      });
  } catch (_) {
    // ignore if TomSelect not available
  }
});
