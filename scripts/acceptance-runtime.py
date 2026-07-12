#!/usr/bin/env python3
import json
import platform
import select
import subprocess
import sys
import tempfile
import time
from pathlib import Path

root = Path(__file__).resolve().parent.parent
runtime = root / "Runtime" / "PiEngine"
arch = "arm64" if platform.machine() == "arm64" else "x64"
node = runtime / f"node-darwin-{arch}" / "bin" / "node"
cli = runtime / "node_modules" / "@earendil-works" / "pi-coding-agent" / "dist" / "cli.js"
versions = json.loads((runtime / "versions.json").read_text())

with tempfile.TemporaryDirectory() as home:
    environment = {
        "HOME": home,
        "PATH": "/usr/bin:/bin",
        "PI_OFFLINE": "1",
        "PI_SKIP_VERSION_CHECK": "1",
        "PI_TELEMETRY": "0",
    }
    process = subprocess.Popen(
        [str(node), str(cli), "--mode", "rpc", "--no-session", "--no-approve", "--offline",
         "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"],
        cwd=home,
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    process.stdin.write(b'{"id":"acceptance","type":"get_state"}\n')
    process.stdin.flush()
    deadline = time.monotonic() + 15
    response = None
    while time.monotonic() < deadline:
        ready, _, _ = select.select([process.stdout], [], [], 0.25)
        if not ready:
            if process.poll() is not None:
                break
            continue
        record = json.loads(process.stdout.readline())
        if record.get("id") == "acceptance":
            response = record
            break
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
    if not response or not response.get("success"):
        sys.exit(f"RPC startup failed: {response!r}\n{process.stderr.read().decode(errors='replace')}")

    actual_node = subprocess.check_output([node, "--version"], text=True).strip().removeprefix("v")
    actual_pi = subprocess.check_output([node, cli, "--version"], env=environment, text=True).strip()
    assert actual_node == versions["node"], (actual_node, versions["node"])
    assert actual_pi == versions["pi"], (actual_pi, versions["pi"])
    print(f"Bundled Pi {actual_pi} on Node {actual_node} ({arch}) started without PATH lookup.")
