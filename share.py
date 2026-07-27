"""밖에서도 접속할 수 있게 Cloudflare 터널을 열고 서버를 띄운다.

  python share.py     (또는 run-share.bat)

하는 일
  1. 초대 코드가 없으면 하나 만들어 .env 에 적어 둔다 (밖으로 열리니 잠가야 한다)
  2. cloudflared.exe 가 없으면 받아 온다 (약 18MB, 한 번만)
  3. 서버와 터널을 같이 켜고, 팀원에게 알려줄 https 주소를 찍어 준다

데이터는 이 폴더의 data/ 와 media/ 에 그대로 있다. 터널은 통로만 만들 뿐이다.
"""

from __future__ import annotations

import os
import platform
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import config

BASE_DIR = config.BASE_DIR
ENV_FILE = BASE_DIR / ".env"
BIN_DIR = BASE_DIR / "bin"

DOWNLOADS = {
    ("Windows", "AMD64"): "cloudflared-windows-amd64.exe",
    ("Windows", "ARM64"): "cloudflared-windows-arm64.exe",
    ("Darwin", "arm64"): "cloudflared-darwin-arm64.tgz",
    ("Darwin", "x86_64"): "cloudflared-darwin-amd64.tgz",
    ("Linux", "x86_64"): "cloudflared-linux-amd64",
    ("Linux", "aarch64"): "cloudflared-linux-arm64",
}
RELEASE_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/"
URL_PATTERN = re.compile(r"https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com")

WORDS = [
    "amber", "cobalt", "cedar", "delta", "ember", "flint", "grove", "harbor",
    "indigo", "juniper", "kelvin", "lumen", "marlin", "nimbus", "onyx", "pivot",
]


def say(message: str = "") -> None:
    try:
        print(message, flush=True)
    except UnicodeEncodeError:
        print(message.encode("ascii", "replace").decode("ascii"), flush=True)


# ─────────────────────────────────────────────────────────────
# 초대 코드
# ─────────────────────────────────────────────────────────────


def ensure_invite_code() -> str:
    """밖으로 열리는 만큼 코드 없이는 띄우지 않는다. 없으면 만들어서 .env 에 적는다."""
    if config.INVITE_CODE:
        return config.INVITE_CODE

    code = f"{secrets.choice(WORDS)}-{secrets.randbelow(9000) + 1000}"
    line = f"\n# 밖에서 접속할 때 쓰는 초대 코드 (share.py 가 자동으로 만들었습니다)\nINVITE_CODE={code}\n"

    existing = ENV_FILE.read_text(encoding="utf-8") if ENV_FILE.exists() else ""
    ENV_FILE.write_text(existing + line, encoding="utf-8")

    os.environ["INVITE_CODE"] = code
    config.INVITE_CODE = code
    say(f"  초대 코드를 새로 만들어 .env 에 적어 두었습니다: {code}")
    return code


# ─────────────────────────────────────────────────────────────
# cloudflared 준비
# ─────────────────────────────────────────────────────────────


def cloudflared_path() -> Path:
    key = (platform.system(), platform.machine())
    name = DOWNLOADS.get(key)
    if name is None:
        raise SystemExit(f"이 환경({key})에 맞는 cloudflared 를 모르겠습니다. 직접 받아 bin/ 에 넣어 주세요.")
    suffix = ".exe" if platform.system() == "Windows" else ""
    target = BIN_DIR / f"cloudflared{suffix}"

    if target.exists():
        return target
    if name.endswith(".tgz"):
        raise SystemExit(
            "macOS 는 자동 설치를 지원하지 않습니다. `brew install cloudflared` 로 설치해 주세요."
        )

    BIN_DIR.mkdir(parents=True, exist_ok=True)
    url = RELEASE_URL + name
    say("  cloudflared 를 받는 중입니다 (약 18MB, 처음 한 번만)...")
    try:
        with urllib.request.urlopen(url, timeout=120) as res, target.open("wb") as out:
            while chunk := res.read(1 << 16):
                out.write(chunk)
    except Exception as exc:
        if target.exists():
            target.unlink()
        raise SystemExit(
            f"  cloudflared 를 받지 못했습니다: {exc}\n"
            f"  회사 네트워크가 막고 있을 수 있습니다. 아래에서 직접 받아 bin/ 에 넣어 주세요.\n"
            f"  {url}"
        ) from exc

    if suffix == "":
        target.chmod(0o755)
    say("  받았습니다.")
    return target


# ─────────────────────────────────────────────────────────────
# 실행
# ─────────────────────────────────────────────────────────────


def wait_for_server(timeout: float = 30.0) -> bool:
    import socket

    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as sock:
            sock.settimeout(1)
            if sock.connect_ex(("127.0.0.1", config.PORT)) == 0:
                return True
        time.sleep(0.3)
    return False


def main() -> int:
    code = ensure_invite_code()
    exe = cloudflared_path()

    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "INVITE_CODE": code}
    server = subprocess.Popen([sys.executable, str(BASE_DIR / "main.py")], env=env, cwd=BASE_DIR)

    if not wait_for_server():
        server.terminate()
        say("  서버가 뜨지 않았습니다. 먼저 run.bat 으로 서버만 켜 보세요.")
        return 1

    tunnel = subprocess.Popen(
        [str(exe), "tunnel", "--no-autoupdate", "--url", f"http://localhost:{config.PORT}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        cwd=BASE_DIR,
    )

    found = threading.Event()

    def watch() -> None:
        for line in tunnel.stdout:
            match = URL_PATTERN.search(line)
            if match and not found.is_set():
                found.set()
                say("")
                say("  ┌─────────────────────────────────────────────────────")
                say("  │  팀원에게 이 주소와 코드를 알려주세요")
                say("  │")
                say(f"  │    주소   {match.group(0)}")
                say(f"  │    코드   {code}")
                say("  │")
                say("  │  이 창을 닫으면 주소가 사라집니다.")
                say("  │  다시 켜면 주소가 바뀌니 그때 다시 알려주세요.")
                say("  └─────────────────────────────────────────────────────")
                say("")
            elif "ERR" in line or "error" in line.lower():
                say(f"  [터널] {line.rstrip()}")

    threading.Thread(target=watch, daemon=True).start()

    if not found.wait(timeout=45):
        say("")
        say("  터널 주소를 받지 못했습니다. 회사 네트워크가 막고 있을 수 있습니다.")
        say(f"  같은 와이파이에서는 그대로 쓸 수 있습니다: http://localhost:{config.PORT}")

    try:
        server.wait()
    except KeyboardInterrupt:
        pass
    finally:
        for proc in (tunnel, server):
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
    except SystemExit as exc:
        if exc.code not in (0, None):
            say(str(exc.code) if not isinstance(exc.code, int) else "")
        raise
