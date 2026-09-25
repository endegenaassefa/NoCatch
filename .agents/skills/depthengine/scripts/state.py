"""Transactional run state. No provider SDKs or third-party Python dependencies."""
from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import stat
import sqlite3
import time
import uuid


class Conflict(RuntimeError):
    pass


def uid():
    return uuid.uuid4().hex


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def file_digest(path):
    path = Path(path)
    digest = hashlib.sha256()
    digest.update(str(path.stat().st_mode & 0o111).encode() + b"\0")
    with regular_file(path) as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


@contextlib.contextmanager
def regular_file(path):
    # O_NONBLOCK prevents FIFOs from hanging the coordinator before its watchdog.
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError(f"Expected a regular file: {path}")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            yield stream
    finally:
        os.close(fd)


def resolve_executable(command, project):
    if os.path.dirname(command):
        path = Path(command)
        if not path.is_absolute():
            path = Path(project) / path
        resolved = shutil.which(str(path))
    else:
        # Relative PATH entries are relative to the child's cwd, not ours.
        paths = [str(Path(p) if Path(p).is_absolute() else Path(project) / p) for p in os.get_exec_path()]
        resolved = shutil.which(command, path=os.pathsep.join(paths))
    if not resolved:
        raise ValueError(f"Verification executable unavailable: {command}")
    return str(Path(resolved).resolve())


def verifier_manifest(project, task):
    """Pin existing file arguments, interpreter and explicitly declared helpers."""
    manifest = {}
    for index, argument in enumerate(task["verify"]):
        arg = argument.replace("{project}", str(project))
        if "{evidence}" in arg:
            continue
        path = Path(arg)
        if not path.is_absolute():
            path = Path(project) / path
        if index == 0:
            path = Path(resolve_executable(arg, project))
        try:
            is_file = path.is_file()
        except OSError:
            is_file = False  # An inline -c argument is not necessarily a path.
        if is_file:
            manifest[str(path.resolve())] = file_digest(path.resolve())
    for arg in task.get("verify_files", []):
        path = Path(arg.replace("{project}", str(project)))
        if not path.is_absolute():
            path = Path(project) / path
        if not path.is_file():
            raise ValueError(f"Declared verification helper missing: {path}")
        manifest[str(path.resolve())] = file_digest(path.resolve())
    return manifest


IGNORED = {".git", ".depthengine", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache"}


def fingerprint(project):
    """Hash names and bytes, including untracked files. Fail rather than truncate."""
    root = Path(project).resolve()
    digest = hashlib.sha256()
    total = 0
    count = 0
    def unreadable(error):
        raise error
    for directory, folders, files in os.walk(root, onerror=unreadable):
        folders[:] = sorted(x for x in folders if x not in IGNORED)
        if any((Path(directory) / x).is_symlink() for x in folders):
            raise ValueError("Source directory symlinks need explicit handling")
        for name in sorted(files):
            path = Path(directory) / name
            if path.is_symlink():
                raise ValueError(f"Source symlink needs explicit handling: {path}")
            count += 1
            if count > 20000:
                raise ValueError("Source exceeds 20,000 files; narrow the project root")
            digest.update(str(path.relative_to(root)).encode() + b"\0")
            digest.update(str(path.stat().st_mode & 0o111).encode() + b"\0")
            with regular_file(path) as stream:
                while chunk := stream.read(1024 * 1024):
                    total += len(chunk)
                    if total > 256 * 1024 * 1024:
                        raise ValueError("Source exceeds 256 MiB; narrow the project root")
                    digest.update(chunk)
            digest.update(b"\0")
    return digest.hexdigest()


def validate_spec(spec):
    if not isinstance(spec, dict) or not isinstance(spec.get("goal"), str) or not spec["goal"].strip():
        raise ValueError("spec.goal must be nonempty")
    tasks = spec.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise ValueError("spec.tasks must be nonempty")
    ids = [t.get("id") for t in tasks]
    if any(not isinstance(i, str) or not i or not all(c.isalnum() or c in '-_' for c in i) for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("Task IDs must be unique alphanumeric/hyphen/underscore strings")
    for task in tasks:
        from routing import validate_task
        validate_task(task)
        if not isinstance(task.get("instruction"), str) or not task["instruction"].strip():
            raise ValueError("Each task needs an instruction")
        criteria = task.get("criteria")
        if not isinstance(criteria, list) or not criteria or any(not isinstance(c, str) or not c.strip() for c in criteria):
            raise ValueError("Each task needs acceptance criteria")
        verify = task.get("verify")
        if not isinstance(verify, list) or not verify or any(not isinstance(a, str) or not a for a in verify):
            raise ValueError("Each task needs a verification argv array")
        checks = task.get("required_checks")
        if not isinstance(checks, list) or not checks or any(not isinstance(c, str) or not c for c in checks) or len(set(checks)) != len(checks):
            raise ValueError("Each task needs unique required_checks")
        if not isinstance(task.get("verify_files", []), list) or any(not isinstance(p, str) or not p for p in task.get("verify_files", [])):
            raise ValueError("verify_files must be file paths")
        deps = task.get("depends_on", [])
        if not isinstance(deps, list) or any(d not in ids or d == task["id"] for d in deps):
            raise ValueError("Invalid task dependencies")
    pending, resolved = list(tasks), set()
    while pending:
        ready = [t for t in pending if set(t.get("depends_on", [])) <= resolved]
        if not ready:
            raise ValueError("Task dependency cycle")
        resolved.update(t["id"] for t in ready)
        pending = [t for t in pending if t not in ready]
    return spec


class Store:
    def __init__(self, project):
        self.project = Path(project).resolve(strict=True)
        self.root = self.project / ".depthengine"
        self.root.mkdir(mode=0o700, exist_ok=True)
        self.db = self.root / "state.sqlite3"
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, run TEXT NOT NULL, revision INTEGER NOT NULL, at REAL NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
                PRAGMA user_version=1;
            """)

    def connect(self):
        db = sqlite3.connect(self.db, timeout=20)
        db.execute("PRAGMA busy_timeout=20000")
        return db

    def get(self, run_id):
        with self.connect() as db:
            row = db.execute("SELECT body FROM runs WHERE id=?", (run_id,)).fetchone()
        if not row:
            raise ValueError(f"Unknown run: {run_id}")
        value = json.loads(row[0])
        if not Path(value["project"]).exists() or not os.path.samefile(value["project"], self.project):
            raise Conflict("Project identity mismatch")
        return value

    def change(self, run_id, kind, update, expected=None):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT revision,body FROM runs WHERE id=?", (run_id,)).fetchone()
            if not row:
                raise ValueError(f"Unknown run: {run_id}")
            revision, body = row
            if expected is not None and expected != revision:
                raise Conflict("Stale state revision")
            value = json.loads(body)
            detail = update(value)
            value["revision"] = revision + 1
            value["updated_at"] = time.time()
            db.execute("UPDATE runs SET revision=?,body=? WHERE id=?", (revision + 1, canonical(value), run_id))
            db.execute("INSERT INTO events VALUES(?,?,?,?,?,?)", (uid(), run_id, revision + 1, time.time(), kind, canonical(detail)))
        return value

    def create(self, spec, seconds=1800, steps=12, attempts=3):
        validate_spec(spec)
        from quality import prepare_quality
        quality = prepare_quality(self.project, spec) if 'quality' in spec else None
        if not math.isfinite(seconds) or seconds <= 0 or not isinstance(steps, int) or not isinstance(attempts, int) or steps <= 0 or attempts <= 0:
            raise ValueError("Budgets must be positive")
        run_id = uid()
        tasks = []
        for task in spec["tasks"]:
            manifest = verifier_manifest(self.project, task)
            tasks.append(dict(task, status="queued", attempts=0, evidence=None, question=None, verifier_manifest=manifest))
        value = dict(id=run_id, project=str(self.project), revision=0, epoch=0,
                     status="created", goal=spec["goal"], context=spec.get("context", {}),
                     decisions=[], tasks=tasks, quality=quality,
                     remaining_seconds=seconds, remaining_steps=steps, max_attempts=attempts,
                     active=None, coordinator=None, created_at=time.time(), updated_at=time.time())
        (self.root / "runs" / run_id).mkdir(parents=True)
        with self.connect() as db:
            db.execute("INSERT INTO runs VALUES(?,?,?)", (run_id, 0, canonical(value)))
            db.execute("INSERT INTO events VALUES(?,?,?,?,?,?)", (uid(), run_id, 0, time.time(), "created", "{}"))
        return value

    def packet(self, run_id, task_id=None):
        run = self.get(run_id)
        task = next((t for t in run["tasks"] if t["id"] == task_id), None) if task_id else None
        if task_id and not task:
            raise ValueError("Unknown task")
        return dict(run_id=run_id, project=run["project"], epoch=run["epoch"], revision=run["revision"],
                    goal=run["goal"], context=run["context"], quality=run.get('quality'),
                    remaining_seconds=run['remaining_seconds'], remaining_steps=run['remaining_steps'], max_attempts=run['max_attempts'],
                    decisions=[d for d in run["decisions"] if not d.get("superseded_by")],
                    task=task, tasks=[dict(id=t["id"], status=t["status"], evidence=t["evidence"]) for t in run["tasks"]])

    def decision(self, run_id, text, supersedes=None):
        if not text.strip():
            raise ValueError("Decision cannot be empty")
        def update(run):
            if run["status"] == "canceled":
                raise Conflict("Canceled runs cannot accept decisions")
            decision = dict(id=uid(), text=text, supersedes=supersedes, at=time.time())
            if supersedes:
                old = next((d for d in run["decisions"] if d["id"] == supersedes and not d.get("superseded_by")), None)
                if not old:
                    raise ValueError("Superseded decision is missing or already replaced")
                old["superseded_by"] = decision["id"]
            run["decisions"].append(decision)
            run["epoch"] += 1
            run["status"] = "paused"
            for task in run["tasks"]:
                task.update(status="queued", evidence=None, question=None, blocker_kind=None, attempts=0)
            return decision
        return self.change(run_id, "decision", update)

    def control(self, run_id, action):
        def update(run):
            if run["status"] == "canceled":
                raise Conflict("Run already canceled")
            if action not in ("paused", "canceled"):
                raise ValueError("Invalid control action")
            run["epoch"] += 1
            run["status"] = action
            return {"requested": action, "active_cleanup_pending": bool(run["active"])}
        return self.change(run_id, action, update)


@contextlib.contextmanager
def project_lock(store):
    """Stable inode, OS-released crash lock; serializes ALL runs in this project."""
    import fcntl
    with (store.root / "coordinator.lock").open("a+") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise Conflict("Another coordinator owns this project") from exc
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)
