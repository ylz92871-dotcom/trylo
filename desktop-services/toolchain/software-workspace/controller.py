"""Own the hidden desktop and its kill-on-close process job from Default."""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import uuid

import win32api
import win32con
import win32gui
import win32job
import win32process
from native import USER
from launcher import launch


def main():
    name = "TryloSoftware_" + uuid.uuid4().hex
    desktop = USER.CreateDesktopW(name, None, None, 0, win32con.GENERIC_ALL, None)
    if not desktop:
        raise ctypes_error()
    job = win32job.CreateJobObject(None, name)
    worker = None
    done = threading.Event()
    output_lock = threading.Lock()

    def write(value):
        with output_lock:
            print(json.dumps(value, ensure_ascii=False), flush=True)

    def belongs(pid):
        try:
            handle = win32api.OpenProcess(win32con.PROCESS_QUERY_INFORMATION, False, pid)
            try:
                return win32job.IsProcessInJob(handle, job)
            finally:
                handle.Close()
        except Exception:
            return False  # Exited processes have no live windows to isolate.

    try:
        limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
        limits["BasicLimitInformation"]["LimitFlags"] |= win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)
        environment = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"}
        worker = launch([sys.executable, "-B", "-u", str(Path(__file__).with_name("worker.py"))], name,
                        environment=environment, job=job, pipes=True)
        # The worker waits for this bootstrap before it can launch anything.
        worker.stdin.write(json.dumps({"desktop": name, "ownerPids": [os.getpid(), os.getppid(), worker.pid]}) + "\n")
        worker.stdin.flush()

        def receive():
            for line in worker.stdout:
                with output_lock:
                    sys.stdout.write(line)
                    sys.stdout.flush()
            done.set()

        def commands():
            try:
                for line in sys.stdin:
                    message = json.loads(line)
                    message["ownedPids"] = list(win32job.QueryInformationJobObject(job, win32job.JobObjectBasicProcessIdList))
                    worker.stdin.write(json.dumps(message) + "\n")
                    worker.stdin.flush()
            finally:
                done.set()

        threading.Thread(target=receive, daemon=True).start()
        threading.Thread(target=commands, daemon=True).start()
        while not done.wait(0.25):
            leaked = []

            def inspect(hwnd, _):
                if win32gui.IsWindowVisible(hwnd) and belongs(win32process.GetWindowThreadProcessId(hwnd)[1]):
                    leaked.append(hwnd)
                return True

            win32gui.EnumWindows(inspect, None)
            if leaked:
                write({"event": "isolationFailure", "error": "软件尝试离开后台工作区，已停止该工作区；没有接管当前桌面。"})
                break
    finally:
        job.Close()
        if worker:
            worker.wait()
        USER.CloseDesktop(desktop)


def ctypes_error():
    import ctypes
    return ctypes.WinError(ctypes.get_last_error())


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"event": "fatal", "error": str(error)}, ensure_ascii=False), flush=True)
        sys.exit(1)
