"""SQLite 데이터베이스. data/storyboard.db 하나에 전부 들어간다."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator

import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color       TEXT NOT NULL DEFAULT '#F0A93C',
    avatar_key  TEXT,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    last_seen   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS boards (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scenes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id    INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    x           REAL NOT NULL DEFAULT 0,
    y           REAL NOT NULL DEFAULT 0,
    title       TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    media_key   TEXT,
    media_kind  TEXT,
    media_name  TEXT,
    media_mime  TEXT,
    media_size  INTEGER,
    -- 프레임 안에서의 화면 조정 (16:9 틀은 고정)
    fit         TEXT NOT NULL DEFAULT 'contain',
    zoom        REAL NOT NULL DEFAULT 1,
    off_x       REAL NOT NULL DEFAULT 0,
    off_y       REAL NOT NULL DEFAULT 0,
    brightness  REAL NOT NULL DEFAULT 1,
    contrast    REAL NOT NULL DEFAULT 1,
    saturation  REAL NOT NULL DEFAULT 1,
    grain       REAL NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scenes_board ON scenes(board_id, position);

CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id    INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_scene ON comments(scene_id, id);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    config.ensure_dirs()
    conn = sqlite3.connect(config.DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    """쓰기용. 예외가 나면 롤백한다."""
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@contextmanager
def ro() -> Iterator[sqlite3.Connection]:
    """읽기용."""
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


def init() -> None:
    with tx() as conn:
        conn.executescript(SCHEMA)
        migrate(conn)


SCENE_COLUMNS = (
    ("x", "REAL NOT NULL DEFAULT 0"),
    ("y", "REAL NOT NULL DEFAULT 0"),
    ("fit", "TEXT NOT NULL DEFAULT 'contain'"),
    ("zoom", "REAL NOT NULL DEFAULT 1"),
    ("off_x", "REAL NOT NULL DEFAULT 0"),
    ("off_y", "REAL NOT NULL DEFAULT 0"),
    ("brightness", "REAL NOT NULL DEFAULT 1"),
    ("contrast", "REAL NOT NULL DEFAULT 1"),
    ("saturation", "REAL NOT NULL DEFAULT 1"),
    ("grain", "REAL NOT NULL DEFAULT 0"),
)


def migrate(conn: sqlite3.Connection) -> None:
    """예전 버전으로 만든 파일도 열리도록 빠진 컬럼만 채워 넣는다."""
    have = {row["name"] for row in conn.execute("PRAGMA table_info(scenes)")}
    for column, ddl in SCENE_COLUMNS:
        if column not in have:
            conn.execute(f"ALTER TABLE scenes ADD COLUMN {column} {ddl}")
