"""Win32 process creation with an explicit desktop and suspended ownership.

Python subprocess.STARTUPINFO does not forward lpDesktop. Use pywin32's
complete STARTUPINFO and assign the job before any child instruction runs.
"""
import io
import msvcrt
import os
import subprocess
import sys

import pywintypes
import win32api
import win32con
import win32event
import win32job
import win32pipe
import win32process


class NativeProcess:
    def __init__(self, handle, pid, stdin=None, stdout=None):
        self.handle, self.pid = handle, pid
        self.stdin, self.stdout = stdin, stdout

    def terminate(self):
        if win32process.GetExitCodeProcess(self.handle) == win32con.STILL_ACTIVE:
            win32api.TerminateProcess(self.handle, 1)

    kill = terminate

    def poll(self):
        code = win32process.GetExitCodeProcess(self.handle)
        return None if code == win32con.STILL_ACTIVE else code

    def wait(self):
        win32event.WaitForSingleObject(self.handle, win32event.INFINITE)
        code = win32process.GetExitCodeProcess(self.handle)
        self.handle.Close()
        return code


def launch(arguments, desktop, environment=None, cwd=None, job=None, pipes=False):
    startup = win32process.STARTUPINFO()
    startup.lpDesktop = "winsta0\\" + desktop
    startup.dwFlags = win32con.STARTF_USESTDHANDLES if pipes else 0
    security = pywintypes.SECURITY_ATTRIBUTES()
    security.bInheritHandle = True
    close = []
    parent_input = parent_output = None
    process = thread = None
    try:
        current = win32api.GetCurrentProcess()
        if pipes:
            error = win32api.DuplicateHandle(current, msvcrt.get_osfhandle(sys.stderr.fileno()), current, 0, True, win32con.DUPLICATE_SAME_ACCESS)
            close.append(error)
            startup.hStdError = error
            child_input, parent_input = win32pipe.CreatePipe(security, 0)
            parent_output, child_output = win32pipe.CreatePipe(security, 0)
            close.extend([child_input, child_output])
            win32api.SetHandleInformation(parent_input, win32con.HANDLE_FLAG_INHERIT, 0)
            win32api.SetHandleInformation(parent_output, win32con.HANDLE_FLAG_INHERIT, 0)
            startup.hStdInput, startup.hStdOutput = child_input, child_output
        process, thread, pid, _ = win32process.CreateProcess(str(arguments[0]), subprocess.list2cmdline(arguments),
            None, None, pipes, win32con.CREATE_SUSPENDED | win32con.CREATE_NO_WINDOW,
            environment or os.environ.copy(), cwd, startup)
        if job is not None:
            win32job.AssignProcessToJobObject(job, process)
        win32process.ResumeThread(thread)
        stdin = stdout = None
        if pipes:
            stdin = io.TextIOWrapper(os.fdopen(msvcrt.open_osfhandle(parent_input.Detach(), os.O_WRONLY), "wb", buffering=0), encoding="utf-8", write_through=True)
            stdout = io.TextIOWrapper(os.fdopen(msvcrt.open_osfhandle(parent_output.Detach(), os.O_RDONLY), "rb", buffering=0), encoding="utf-8")
        return NativeProcess(process, pid, stdin, stdout)
    except Exception:
        if process:
            win32api.TerminateProcess(process, 1)
            process.Close()
        if parent_input:
            parent_input.Close()
        if parent_output:
            parent_output.Close()
        raise
    finally:
        if thread:
            thread.Close()
        for handle in close:
            handle.Close()
