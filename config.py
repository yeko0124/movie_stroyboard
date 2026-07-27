"""프로젝트 설정.

모든 경로는 이 파일이 있는 폴더(프로젝트 루트) 기준이다.
폴더를 통째로 다른 PC로 옮겨도 그대로 동작한다.
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


def _load_dotenv() -> None:
    """.env 파일이 있으면 환경변수로 읽어들인다. (외부 라이브러리 없이)"""
    env_file = BASE_DIR / ".env"
    if not env_file.exists():
        return
    for raw in env_file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()


def _path(env_key: str, default: Path) -> Path:
    raw = os.environ.get(env_key)
    if not raw:
        return default
    p = Path(raw)
    return p if p.is_absolute() else (BASE_DIR / p)


# 팀에 공유할 초대 코드.
# 비워 두면(기본값) 코드 없이 바로 들어온다. .env 에서 값을 넣으면 그때부터 코드를 묻는다.
INVITE_CODE = os.environ.get("INVITE_CODE", "").strip()

# 서버 주소. 0.0.0.0 이면 같은 네트워크의 다른 PC에서도 접속 가능하다.
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))

# 데이터 위치 (기본값: 프로젝트 폴더 안)
DATA_DIR = _path("DATA_DIR", BASE_DIR / "data")
MEDIA_DIR = _path("MEDIA_DIR", BASE_DIR / "media")
DB_PATH = DATA_DIR / "storyboard.db"
SECRET_PATH = DATA_DIR / "secret.key"

# 업로드 한 파일당 최대 용량 (MB)
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "2048"))

# 로그인 유지 기간 (일)
SESSION_DAYS = int(os.environ.get("SESSION_DAYS", "30"))

# 저장소 백엔드: "local" | "r2"
# 로컬 디스크가 부담되면 Cloudflare R2로 바꾸면 된다. (.env 에서 아래 값만 채우기)
STORAGE_BACKEND = os.environ.get("STORAGE_BACKEND", "local").lower()
R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "")
R2_BUCKET = os.environ.get("R2_BUCKET", "")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_ENDPOINT = os.environ.get(
    "R2_ENDPOINT",
    f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com" if R2_ACCOUNT_ID else "",
)


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)


def secret_key() -> bytes:
    """쿠키 서명용 키. 없으면 만들어서 data/secret.key 에 저장한다."""
    ensure_dirs()
    if not SECRET_PATH.exists():
        SECRET_PATH.write_bytes(os.urandom(32))
    return SECRET_PATH.read_bytes()
