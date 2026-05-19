#!/usr/bin/env python3
"""
scripts/prepare_pip.py

Copies the project assets into video_forger/assets/ so they are bundled
with the pip wheel. Run this before `python -m build`.

Usage:
    python scripts/prepare_pip.py
"""
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent.resolve()
ASSETS_DEST = PROJECT_ROOT / "video_forger" / "assets"

# Files and directories to bundle with the pip package
INCLUDE_FILES = [
    "docker-compose.yml",
    "Dockerfile",
    "server.js",
    "mcp-server.js",
    "mcp-docker-bridge.sh",
    "start.sh",
    "index.html",
    "package.json",
    "remotion.config.ts",
    "tsconfig.json",
    "index.ts",
    "MCPForgerVideo.tsx",
]

INCLUDE_DIRS = [
    "src",
    "public",
]

# Paths to always exclude when recursively copying directories
EXCLUDE_PATTERNS = {
    "node_modules",
    ".git",
    "dist",
    "__pycache__",
    ".DS_Store",
    "project_mnts",
    "video_forger",
    "scripts",
}


def copy_dir(src: Path, dest: Path) -> int:
    """Recursively copy src → dest, skipping excluded names. Returns file count."""
    dest.mkdir(parents=True, exist_ok=True)
    count = 0
    for item in src.iterdir():
        if item.name in EXCLUDE_PATTERNS:
            continue
        dst = dest / item.name
        if item.is_dir():
            count += copy_dir(item, dst)
        else:
            shutil.copy2(item, dst)
            count += 1
    return count


def main() -> None:
    if ASSETS_DEST.exists():
        print(f"🗑️   Removing old assets: {ASSETS_DEST}")
        shutil.rmtree(ASSETS_DEST)

    ASSETS_DEST.mkdir(parents=True)
    total = 0

    for name in INCLUDE_FILES:
        src = PROJECT_ROOT / name
        if not src.exists():
            print(f"  ⚠️   Skipping missing file: {name}")
            continue
        shutil.copy2(src, ASSETS_DEST / name)
        total += 1

    for name in INCLUDE_DIRS:
        src = PROJECT_ROOT / name
        if not src.exists():
            print(f"  ⚠️   Skipping missing directory: {name}")
            continue
        n = copy_dir(src, ASSETS_DEST / name)
        total += n
        print(f"  📂  {name}/ → {n} files")

    # Make scripts executable in the asset copy
    for script in ["start.sh", "mcp-docker-bridge.sh"]:
        p = ASSETS_DEST / script
        if p.exists():
            p.chmod(p.stat().st_mode | 0o755)

    print(f"\n✅  Prepared {total} files in {ASSETS_DEST}")
    print("   Next: python -m build")


if __name__ == "__main__":
    main()
