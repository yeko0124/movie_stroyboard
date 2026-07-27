"""미디어 저장소.

지금은 로컬 폴더(media/)에 저장한다.
나중에 디스크가 부담되면 .env 에서 STORAGE_BACKEND=r2 로 바꾸고
R2 자격증명만 채우면 코드 수정 없이 Cloudflare R2로 옮겨간다.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import BinaryIO, Iterator, Optional

import config

CHUNK = 1024 * 512  # 512KB
_SAFE_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")


class StorageError(Exception):
    pass


def validate_key(key: str) -> str:
    """경로 탈출(../)이나 이상한 문자를 막는다."""
    if not key or ".." in key or key.startswith("/") or not _SAFE_KEY.match(key):
        raise StorageError(f"잘못된 저장소 키: {key!r}")
    return key


class Storage:
    """저장소 인터페이스."""

    def save(self, key: str, src: BinaryIO) -> int:
        raise NotImplementedError

    def exists(self, key: str) -> bool:
        raise NotImplementedError

    def size(self, key: str) -> int:
        raise NotImplementedError

    def stream(self, key: str, start: int = 0, end: Optional[int] = None) -> Iterator[bytes]:
        """[start, end] (양끝 포함) 구간을 조각내어 내보낸다."""
        raise NotImplementedError

    def delete(self, key: str) -> None:
        raise NotImplementedError

    def public_url(self, key: str) -> Optional[str]:
        """브라우저가 직접 받아갈 수 있는 URL. 없으면 None (서버가 중계한다)."""
        return None


class LocalStorage(Storage):
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        validate_key(key)
        return self.root / key

    def save(self, key: str, src: BinaryIO) -> int:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        written = 0
        with path.open("wb") as dst:
            while True:
                chunk = src.read(CHUNK)
                if not chunk:
                    break
                dst.write(chunk)
                written += len(chunk)
        return written

    def exists(self, key: str) -> bool:
        try:
            return self._path(key).is_file()
        except StorageError:
            return False

    def size(self, key: str) -> int:
        return self._path(key).stat().st_size

    def stream(self, key: str, start: int = 0, end: Optional[int] = None) -> Iterator[bytes]:
        path = self._path(key)
        total = path.stat().st_size
        last = total - 1 if end is None else min(end, total - 1)
        remaining = last - start + 1
        if remaining <= 0:
            return
        with path.open("rb") as f:
            f.seek(start)
            while remaining > 0:
                chunk = f.read(min(CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    def delete(self, key: str) -> None:
        try:
            self._path(key).unlink(missing_ok=True)
        except StorageError:
            pass

    def disk_usage(self) -> int:
        return sum(p.stat().st_size for p in self.root.rglob("*") if p.is_file())

    def free_space(self) -> int:
        return shutil.disk_usage(self.root).free


class R2Storage(Storage):
    """Cloudflare R2 (S3 호환). boto3 가 필요하다: pip install boto3

    주의: 이 백엔드는 R2 계정 없이는 실행해볼 수 없어 아직 실사용 검증을 하지 않았다.
    전환할 때 한 번 확인이 필요하다.
    """

    def __init__(self) -> None:
        try:
            import boto3  # noqa: F401
        except ImportError as exc:
            raise StorageError(
                "STORAGE_BACKEND=r2 를 쓰려면 boto3 가 필요합니다: pip install boto3"
            ) from exc
        import boto3

        missing = [
            name
            for name, value in (
                ("R2_ENDPOINT", config.R2_ENDPOINT),
                ("R2_BUCKET", config.R2_BUCKET),
                ("R2_ACCESS_KEY_ID", config.R2_ACCESS_KEY_ID),
                ("R2_SECRET_ACCESS_KEY", config.R2_SECRET_ACCESS_KEY),
            )
            if not value
        ]
        if missing:
            raise StorageError(f".env 에 다음 값이 필요합니다: {', '.join(missing)}")

        self.bucket = config.R2_BUCKET
        self.client = boto3.client(
            "s3",
            endpoint_url=config.R2_ENDPOINT,
            aws_access_key_id=config.R2_ACCESS_KEY_ID,
            aws_secret_access_key=config.R2_SECRET_ACCESS_KEY,
            region_name="auto",
        )

    def save(self, key: str, src: BinaryIO) -> int:
        validate_key(key)
        self.client.upload_fileobj(src, self.bucket, key)
        return self.size(key)

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=validate_key(key))
            return True
        except Exception:
            return False

    def size(self, key: str) -> int:
        head = self.client.head_object(Bucket=self.bucket, Key=validate_key(key))
        return int(head["ContentLength"])

    def stream(self, key: str, start: int = 0, end: Optional[int] = None) -> Iterator[bytes]:
        rng = f"bytes={start}-" if end is None else f"bytes={start}-{end}"
        obj = self.client.get_object(Bucket=self.bucket, Key=validate_key(key), Range=rng)
        yield from obj["Body"].iter_chunks(CHUNK)

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=validate_key(key))

    def public_url(self, key: str) -> Optional[str]:
        # 1시간짜리 임시 링크 — 브라우저가 R2에서 직접 받아간다.
        return self.client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": validate_key(key)},
            ExpiresIn=3600,
        )


_storage: Optional[Storage] = None


def get_storage() -> Storage:
    global _storage
    if _storage is None:
        if config.STORAGE_BACKEND == "r2":
            _storage = R2Storage()
        else:
            _storage = LocalStorage(config.MEDIA_DIR)
    return _storage
