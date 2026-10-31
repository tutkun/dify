#!/usr/bin/env python3
"""Install the pinned, unmodified official SIWC SDK outside the Dify dependency tree."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tarfile

COMMIT = "0a36fefeb913055c8c7a1a29b63d82b96b2e841a"
SHA256 = "b7da19d0f72a3e04312d1a131aebc4c095094a198ffe5e9b78f6c4b5a6907d4b"
ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Use an already downloaded archive (same SHA256 required).")
    args = parser.parse_args()
    runtime = ROOT / ".runtime"
    runtime.mkdir(mode=0o700, exist_ok=True)
    archive = args.archive or runtime / "sdk.tar.gz"
    if not args.archive:
        subprocess.run(["curl", "-fL", "--max-time", "120", "--proto", "=https", "--tlsv1.2",
                        f"https://codeload.github.com/openai/sign-in-with-chatgpt-devkit/tar.gz/{COMMIT}", "-o", str(archive)], check=True)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        raise SystemExit("SDK archive checksum mismatch; installation stopped.")
    sdk = runtime / "sdk"
    if not sdk.exists():
        staging = runtime / "sdk-extract"
        staging.mkdir(exist_ok=True)
        with tarfile.open(archive) as bundle:
            bundle.extractall(staging, filter="data")
        (staging / f"sign-in-with-chatgpt-devkit-{COMMIT}").rename(sdk)
        staging.rmdir()
    import os
    env = {**os.environ, "npm_config_cache": str(runtime / "npm-cache")}
    subprocess.run(["npm", "ci", "--workspace", "@siwc/local", "--include-workspace-root", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=sdk, env=env, check=True)
    subprocess.run(["npm", "run", "build", "--workspace", "@siwc/local"], cwd=sdk, env=env, check=True)
    print("Official SDK installed and built at", COMMIT)
    print("SDK license:", sdk / "LICENSE")
    subprocess.run([shutil.which("node") or "node", str(ROOT / "manage.mjs"), "setup"], check=True)


if __name__ == "__main__":
    main()
