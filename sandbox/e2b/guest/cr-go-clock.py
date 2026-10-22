#!/usr/bin/env python3
"""Put the sandbox's sped-up clock into the template's Go runtime.

usage: cr-go-clock.py <GOROOT>

libfaketime (LD_PRELOAD) speeds up the clock for everything that reads it through
the C library. Go code does not: the runtime reads the time from the vDSO in
assembly, and a Go binary is usually static, so the preload never reaches it.
Every Go program a scan runs is compiled in the sandbox by this GOROOT, so the
same clock goes into the runtime source instead:

  * FAKETIME (the variable cr-detonate.sh sets for libfaketime, "+0 x<rate>") is
    read once at start-up, right after the runtime reads the environment.
  * The monotonic clock (nanotime, behind time.Since, timers and the scheduler)
    and the wall clock (time.Now) run <rate> times fast from that moment.
  * A wait the runtime hands to the kernel (epoll_wait in netpoll, futex in
    futexsleep) is divided by <rate>, so time.Sleep, timers and timeouts end
    <rate> times sooner in real time, as they do under libfaketime.

Without FAKETIME, or with a rate of 1, nothing changes. Every edit asserts the
exact source it replaces, so a changed Go release fails the template build
instead of building an unpatched runtime.
"""

from __future__ import annotations

import os
import sys

CR_CLOCK = '''// Code added by ClaudeRabbit (sandbox/e2b/guest/cr-go-clock.py): the sandbox's
// sped-up clock. Rate 0 means the real clock.

package runtime

var crClockRate int64
var crMonoBase int64
var crWallBase int64

// crClockInit reads the rate from FAKETIME ("+0 x30" gives 30). It runs in
// schedinit right after goenvs, while the program is still single-threaded.
func crClockInit() {
	s := gogetenv("FAKETIME")
	i := 0
	for i < len(s) && s[i] != 'x' {
		i++
	}
	if i >= len(s) {
		return
	}
	var r int64
	for j := i + 1; j < len(s) && s[j] >= '0' && s[j] <= '9'; j++ {
		r = r*10 + int64(s[j]-'0')
		if r > 100000 {
			return
		}
	}
	if r <= 1 {
		return
	}
	crMonoBase = nanotime1()
	crWallBase = crWallNow()
	crClockRate = r
}

// crWait turns a wait in sped-up nanoseconds into real nanoseconds.
//
//go:nosplit
func crWait(ns int64) int64 {
	if r := crClockRate; r > 1 && ns > 0 {
		ns /= r
		if ns == 0 {
			ns = 1
		}
	}
	return ns
}
'''

CR_CLOCK_AMD64 = '''// Code added by ClaudeRabbit (sandbox/e2b/guest/cr-go-clock.py).

//go:build !faketime

package runtime

import _ "unsafe" // for go:linkname

// crTimeNowRaw is the vDSO time.now assembly in time_linux_amd64.s, renamed.
func crTimeNowRaw() (sec int64, nsec int32, mono int64)

//go:nosplit
func crWallNow() int64 {
	sec, nsec, _ := crTimeNowRaw()
	return sec*1e9 + int64(nsec)
}

//go:linkname time_now time.now
//go:nosplit
func time_now() (sec int64, nsec int32, mono int64) {
	sec, nsec, mono = crTimeNowRaw()
	if r := crClockRate; r > 1 {
		w := crWallBase + (sec*1e9+int64(nsec)-crWallBase)*r
		sec, nsec = w/1e9, int32(w%1e9)
		mono = crMonoBase + (mono-crMonoBase)*r
	}
	return sec, nsec, mono
}
'''

CR_CLOCK_OTHER = '''// Code added by ClaudeRabbit (sandbox/e2b/guest/cr-go-clock.py). The sped-up
// wall clock is wired for linux/amd64 only, the sandbox's platform.

//go:build !(linux && amd64) || faketime

package runtime

func crWallNow() int64 { return 0 }
'''


def edit(path: str, old: str, new: str) -> None:
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    if src.count(old) != 1:
        raise SystemExit(f"cr-go-clock: {os.path.basename(path)}: expected exactly one {old!r}, found {src.count(old)}")
    with open(path, "w", encoding="utf-8") as f:
        f.write(src.replace(old, new))


def main(goroot: str) -> None:
    rt = os.path.join(goroot, "src", "runtime")
    j = lambda name: os.path.join(rt, name)  # noqa: E731
    # time.now on linux/amd64: the assembly becomes crTimeNowRaw, wrapped in Go.
    edit(j("time_linux_amd64.s"), "TEXT time·now<ABIInternal>(SB)", "TEXT runtime·crTimeNowRaw<ABIInternal>(SB)")
    edit(j("timeasm.go"), "//go:build !faketime && (windows || (linux && amd64))", "//go:build !faketime && windows")
    # The monotonic clock behind timers, the scheduler and time.Since.
    edit(j("time_nofake.go"), "func nanotime() int64 {\n\treturn nanotime1()\n}",
         "func nanotime() int64 {\n\tif r := crClockRate; r > 1 {\n\t\treturn crMonoBase + (nanotime1()-crMonoBase)*r\n\t}\n\treturn nanotime1()\n}")
    # Waits handed to the kernel end <rate> times sooner.
    edit(j("netpoll_epoll.go"), "func netpoll(delay int64) (gList, int32) {\n", "func netpoll(delay int64) (gList, int32) {\n\tdelay = crWait(delay)\n")
    edit(j("os_linux.go"), "\tvar ts timespec\n\tts.setNsec(ns)\n\tfutex(unsafe.Pointer(addr), _FUTEX_WAIT_PRIVATE, val, &ts, nil, 0)",
         "\tvar ts timespec\n\tts.setNsec(crWait(ns))\n\tfutex(unsafe.Pointer(addr), _FUTEX_WAIT_PRIVATE, val, &ts, nil, 0)")
    edit(j("proc.go"), "\tgoargs()\n\tgoenvs()\n", "\tgoargs()\n\tgoenvs()\n\tcrClockInit()\n")
    for name, body in (("cr_clock.go", CR_CLOCK), ("cr_clock_linux_amd64.go", CR_CLOCK_AMD64), ("cr_clock_other.go", CR_CLOCK_OTHER)):
        with open(j(name), "w", encoding="utf-8") as f:
            f.write(body)
    print("cr-go-clock: runtime patched")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
