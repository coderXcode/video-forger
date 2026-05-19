"""
video_forger.cli — CLI entry point for the Video Forger pip package.

Usage:
    video-forger [start]   Initialize project files (if needed) and run start.sh
    video-forger init      Copy project files into the current directory only
    video-forger stop      Stop the running Docker container
"""
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ASSETS_DIR = Path(__file__).parent / "assets"


def _check_docker() -> None:
    if not shutil.which("docker"):
        print("❌  Docker not found. Install Docker Desktop: https://www.docker.com/products/docker-desktop")
        sys.exit(1)


def _copy_assets(dest: Path) -> None:
    """Copy bundled project assets into dest (skips existing files)."""
    if not ASSETS_DIR.exists():
        print("❌  Package assets not found. Re-install with: pip install --force-reinstall video-forger")
        sys.exit(1)

    dest.mkdir(parents=True, exist_ok=True)
    copied = []
    for item in ASSETS_DIR.rglob("*"):
        rel = item.relative_to(ASSETS_DIR)
        dst = dest / rel
        if item.is_dir():
            dst.mkdir(parents=True, exist_ok=True)
        elif not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, dst)
            copied.append(str(rel))

    # Make shell scripts executable
    for script in ["start.sh", "mcp-docker-bridge.sh"]:
        p = dest / script
        if p.exists():
            p.chmod(p.stat().st_mode | 0o755)

    if copied:
        print(f"✅  Initialized {len(copied)} project files in: {dest}")
    else:
        print(f"ℹ️   Project files already present in: {dest}")


def cmd_start(dest: Path) -> None:
    _check_docker()
    _copy_assets(dest)
    start_sh = dest / "start.sh"
    if not start_sh.exists():
        print("❌  start.sh not found after asset copy — package may be corrupt.")
        sys.exit(1)
    os.chdir(dest)
    os.execv("/bin/bash", ["bash", str(start_sh)])


def cmd_init(dest: Path) -> None:
    _copy_assets(dest)
    print(f"   Run: video-forger start")


def cmd_stop(dest: Path) -> None:
    dc_file = dest / "docker-compose.yml"
    if not dc_file.exists():
        print(f"❌  No docker-compose.yml found in {dest}. Run `video-forger init` first.")
        sys.exit(1)
    os.chdir(dest)
    result = subprocess.run(["docker", "compose", "down"], check=False)
    if result.returncode == 0:
        print("✅  Video Forger stopped.")
    else:
        # Fallback to docker-compose v1
        subprocess.run(["docker-compose", "down"], check=False)


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="video-forger",
        description="Video Forger — AI-powered programmatic video generation platform",
    )
    parser.add_argument(
        "command",
        nargs="?",
        default="start",
        choices=["start", "init", "stop"],
        help="Command to run (default: start)",
    )
    parser.add_argument(
        "--dir",
        default=".",
        metavar="PATH",
        help="Working directory for the project (default: current directory)",
    )
    args = parser.parse_args()
    dest = Path(args.dir).resolve()

    if args.command == "start":
        cmd_start(dest)
    elif args.command == "init":
        cmd_init(dest)
    elif args.command == "stop":
        cmd_stop(dest)


if __name__ == "__main__":
    main()
