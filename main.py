from __future__ import annotations

import os
import re
import sys
from datetime import date, datetime, timedelta
from typing import Dict, List

from flask import (
    Flask,
    abort,
    jsonify,
    render_template,
    request,
    session,
)
from flask_sqlalchemy import SQLAlchemy


BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DB_PATH = os.path.join(BASE_DIR, "tasks.db")
DEFAULT_START_DATE = date(2025, 8, 25)

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("TASKS_SECRET_KEY", "dev-secret-key")
app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{DB_PATH}"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db = SQLAlchemy(app)

def _ensure_sqlite_columns() -> None:
    try:
        if not os.path.exists(DB_PATH):
            return
        import sqlite3
        con = sqlite3.connect(DB_PATH)
        cols = {row[1] for row in con.execute("PRAGMA table_info(task)").fetchall()}
        if "started_at" not in cols:
            con.execute("ALTER TABLE task ADD COLUMN started_at DATE")
        if "completed_at" not in cols:
            con.execute("ALTER TABLE task ADD COLUMN completed_at DATE")
        con.commit()
        con.close()
    except Exception:
        pass

@app.teardown_appcontext
def shutdown_session(exception: Exception | None = None):
    db.session.remove()


# Models
class Task(db.Model):
    __tablename__ = "task"

    id = db.Column(db.Integer, primary_key=True)
    slug = db.Column(db.String(255), unique=True, index=True)
    title = db.Column(db.String(255), nullable=False)
    description = db.Column(db.Text, default="")
    status = db.Column(
        db.String(20), nullable=False, default="todo", index=True
    )
    priority = db.Column(db.Integer, default=2)
    week = db.Column(db.Integer, index=True)
    start_date = db.Column(db.Date)
    end_date = db.Column(db.Date)
    started_at = db.Column(db.Date)
    completed_at = db.Column(db.Date)
    progress = db.Column(db.Float, default=0.0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(
        db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    subtasks = db.relationship(
        "Subtask", backref="task", cascade="all, delete-orphan", lazy="dynamic"
    )
    dependencies = db.relationship(
        "Dependency",
        foreign_keys="Dependency.task_id",
        backref="task",
        cascade="all, delete-orphan",
        lazy="dynamic",
    )
    dependents = db.relationship(
        "Dependency",
        foreign_keys="Dependency.depends_on_id",
        backref="depends_on_task",
        cascade="all, delete-orphan",
        lazy="dynamic",
    )

    def as_dict(self) -> Dict:
        return {
            "id": self.id,
            "slug": self.slug,
            "title": self.title,
            "description": self.description,
            "status": self.status,
            "priority": self.priority,
            "week": self.week,
            "start_date": self.start_date.isoformat()
            if self.start_date
            else None,
            "end_date": self.end_date.isoformat() if self.end_date else None,
            "started_at": self.started_at.isoformat()
            if self.started_at
            else None,
            "completed_at": self.completed_at.isoformat()
            if self.completed_at
            else None,
            "progress": self.progress,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


class Subtask(db.Model):
    __tablename__ = "subtask"

    id = db.Column(db.Integer, primary_key=True)
    task_id = db.Column(db.Integer, db.ForeignKey("task.id"), index=True)
    title = db.Column(db.String(255), nullable=False)
    done = db.Column(db.Boolean, default=False)

    def as_dict(self) -> Dict:
        return {
            "id": self.id,
            "task_id": self.task_id,
            "title": self.title,
            "done": self.done,
        }


class Dependency(db.Model):
    __tablename__ = "dependency"

    id = db.Column(db.Integer, primary_key=True)
    task_id = db.Column(db.Integer, db.ForeignKey("task.id"), index=True)
    depends_on_id = db.Column(db.Integer, db.ForeignKey("task.id"), index=True)

    def as_dict(self) -> Dict:
        return {
            "id": self.id,
            "task_id": self.task_id,
            "depends_on_id": self.depends_on_id,
        }


# Helpers
def slugify(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "task"


def ensure_csrf():
    token = session.get("_csrf_token")
    if not token:
        token = os.urandom(16).hex()
        session["_csrf_token"] = token
    return token


@app.before_request
def _init_csrf():
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        token = session.get("_csrf_token")
        header = request.headers.get("X-CSRF-Token")
        if not token or not header or header != token:
            abort(400, description="CSRF validation failed")


@app.context_processor
def inject_globals():
    return {
        "csrf_token": ensure_csrf(),
        "today": date.today(),
        "Subtask": Subtask,
        "Task": Task,
    }


def compute_task_progress(t: Task) -> float:
    total = t.subtasks.count()
    if total == 0:
        return 100.0 if t.status == "done" else 0.0
    done = t.subtasks.filter_by(done=True).count()
    return round(100.0 * (done / total), 1)


def has_blocking_dependencies(t: Task) -> bool:
    deps = t.dependencies.all()
    if not deps:
        return False
    dep_task_ids = [d.depends_on_id for d in deps]
    if not dep_task_ids:
        return False
    q = Task.query.filter(Task.id.in_(dep_task_ids)).all()
    return any(x.status != "done" for x in q)


def enforce_blocking_status(t: Task) -> None:
    if t.status != "done" and has_blocking_dependencies(t):
        t.status = "blocked"
    elif t.status == "blocked" and not has_blocking_dependencies(t):
        t.status = "in_progress" if t.progress > 0 else "todo"


def update_dependents_status(changed_task_id: int) -> None:
    deps = Dependency.query.filter_by(depends_on_id=changed_task_id).all()
    for dep in deps:
        dt = Task.query.get(dep.task_id)
        if not dt:
            continue
        dt.progress = compute_task_progress(dt)
        if has_blocking_dependencies(dt):
            if dt.status != "done":
                dt.status = "blocked"
        else:
            if dt.status == "blocked":
                if dt.progress == 100.0:
                    dt.status = "done"
                elif dt.progress > 0.0:
                    dt.status = "in_progress"
                else:
                    dt.status = "todo"
    db.session.commit()


def set_dates_for_week(t: Task, start_date: date) -> None:
    if t.week and t.week > 0:
        offset = (t.week - 1) * 7
        t.start_date = start_date + timedelta(days=offset)
        t.end_date = t.start_date + timedelta(days=6)

def _ensure_columns_on_startup() -> None:
    _ensure_sqlite_columns()

_ensure_columns_on_startup()


# Routes: pages
@app.route("/")
def index():
    tasks = Task.query.order_by(Task.week.asc(), Task.priority.asc()).all()
    weeks: Dict[int, List[Task]] = {}
    for t in tasks:
        weeks.setdefault(t.week or 0, []).append(t)
    return render_template("index.html", weeks=weeks)


@app.route("/calendar")
def calendar():
    return render_template("calendar.html")


@app.route("/tasks/<int:task_id>")
def task_detail(task_id: int):
    t = Task.query.get_or_404(task_id)
    deps = (
        db.session.query(Dependency, Task)
        .join(Task, Dependency.depends_on_id == Task.id)
        .filter(Dependency.task_id == task_id)
        .all()
    )
    dependents = (
        db.session.query(Dependency, Task)
        .join(Task, Dependency.task_id == Task.id)
        .filter(Dependency.depends_on_id == task_id)
        .all()
    )
    return render_template(
        "task_detail.html",
        task=t,
        deps=[d[1] for d in deps],
        dependents=[d[1] for d in dependents],
    )


@app.route("/graph")
def graph_page():
    return render_template("graph.html")


# API
@app.route("/api/tasks", methods=["GET", "POST"])
def api_tasks():
    if request.method == "GET":
        tasks = Task.query.order_by(Task.week.asc(), Task.priority.asc()).all()
        return jsonify({"ok": True, "tasks": [t.as_dict() for t in tasks]})
    data = request.get_json(force=True, silent=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        abort(400, description="title is required")
    t = Task()
    t.title = title
    t.description = (data.get("description") or "").strip()
    t.status = data.get("status") or "todo"
    t.priority = int(data.get("priority") or 2)
    t.week = int(data.get("week") or 0)
    t.slug = slugify(title)
    set_dates_for_week(t, DEFAULT_START_DATE)
    db.session.add(t)
    db.session.commit()
    t.progress = compute_task_progress(t)
    enforce_blocking_status(t)
    db.session.commit()
    return jsonify({"ok": True, "task": t.as_dict()})


@app.route("/api/tasks/<int:task_id>/dependents")
def api_get_dependents(task_id: int):
    deps = Dependency.query.filter_by(depends_on_id=task_id).all()
    ids = [d.task_id for d in deps]
    tasks = Task.query.filter(Task.id.in_(ids)).all() if ids else []
    return jsonify({"ok": True, "dependents": [t.as_dict() for t in tasks]})


@app.route("/api/tasks/<int:task_id>/status", methods=["POST"])
def api_update_task_status(task_id: int):
    t = Task.query.get_or_404(task_id)
    data = request.get_json(force=True, silent=True) or {}
    new_status = data.get("status")
    if new_status not in ("todo", "in_progress", "done"):
        abort(400, description="invalid status")

    if new_status == "done":
        if has_blocking_dependencies(t):
            abort(400, description="Task has incomplete dependencies")
        for st in t.subtasks.all():
            st.done = True
        t.status = "done"
        if not t.completed_at:
            t.completed_at = date.today()
        if not t.started_at:
            t.started_at = date.today()
    elif new_status == "todo":
        for st in t.subtasks.all():
            st.done = False
        t.status = "todo"
        t.completed_at = None
    else:
        t.status = "in_progress"
        if not t.started_at:
            t.started_at = date.today()

    db.session.commit()
    t.progress = compute_task_progress(t)
    enforce_blocking_status(t)
    db.session.commit()
    update_dependents_status(t.id)
    return jsonify({"ok": True, "task": t.as_dict()})


@app.route("/api/tasks/<int:task_id>/edit", methods=["POST"])
def api_edit_task(task_id: int):
    t = Task.query.get_or_404(task_id)
    data = request.get_json(force=True, silent=True) or {}
    if "title" in data:
        t.title = (data["title"] or "").strip()
        t.slug = slugify(t.title)
    if "description" in data:
        t.description = (data["description"] or "").strip()
    if "priority" in data:
        t.priority = int(data["priority"])
    if "week" in data:
        t.week = int(data["week"])
        set_dates_for_week(t, DEFAULT_START_DATE)
    t.progress = compute_task_progress(t)
    enforce_blocking_status(t)
    db.session.commit()
    return jsonify({"ok": True, "task": t.as_dict()})


@app.route("/api/tasks/<int:task_id>/delete", methods=["POST"])
def api_delete_task(task_id: int):
    t = Task.query.get_or_404(task_id)
    deps = Dependency.query.filter_by(depends_on_id=task_id).all()
    dep_task_ids = [d.task_id for d in deps]
    for d in deps:
        db.session.delete(d)
    Dependency.query.filter_by(task_id=task_id).delete()
    Subtask.query.filter_by(task_id=task_id).delete()
    db.session.delete(t)
    db.session.commit()
    for dep_task_id in dep_task_ids:
        dt = Task.query.get(dep_task_id)
        if dt:
            dt.progress = compute_task_progress(dt)
            enforce_blocking_status(dt)
    db.session.commit()
    return jsonify({"ok": True})


@app.route("/api/subtasks", methods=["POST"])
def api_create_subtask():
    data = request.get_json(force=True, silent=True) or {}
    task_id = int(data.get("task_id") or 0)
    title = (data.get("title") or "").strip()
    if not task_id or not title:
        abort(400, description="task_id and title are required")
    t = Task.query.get_or_404(task_id)
    st = Subtask()
    st.task_id = t.id
    st.title = title
    st.done = False
    db.session.add(st)
    db.session.commit()
    t.progress = compute_task_progress(t)
    if t.status == "done" and t.progress < 100.0:
        t.status = "in_progress"
        t.completed_at = None
    if t.progress > 0.0 and not t.started_at:
        t.started_at = date.today()
    enforce_blocking_status(t)
    db.session.commit()
    return jsonify({"ok": True, "subtask": st.as_dict()})


@app.route("/api/subtasks/<int:subtask_id>/toggle", methods=["POST"])
def api_toggle_subtask(subtask_id: int):
    st = Subtask.query.get_or_404(subtask_id)
    t = Task.query.get(st.task_id)
    if t is None:
        abort(404, description="Parent task not found")
    if has_blocking_dependencies(t):
        abort(400, description="Task is blocked by dependencies; cannot toggle subtasks")
    st.done = not st.done
    db.session.commit()
    t = Task.query.get(st.task_id)
    t.progress = compute_task_progress(t)
    if t.progress == 100.0 and not has_blocking_dependencies(t):
        t.status = "done"
        if not t.completed_at:
            t.completed_at = date.today()
        if not t.started_at:
            t.started_at = date.today()
    elif t.progress > 0.0 and t.status != "done":
        t.status = "in_progress"
        if not t.started_at:
            t.started_at = date.today()
        t.completed_at = None
    else:
        if not has_blocking_dependencies(t):
            t.status = "todo"
            t.completed_at = None
    enforce_blocking_status(t)
    db.session.commit()
    update_dependents_status(t.id)
    return jsonify({"ok": True, "subtask": st.as_dict(), "task": t.as_dict()})


@app.route("/api/subtasks/<int:subtask_id>/delete", methods=["POST"])
def api_delete_subtask(subtask_id: int):
    st = Subtask.query.get_or_404(subtask_id)
    t = Task.query.get(st.task_id)
    if t and has_blocking_dependencies(t):
        abort(400, description="Task is blocked by dependencies; cannot delete subtask")
    db.session.delete(st)
    db.session.commit()
    if t:
        t.progress = compute_task_progress(t)
        if t.progress == 100.0 and not has_blocking_dependencies(t):
            t.status = "done"
            if not t.completed_at:
                t.completed_at = date.today()
        else:
            if t.status == "done" and t.progress < 100.0:
                t.status = "in_progress" if t.progress > 0 else "todo"
                t.completed_at = None
            if t.progress > 0 and not t.started_at:
                t.started_at = date.today()
        enforce_blocking_status(t)
        db.session.commit()
    return jsonify({"ok": True, "task": t.as_dict() if t else None})


@app.route("/api/dependencies", methods=["POST"])
def api_add_dependency():
    data = request.get_json(force=True, silent=True) or {}
    task_id = int(data.get("task_id") or 0)
    depends_on_id = int(data.get("depends_on_id") or 0)
    if not task_id or not depends_on_id or task_id == depends_on_id:
        abort(400, description="invalid dependency")
    exists = Dependency.query.filter_by(
        task_id=task_id, depends_on_id=depends_on_id
    ).first()
    if exists:
        return jsonify({"ok": True, "dependency": exists.as_dict()})
    dep = Dependency()
    dep.task_id = task_id
    dep.depends_on_id = depends_on_id
    db.session.add(dep)
    db.session.commit()
    t = Task.query.get_or_404(task_id)
    enforce_blocking_status(t)
    db.session.commit()
    return jsonify({"ok": True, "dependency": dep.as_dict()})


@app.route("/api/dependencies/<int:dep_id>/delete", methods=["POST"])
def api_delete_dependency(dep_id: int):
    dep = Dependency.query.get_or_404(dep_id)
    task_id = dep.task_id
    db.session.delete(dep)
    db.session.commit()
    t = Task.query.get(task_id)
    enforce_blocking_status(t)
    db.session.commit()
    return jsonify({"ok": True})


@app.route("/api/graph")
def api_graph():
    tasks = Task.query.all()
    nodes = [
        {
            "id": t.id,
            "title": t.title,
            "status": t.status,
            "week": t.week,
        }
        for t in tasks
    ]
    deps = Dependency.query.all()
    links = [{"source": d.depends_on_id, "target": d.task_id} for d in deps]
    return jsonify({"nodes": nodes, "links": links})


# CLI commands
@app.cli.command("db-init")
def db_init():
    """Create tables (and ensure optional columns exist)."""
    db.create_all()
    _ensure_sqlite_columns()
    print("DB initialized:", DB_PATH)

@app.cli.command("db-migrate")
def db_migrate():
    """Ensure optional columns exist (non-destructive)."""
    _ensure_sqlite_columns()
    print("DB migrated (columns ensured):", DB_PATH)


@app.cli.command("db-seed")
def db_seed():
    """Seed 24-week plan."""
    import json

    db.create_all()
    _ensure_sqlite_columns()
    seed_path = os.path.join(BASE_DIR, "seeds", "tasks_seed.json")
    with open(seed_path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    Dependency.query.delete()
    Subtask.query.delete()
    Task.query.delete()
    db.session.commit()

    id_map: Dict[str, int] = {}
    for item in payload.get("tasks", []):
        t = Task()
        t.title = item["title"]
        t.description = item.get("description", "")
        t.status = item.get("status", "todo")
        t.priority = item.get("priority", 2)
        t.week = item.get("week", 0)
        t.slug = slugify(t.title)
        set_dates_for_week(t, DEFAULT_START_DATE)
        db.session.add(t)
        db.session.flush()
        id_map[item["key"]] = t.id
        for st_title in item.get("subtasks", []):
            st = Subtask()
            st.task_id = t.id
            st.title = st_title
            st.done = False
            db.session.add(st)

    db.session.commit()

    for item in payload.get("tasks", []):
        src = id_map[item["key"]]
        for dep_key in item.get("depends_on", []):
            dep = Dependency()
            dep.task_id = src
            dep.depends_on_id = id_map[dep_key]
            db.session.add(dep)

    db.session.commit()

    for t in Task.query.all():
        t.progress = compute_task_progress(t)
        enforce_blocking_status(t)
    db.session.commit()

    print("Seeded", len(id_map), "tasks.")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        app.run(debug=True, port=5000)
    else:
        print(
            "Use: uv run -- flask --app main:app run -p 5000\n"
            "or: uv run main.py -- serve"
        )
