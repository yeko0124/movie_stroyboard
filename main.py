"""영상 스토리보드 — 3인용 로컬 서버.

실행:  python main.py   (또는 run.bat)
"""

from __future__ import annotations

import hmac
import mimetypes
import secrets
import sqlite3
from contextlib import asynccontextmanager
from hashlib import sha256
from pathlib import Path
from typing import Optional
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    RedirectResponse,
    Response,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles

import config
import db
from storage import LocalStorage, get_storage, validate_key


@asynccontextmanager
async def lifespan(_: FastAPI):
    config.ensure_dirs()
    db.init()
    yield


app = FastAPI(title="Storyboard", docs_url=None, redoc_url=None, lifespan=lifespan)

STATIC_DIR = config.BASE_DIR / "static"
GATE_COOKIE = "sb_gate"
SESSION_COOKIE = "sb_session"
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"}
VIDEO_EXT = {".mp4", ".mov", ".webm", ".m4v", ".mkv", ".avi"}
AVATAR_MAX_BYTES = 5 * 1024 * 1024


# ─────────────────────────────────────────────────────────────
# 인증
# ─────────────────────────────────────────────────────────────


def _sign(value: str) -> str:
    mac = hmac.new(config.secret_key(), value.encode("utf-8"), sha256).hexdigest()
    return f"{value}.{mac}"


def _verify(token: Optional[str], expected: str) -> bool:
    if not token or "." not in token:
        return False
    value, _, mac = token.rpartition(".")
    return value == expected and hmac.compare_digest(_sign(value), token)


def has_gate(request: Request) -> bool:
    if not config.INVITE_CODE:  # 코드를 설정하지 않았으면 누구나 통과
        return True
    return _verify(request.cookies.get(GATE_COOKIE), "gate")


def require_gate(request: Request) -> None:
    if not has_gate(request):
        raise HTTPException(status_code=403, detail="초대 코드를 먼저 입력해 주세요.")


def current_user(request: Request) -> Optional[sqlite3.Row]:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    with db.tx() as conn:
        row = conn.execute(
            """SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.token = ?""",
            (token,),
        ).fetchone()
        if row:
            conn.execute("UPDATE sessions SET last_seen = ? WHERE token = ?", (db.now(), token))
    return row


def require_user(request: Request) -> sqlite3.Row:
    user = current_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    return user


async def read_json(request: Request) -> dict:
    """본문이 깨졌거나 비어 있어도 500 대신 400을 돌려준다."""
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="요청 형식이 올바르지 않습니다.")
    return payload if isinstance(payload, dict) else {}


# ─────────────────────────────────────────────────────────────
# 직렬화
# ─────────────────────────────────────────────────────────────


def user_json(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "color": row["color"],
        "avatar_url": f"/media/{row['avatar_key']}" if row["avatar_key"] else None,
    }


# 캔버스에 새 프레임을 자동으로 놓을 때 쓰는 간격 (프레임 320 × 180 기준)
FRAME_W, FRAME_H = 320.0, 180.0
GAP_X, GAP_Y = 120.0, 130.0
PER_ROW = 4


def _coord(value, fallback: float) -> float:
    """좌표는 숫자만 받는다. 이상한 값이 오면 원래 자리에 둔다."""
    if value is None:
        return float(fallback)
    try:
        number = float(value)
    except (TypeError, ValueError):
        return float(fallback)
    if number != number or number in (float("inf"), float("-inf")):  # NaN / 무한대
        return float(fallback)
    return max(-100_000.0, min(number, 100_000.0))


def auto_place(index: int) -> tuple[float, float]:
    return (
        (index % PER_ROW) * (FRAME_W + GAP_X),
        (index // PER_ROW) * (FRAME_H + GAP_Y),
    )


def scene_json(row: sqlite3.Row) -> dict:
    data = {
        "id": row["id"],
        "position": row["position"],
        "x": row["x"],
        "y": row["y"],
        "title": row["title"],
        "note": row["note"],
        "media_kind": row["media_kind"],
        "media_name": row["media_name"],
        "media_size": row["media_size"],
        "media_mime": row["media_mime"],
        "media_url": f"/media/{row['media_key']}" if row["media_key"] else None,
        "updated_at": row["updated_at"],
    }
    if "comment_count" in row.keys():
        data["comment_count"] = row["comment_count"]
    return data


def comment_json(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "body": row["body"],
        "created_at": row["created_at"],
        "author": {
            "id": row["user_id"],
            "name": row["name"],
            "color": row["color"],
            "avatar_url": f"/media/{row['avatar_key']}" if row["avatar_key"] else None,
        },
    }


def touch_board(conn: sqlite3.Connection, board_id: int) -> None:
    conn.execute("UPDATE boards SET updated_at = ? WHERE id = ?", (db.now(), board_id))


# ─────────────────────────────────────────────────────────────
# 로그인 / 프로필
# ─────────────────────────────────────────────────────────────


@app.post("/api/gate")
async def enter_code(request: Request):
    payload = await read_json(request)
    code = str(payload.get("code", "")).strip()
    # compare_digest 는 ASCII 문자열만 받는다. 한글이 섞여 들어와도 죽지 않게 바이트로 비교한다.
    if config.INVITE_CODE and not secrets.compare_digest(
        code.encode("utf-8"), config.INVITE_CODE.encode("utf-8")
    ):
        raise HTTPException(status_code=403, detail="초대 코드가 맞지 않습니다.")
    response = JSONResponse({"ok": True})
    response.set_cookie(
        GATE_COOKIE,
        _sign("gate"),
        max_age=60 * 60 * 24 * 365,
        httponly=True,
        samesite="lax",
    )
    return response


@app.get("/api/profiles")
def list_profiles(request: Request, _: None = Depends(require_gate)):
    with db.ro() as conn:
        rows = conn.execute("SELECT * FROM users ORDER BY id").fetchall()
    return [user_json(r) for r in rows]


@app.post("/api/login")
def login(
    request: Request,
    profile_id: Optional[int] = Form(default=None),
    name: Optional[str] = Form(default=None),
    color: str = Form(default="#F0A93C"),
    avatar: Optional[UploadFile] = File(default=None),
    _: None = Depends(require_gate),
):
    store = get_storage()

    with db.tx() as conn:
        if profile_id is not None:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (profile_id,)).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="없는 프로필입니다.")
        else:
            display_name = (name or "").strip()
            if not display_name:
                raise HTTPException(status_code=400, detail="이름을 입력해 주세요.")
            if len(display_name) > 24:
                raise HTTPException(status_code=400, detail="이름은 24자까지 가능합니다.")
            exists = conn.execute(
                "SELECT id FROM users WHERE name = ? COLLATE NOCASE", (display_name,)
            ).fetchone()
            if exists:
                raise HTTPException(
                    status_code=409,
                    detail="이미 있는 이름입니다. 목록에서 골라 주세요.",
                )

            avatar_key = None
            if avatar is not None and avatar.filename:
                ext = Path(avatar.filename).suffix.lower()
                if ext not in IMAGE_EXT:
                    raise HTTPException(status_code=400, detail="프로필은 이미지 파일만 됩니다.")
                avatar.file.seek(0, 2)
                if avatar.file.tell() > AVATAR_MAX_BYTES:
                    raise HTTPException(status_code=413, detail="프로필 사진은 5MB까지 가능합니다.")
                avatar.file.seek(0)
                avatar_key = f"avatars/{uuid4().hex}{ext}"
                store.save(avatar_key, avatar.file)

            cur = conn.execute(
                "INSERT INTO users (name, color, avatar_key, created_at) VALUES (?, ?, ?, ?)",
                (display_name, color, avatar_key, db.now()),
            )
            row = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()

        token = secrets.token_urlsafe(32)
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)",
            (token, row["id"], db.now(), db.now()),
        )

    response = JSONResponse(user_json(row))
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=60 * 60 * 24 * config.SESSION_DAYS,
        httponly=True,
        samesite="lax",
    )
    return response


@app.post("/api/logout")
def logout(request: Request):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        with db.tx() as conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    response = JSONResponse({"ok": True})
    response.delete_cookie(SESSION_COOKIE)
    return response


@app.get("/api/me")
def me(request: Request):
    user = current_user(request)
    return {
        "user": user_json(user) if user else None,
        "gate": has_gate(request),
        "code_required": bool(config.INVITE_CODE),
    }


@app.patch("/api/me")
async def update_me(request: Request, user: sqlite3.Row = Depends(require_user)):
    payload = await read_json(request)
    color = str(payload.get("color", user["color"]))[:16]
    with db.tx() as conn:
        conn.execute("UPDATE users SET color = ? WHERE id = ?", (color, user["id"]))
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    return user_json(row)


@app.post("/api/me/avatar")
def update_avatar(
    avatar: UploadFile = File(...),
    user: sqlite3.Row = Depends(require_user),
):
    ext = Path(avatar.filename or "").suffix.lower()
    if ext not in IMAGE_EXT:
        raise HTTPException(status_code=400, detail="이미지 파일만 됩니다.")
    avatar.file.seek(0, 2)
    if avatar.file.tell() > AVATAR_MAX_BYTES:
        raise HTTPException(status_code=413, detail="프로필 사진은 5MB까지 가능합니다.")
    avatar.file.seek(0)

    store = get_storage()
    key = f"avatars/{uuid4().hex}{ext}"
    store.save(key, avatar.file)

    old = user["avatar_key"]
    with db.tx() as conn:
        conn.execute("UPDATE users SET avatar_key = ? WHERE id = ?", (key, user["id"]))
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    if old:
        store.delete(old)
    return user_json(row)


# ─────────────────────────────────────────────────────────────
# 보드
# ─────────────────────────────────────────────────────────────


@app.get("/api/boards")
def list_boards(user: sqlite3.Row = Depends(require_user)):
    with db.ro() as conn:
        rows = conn.execute(
            """
            SELECT b.*,
                   (SELECT COUNT(*) FROM scenes s WHERE s.board_id = b.id) AS scene_count,
                   (SELECT s.media_key FROM scenes s
                     WHERE s.board_id = b.id AND s.media_key IS NOT NULL
                     ORDER BY s.position LIMIT 1) AS cover_key,
                   (SELECT s.media_kind FROM scenes s
                     WHERE s.board_id = b.id AND s.media_key IS NOT NULL
                     ORDER BY s.position LIMIT 1) AS cover_kind
            FROM boards b
            ORDER BY b.updated_at DESC
            """
        ).fetchall()
    return [
        {
            "id": r["id"],
            "title": r["title"],
            "scene_count": r["scene_count"],
            "cover_url": f"/media/{r['cover_key']}" if r["cover_key"] else None,
            "cover_kind": r["cover_kind"],
            "updated_at": r["updated_at"],
        }
        for r in rows
    ]


@app.post("/api/boards")
async def create_board(request: Request, user: sqlite3.Row = Depends(require_user)):
    payload = await read_json(request)
    title = str(payload.get("title", "")).strip() or "제목 없는 보드"
    scene_count = max(0, min(int(payload.get("scenes", 6) or 0), 60))
    stamp = db.now()
    with db.tx() as conn:
        cur = conn.execute(
            "INSERT INTO boards (title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (title[:120], user["id"], stamp, stamp),
        )
        board_id = cur.lastrowid
        for i in range(scene_count):
            x, y = auto_place(i)
            conn.execute(
                """INSERT INTO scenes (board_id, position, x, y, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (board_id, i, x, y, stamp, stamp),
            )
    return {"id": board_id, "title": title}


@app.get("/api/boards/{board_id}")
def get_board(board_id: int, user: sqlite3.Row = Depends(require_user)):
    with db.ro() as conn:
        board = conn.execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone()
        if board is None:
            raise HTTPException(status_code=404, detail="없는 보드입니다.")
        scenes = conn.execute(
            """
            SELECT s.*, (SELECT COUNT(*) FROM comments c WHERE c.scene_id = s.id) AS comment_count
            FROM scenes s WHERE s.board_id = ? ORDER BY s.position, s.id
            """,
            (board_id,),
        ).fetchall()
    return {
        "id": board["id"],
        "title": board["title"],
        "updated_at": board["updated_at"],
        "scenes": [scene_json(s) for s in scenes],
    }


@app.patch("/api/boards/{board_id}")
async def rename_board(board_id: int, request: Request, user: sqlite3.Row = Depends(require_user)):
    payload = await read_json(request)
    title = str(payload.get("title", "")).strip()
    if not title:
        raise HTTPException(status_code=400, detail="보드 이름을 입력해 주세요.")
    with db.tx() as conn:
        changed = conn.execute(
            "UPDATE boards SET title = ?, updated_at = ? WHERE id = ?",
            (title[:120], db.now(), board_id),
        ).rowcount
    if not changed:
        raise HTTPException(status_code=404, detail="없는 보드입니다.")
    return {"ok": True, "title": title[:120]}


@app.delete("/api/boards/{board_id}")
def delete_board(board_id: int, user: sqlite3.Row = Depends(require_user)):
    store = get_storage()
    with db.tx() as conn:
        keys = [
            r["media_key"]
            for r in conn.execute(
                "SELECT media_key FROM scenes WHERE board_id = ? AND media_key IS NOT NULL",
                (board_id,),
            ).fetchall()
        ]
        deleted = conn.execute("DELETE FROM boards WHERE id = ?", (board_id,)).rowcount
    if not deleted:
        raise HTTPException(status_code=404, detail="없는 보드입니다.")
    for key in keys:
        store.delete(key)
    return {"ok": True}


# ─────────────────────────────────────────────────────────────
# 씬
# ─────────────────────────────────────────────────────────────


@app.post("/api/boards/{board_id}/scenes")
async def add_scene(board_id: int, request: Request, user: sqlite3.Row = Depends(require_user)):
    payload = await read_json(request)
    count = max(1, min(int(payload.get("count", 1) or 1), 30))
    # 캔버스에서 특정 지점에 떨어뜨린 경우 그 자리에 만든다.
    at_x = payload.get("x")
    at_y = payload.get("y")
    stamp = db.now()

    with db.tx() as conn:
        board = conn.execute("SELECT id FROM boards WHERE id = ?", (board_id,)).fetchone()
        if board is None:
            raise HTTPException(status_code=404, detail="없는 보드입니다.")
        start = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS n FROM scenes WHERE board_id = ?",
            (board_id,),
        ).fetchone()["n"]

        ids = []
        for i in range(count):
            if at_x is None or at_y is None:
                x, y = auto_place(start + i)
            else:
                x, y = float(at_x) + i * (FRAME_W + GAP_X), float(at_y)
            cur = conn.execute(
                """INSERT INTO scenes (board_id, position, x, y, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (board_id, start + i, x, y, stamp, stamp),
            )
            ids.append(cur.lastrowid)
        touch_board(conn, board_id)
    return {"ids": ids}


@app.patch("/api/scenes/{scene_id}")
async def update_scene(scene_id: int, request: Request, user: sqlite3.Row = Depends(require_user)):
    payload = await read_json(request)
    with db.tx() as conn:
        row = conn.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="없는 씬입니다.")
        title = str(payload.get("title", row["title"]))[:120]
        note = str(payload.get("note", row["note"]))[:4000]
        x = _coord(payload.get("x"), row["x"])
        y = _coord(payload.get("y"), row["y"])
        conn.execute(
            "UPDATE scenes SET title = ?, note = ?, x = ?, y = ?, updated_at = ? WHERE id = ?",
            (title, note, x, y, db.now(), scene_id),
        )
        touch_board(conn, row["board_id"])
        updated = conn.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone()
    return scene_json(updated)


@app.delete("/api/scenes/{scene_id}")
def delete_scene(scene_id: int, user: sqlite3.Row = Depends(require_user)):
    store = get_storage()
    with db.tx() as conn:
        row = conn.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="없는 씬입니다.")
        conn.execute("DELETE FROM scenes WHERE id = ?", (scene_id,))
        conn.execute(
            "UPDATE scenes SET position = position - 1 WHERE board_id = ? AND position > ?",
            (row["board_id"], row["position"]),
        )
        touch_board(conn, row["board_id"])
    if row["media_key"]:
        store.delete(row["media_key"])
    return {"ok": True}


@app.put("/api/boards/{board_id}/order")
async def reorder_scenes(board_id: int, request: Request, user: sqlite3.Row = Depends(require_user)):
    payload = await read_json(request)
    ids = payload.get("ids") or []
    if not isinstance(ids, list):
        raise HTTPException(status_code=400, detail="순서 목록이 올바르지 않습니다.")
    with db.tx() as conn:
        existing = {
            r["id"]
            for r in conn.execute("SELECT id FROM scenes WHERE board_id = ?", (board_id,)).fetchall()
        }
        if existing != {int(i) for i in ids}:
            raise HTTPException(status_code=409, detail="화면이 오래됐습니다. 새로고침해 주세요.")
        for position, scene_id in enumerate(ids):
            conn.execute(
                "UPDATE scenes SET position = ? WHERE id = ?", (position, int(scene_id))
            )
        touch_board(conn, board_id)
    return {"ok": True}


@app.post("/api/scenes/{scene_id}/media")
def upload_media(
    scene_id: int,
    file: UploadFile = File(...),
    user: sqlite3.Row = Depends(require_user),
):
    ext = Path(file.filename or "").suffix.lower()
    if ext in IMAGE_EXT:
        kind = "image"
    elif ext in VIDEO_EXT:
        kind = "video"
    else:
        raise HTTPException(
            status_code=400,
            detail="이미지 또는 영상 파일만 넣을 수 있습니다.",
        )

    file.file.seek(0, 2)
    size = file.file.tell()
    file.file.seek(0)
    limit = config.MAX_UPLOAD_MB * 1024 * 1024
    if size > limit:
        raise HTTPException(
            status_code=413,
            detail=f"파일이 너무 큽니다. {config.MAX_UPLOAD_MB}MB까지 넣을 수 있습니다.",
        )

    with db.ro() as conn:
        row = conn.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="없는 씬입니다.")

    store = get_storage()
    key = f"scenes/{row['board_id']}/{uuid4().hex}{ext}"
    store.save(key, file.file)
    mime = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"

    old = row["media_key"]
    with db.tx() as conn:
        conn.execute(
            """UPDATE scenes
               SET media_key = ?, media_kind = ?, media_name = ?, media_mime = ?,
                   media_size = ?, updated_at = ?
               WHERE id = ?""",
            (key, kind, (file.filename or "")[:200], mime, size, db.now(), scene_id),
        )
        touch_board(conn, row["board_id"])
        updated = conn.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone()
    if old and old != key:
        store.delete(old)
    return scene_json(updated)


@app.delete("/api/scenes/{scene_id}/media")
def clear_media(scene_id: int, user: sqlite3.Row = Depends(require_user)):
    store = get_storage()
    with db.tx() as conn:
        row = conn.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="없는 씬입니다.")
        conn.execute(
            """UPDATE scenes SET media_key = NULL, media_kind = NULL, media_name = NULL,
                                 media_mime = NULL, media_size = NULL, updated_at = ?
               WHERE id = ?""",
            (db.now(), scene_id),
        )
        touch_board(conn, row["board_id"])
        updated = conn.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone()
    if row["media_key"]:
        store.delete(row["media_key"])
    return scene_json(updated)


# ─────────────────────────────────────────────────────────────
# 코멘트
# ─────────────────────────────────────────────────────────────


@app.get("/api/scenes/{scene_id}/comments")
def list_comments(scene_id: int, user: sqlite3.Row = Depends(require_user)):
    with db.ro() as conn:
        rows = conn.execute(
            """SELECT c.*, u.name, u.color, u.avatar_key
               FROM comments c JOIN users u ON u.id = c.user_id
               WHERE c.scene_id = ? ORDER BY c.id""",
            (scene_id,),
        ).fetchall()
    return [comment_json(r) for r in rows]


@app.post("/api/scenes/{scene_id}/comments")
async def add_comment(scene_id: int, request: Request, user: sqlite3.Row = Depends(require_user)):
    payload = await read_json(request)
    body = str(payload.get("body", "")).strip()
    if not body:
        raise HTTPException(status_code=400, detail="내용을 입력해 주세요.")
    with db.tx() as conn:
        scene = conn.execute("SELECT board_id FROM scenes WHERE id = ?", (scene_id,)).fetchone()
        if scene is None:
            raise HTTPException(status_code=404, detail="없는 씬입니다.")
        cur = conn.execute(
            "INSERT INTO comments (scene_id, user_id, body, created_at) VALUES (?, ?, ?, ?)",
            (scene_id, user["id"], body[:4000], db.now()),
        )
        touch_board(conn, scene["board_id"])
        row = conn.execute(
            """SELECT c.*, u.name, u.color, u.avatar_key
               FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?""",
            (cur.lastrowid,),
        ).fetchone()
    return comment_json(row)


@app.delete("/api/comments/{comment_id}")
def delete_comment(comment_id: int, user: sqlite3.Row = Depends(require_user)):
    with db.tx() as conn:
        row = conn.execute("SELECT * FROM comments WHERE id = ?", (comment_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="없는 코멘트입니다.")
        if row["user_id"] != user["id"]:
            raise HTTPException(status_code=403, detail="자기가 쓴 코멘트만 지울 수 있습니다.")
        conn.execute("DELETE FROM comments WHERE id = ?", (comment_id,))
    return {"ok": True}


# ─────────────────────────────────────────────────────────────
# 미디어 전송 (영상 탐색을 위해 Range 요청 지원)
# ─────────────────────────────────────────────────────────────


def parse_range(header: str, size: int) -> Optional[tuple[int, int]]:
    """'bytes=0-1023' 를 (start, end) 로. 형식이 아니면 None, 범위 밖이면 ValueError."""
    if not header or not header.startswith("bytes="):
        return None
    spec = header[len("bytes=") :].split(",")[0].strip()
    if "-" not in spec:
        return None
    first, _, last = spec.partition("-")
    if first == "":
        if not last.isdigit():
            return None
        length = int(last)
        if length <= 0:
            raise ValueError("unsatisfiable")
        start, end = max(0, size - length), size - 1
    else:
        if not first.isdigit():
            return None
        start = int(first)
        end = int(last) if last.isdigit() else size - 1
        end = min(end, size - 1)
    if start > end or start >= size:
        raise ValueError("unsatisfiable")
    return start, end


@app.get("/media/{key:path}")
def serve_media(key: str, request: Request):
    # 프로필 사진은 로그인 화면에서도 보여야 하므로 초대 코드만 통과해도 열어 준다.
    if key.startswith("avatars/"):
        if current_user(request) is None and not has_gate(request):
            raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    else:
        require_user(request)

    store = get_storage()
    try:
        validate_key(key)
    except Exception:
        raise HTTPException(status_code=400, detail="잘못된 경로입니다.")
    if not store.exists(key):
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")

    external = store.public_url(key)
    if external:
        return RedirectResponse(external, status_code=307)

    size = store.size(key)
    mime = mimetypes.guess_type(key)[0] or "application/octet-stream"
    base_headers = {"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=604800"}

    try:
        rng = parse_range(request.headers.get("range", ""), size)
    except ValueError:
        return Response(
            status_code=416,
            headers={**base_headers, "Content-Range": f"bytes */{size}"},
        )

    if rng is None:
        return StreamingResponse(
            store.stream(key),
            media_type=mime,
            headers={**base_headers, "Content-Length": str(size)},
        )

    start, end = rng
    return StreamingResponse(
        store.stream(key, start, end),
        status_code=206,
        media_type=mime,
        headers={
            **base_headers,
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(end - start + 1),
        },
    )


# ─────────────────────────────────────────────────────────────
# 상태 / 정적 파일
# ─────────────────────────────────────────────────────────────


@app.get("/api/storage")
def storage_info(user: sqlite3.Row = Depends(require_user)):
    store = get_storage()
    if isinstance(store, LocalStorage):
        return {
            "backend": "local",
            "used_bytes": store.disk_usage(),
            "free_bytes": store.free_space(),
            "path": str(config.MEDIA_DIR),
        }
    return {"backend": config.STORAGE_BACKEND}


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import socket

    import uvicorn

    config.ensure_dirs()
    db.init()

    try:
        lan_ip = socket.gethostbyname(socket.gethostname())
    except OSError:
        lan_ip = "127.0.0.1"

    banner = "\n".join([
        "",
        "  영상 스토리보드",
        f"  내 PC        http://localhost:{config.PORT}",
        f"  같은 네트워크 http://{lan_ip}:{config.PORT}   ← 팀원에게 알려줄 주소",
        f"  초대 코드     {config.INVITE_CODE or '없음 (누구나 접속) — .env 의 INVITE_CODE 로 켤 수 있음'}",
        f"  저장 위치     {config.MEDIA_DIR}",
        "",
        "  이 창을 닫으면 서버도 꺼집니다.",
        "",
    ])
    try:
        print(banner, flush=True)
    except UnicodeEncodeError:
        # 콘솔 코드페이지가 한글을 못 찍는 경우엔 주소만이라도 보여 준다.
        print(f"\n  http://localhost:{config.PORT}\n  http://{lan_ip}:{config.PORT}\n", flush=True)

    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="info")
