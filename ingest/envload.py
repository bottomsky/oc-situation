"""项目内的 .env 读取，供采集器与 API 客户端共用。"""

from __future__ import annotations

import os
from pathlib import Path


def load_dotenv() -> None:
    """读取项目根目录的 .env.local / .env，已存在的环境变量优先。"""
    roots = [Path(__file__).resolve().parent.parent, Path.cwd()]
    seen: set[Path] = set()
    for root in roots:
        for name in (".env.local", ".env"):
            path = root / name
            if path in seen or not path.is_file():
                continue
            seen.add(path)
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
