#!/usr/bin/env python3
"""Run the deterministic unit suite and enforce its reviewed VDL baseline."""

import os
import sys
import threading
import trace
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
VDL_PATH = os.path.join(ROOT, "vdl.py")
MINIMUM_PERCENT = 90.0


def run_suite():
    suite = unittest.defaultTestLoader.discover(
        os.path.join(ROOT, "tests"),
        pattern="test_*.py",
        top_level_dir=ROOT,
    )
    return unittest.TextTestRunner(verbosity=2).run(suite)


def main():
    tracer = trace.Trace(
        count=True,
        trace=False,
        ignoredirs=[sys.prefix, sys.exec_prefix],
    )
    previous_thread_trace = threading.gettrace()
    threading.settrace(tracer.globaltrace)
    try:
        result = tracer.runfunc(run_suite)
    finally:
        threading.settrace(previous_thread_trace)

    counts = tracer.results().counts
    executed = {
        line for (filename, line), count in counts.items()
        if os.path.abspath(filename) == VDL_PATH and count
    }
    executable = set(trace._find_executable_linenos(VDL_PATH))
    percent = 100.0 * len(executed & executable) / len(executable)
    print(
        f"vdl.py line coverage: {percent:.1f}% "
        f"({len(executed & executable)}/{len(executable)}; "
        f"minimum {MINIMUM_PERCENT:.1f}%)"
    )

    if not result.wasSuccessful():
        return 1
    if percent < MINIMUM_PERCENT:
        print("Coverage baseline was not met.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
