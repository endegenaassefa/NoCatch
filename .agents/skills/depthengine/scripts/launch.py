"""Do not begin work until the coordinator has durably recorded our identity."""
import os
from pathlib import Path
import sys
import time
import subprocess
from adapters import identity, terminate_owned

gate = Path(sys.argv[1])
deadline = time.monotonic() + 10
while not gate.exists():
    if time.monotonic() >= deadline or os.getppid() == 1:
        sys.exit(75)
    time.sleep(0.05)
# The timeout survives coordinator death. Descendants remain in this session so
# recovery can identify them; the direct command gets its own process group.
process = subprocess.Popen(sys.argv[3:], preexec_fn=os.setpgrp)
try:
    code = process.wait(timeout=float(sys.argv[2]))
except subprocess.TimeoutExpired:
    code = 124
if not terminate_owned(os.getpid(), identity(os.getpid()), keep_leader=True):
    code = 125
try:
    process.wait(timeout=3)
except subprocess.TimeoutExpired:
    code = 125
sys.exit(code if code >= 0 else 128 - code)
