"""Unit tests for cr-trace-fold.py: python3 -m unittest sandbox/e2b/guest/test_trace_fold.py"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest

FOLD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cr-trace-fold.py")

TRACE = """100 1.0 execve("/usr/bin/env", ["env"], 0x1 /* 3 vars */) = 0
100 1.1 execve("/bin/bash", ["bash"], 0x1 /* 3 vars */) = 0
100 1.2 clone(child_stack=NULL, flags=SIGCHLD) = 101
101 1.3 execve("/usr/local/bin/pnpm", ["pnpm"], 0x1 /* 3 vars */) = 0
101 1.4 clone3({flags=CLONE_VM|CLONE_THREAD}, 88) = 102
102 1.5 openat(AT_FDCWD, "/home/cr/.local/share/pnpm/store/v10/files/aa/bb", O_WRONLY|O_CREAT, 0644) = 7
102 1.6 openat(AT_FDCWD, "/work/src/node_modules/.pnpm/x/index.js", O_WRONLY|O_CREAT, 0644) = 8
102 1.65 openat(AT_FDCWD, "/home/cr/.aws/credentials", O_RDONLY) = 9
103 1.7 openat(AT_FDCWD, "/work/src/early.js", O_RDONLY) = 3
101 1.8 vfork( <unfinished ...>
103 1.9 execve("/bin/sh", ["sh", "-c", "node install.js"], 0x1 /* 3 vars */) = 0
101 2.0 <... vfork resumed>) = 103
103 2.1 clone(child_stack=NULL, flags=SIGCHLD) = 104
104 2.2 execve("/usr/bin/node", ["node", "install.js"], 0x1 /* 3 vars */) = 0
104 2.3 openat(AT_FDCWD, "/work/src/node_modules/evil/payload", O_WRONLY|O_CREAT, 0644) = 3
101 2.4 connect(9, {sa_family=AF_INET, sin_port=htons(443)}, 16) = 0
"""


class FoldTests(unittest.TestCase):
    def test_folds_package_manager_files_and_keeps_scripts(self):
        with tempfile.TemporaryDirectory() as d:
            t, j = os.path.join(d, "trace.install"), os.path.join(d, "folded.json")
            with open(t, "w") as f:
                f.write(TRACE)
            subprocess.run([sys.executable, FOLD, t, "/home/cr", j], check=True, capture_output=True)
            out = open(t).read()
            info = json.load(open(j))
        self.assertEqual(info["folded"], 2)
        self.assertNotIn("pnpm/store", out)
        self.assertNotIn(".pnpm/x/index.js", out)
        self.assertIn("/home/cr/.aws/credentials", out, "a decoy read by the package manager stays")
        self.assertIn("/work/src/early.js", out, "a process seen before its clone returned is never folded")
        self.assertIn("evil/payload", out, "a script's writes stay")
        self.assertIn("connect(", out)
        self.assertIn('execve("/bin/sh"', out)


if __name__ == "__main__":
    unittest.main()
