"""Attach the Windows ZIP and checksum to the matching stable GitHub release.

Only the tiny checksum file is downloaded, never the Mac DMG.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def gh(*args):
    return subprocess.run(["gh", *args], check=True, text=True, capture_output=True).stdout


def main():
    repo = sys.argv[1]
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        raise SystemExit("Invalid repository")
    root = Path(__file__).resolve().parent.parent
    version = json.loads((root / "desktop/package.json").read_text())["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SystemExit("Expected a stable semantic version")
    name = f"Dictait-{version}-windows-x64.zip"
    artifact = root / "dist/release" / name
    with artifact.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    release = json.loads(gh("release", "view", f"v{version}", "--repo", repo, "--json", "isDraft,isPrerelease"))
    if release["isDraft"] or release["isPrerelease"]:
        raise SystemExit("Publish the Mac/Linux stable release first")
    with tempfile.TemporaryDirectory() as temporary:
        gh("release", "download", f"v{version}", "--repo", repo, "--pattern", "SHA256SUMS.txt", "--dir", temporary)
        checksum = Path(temporary) / "SHA256SUMS.txt"
        lines = [line for line in checksum.read_text().splitlines() if line.split()[-1:] != [name]]
        checksum.write_text("\n".join([*lines, f"{digest}  {name}"]) + "\n", encoding="utf-8")
        gh("release", "upload", f"v{version}", str(artifact), "--repo", repo, "--clobber")
        gh("release", "upload", f"v{version}", str(checksum), "--repo", repo, "--clobber")
    print(f"Published {name} to v{version}")


if __name__ == "__main__":
    main()
