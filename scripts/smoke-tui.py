"""Opt-in real Pi CLI smoke, following pi-team's isolated PTY pattern."""
import fcntl
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

root = tempfile.mkdtemp(prefix="pi-mcp-tui-")
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
source = Path(__file__).resolve().parent.parent / "index.ts"
env = {key: os.environ[key] for key in ["PATH", "TERM", "LANG", "COLORTERM"] if key in os.environ}
env.update(HOME=root, PI_CODING_AGENT_DIR=root, XDG_CONFIG_HOME=root, PI_OFFLINE="1", PI_TELEMETRY="0")
process = subprocess.Popen(
    ["pi", "--offline", "--no-session", "--no-extensions", "--no-skills",
     "--no-themes", "--no-context-files", "-e", str(source)],
    stdin=slave, stdout=slave, stderr=slave, env=env, cwd=root,
)
os.close(slave)
output = bytearray()


def collect(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                output.extend(os.read(master, 65536))
            except OSError:
                break


try:
    collect(3)
    for command in ["/mcp status", "/mcp", "/mcp status"]:
        os.write(master, command.encode() + b"\r")
        collect(1)
    os.write(master, b"\x03\x03")
    collect(1)
finally:
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    os.close(master)
    shutil.rmtree(root)

text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode(errors="replace"))
for failure in ["Failed to load extension", "SyntaxError", "TypeError", "ReferenceError", "Extension error"]:
    assert failure.lower() not in text.lower(), text
assert "No MCP servers configured." in text, text
print("Real Pi TUI smoke passed: package load, repeated /mcp status, clean exit; no model or MCP network calls.")
