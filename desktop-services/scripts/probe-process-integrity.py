"""Read process token metadata only; never changes tokens or sends input."""
import ctypes as c
import json
import sys
from ctypes import wintypes as w

k = c.WinDLL("kernel32", use_last_error=True)
a = c.WinDLL("advapi32", use_last_error=True)
k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
k.OpenProcess.restype = w.HANDLE
k.CloseHandle.argtypes = [w.HANDLE]
a.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, c.POINTER(w.HANDLE)]
a.GetTokenInformation.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.POINTER(w.DWORD)]
a.GetSidSubAuthorityCount.argtypes = [c.c_void_p]
a.GetSidSubAuthorityCount.restype = c.POINTER(c.c_ubyte)
a.GetSidSubAuthority.argtypes = [c.c_void_p, w.DWORD]
a.GetSidSubAuthority.restype = c.POINTER(w.DWORD)

for value in sys.argv[1:]:
    pid = int(value)
    process = k.OpenProcess(0x1000, False, pid)
    token = w.HANDLE()
    try:
        if not process or not a.OpenProcessToken(process, 8, c.byref(token)):
            raise c.WinError(c.get_last_error())
        length = w.DWORD()
        a.GetTokenInformation(token, 25, None, 0, c.byref(length))
        buffer = c.create_string_buffer(length.value)
        if not a.GetTokenInformation(token, 25, buffer, length, c.byref(length)):
            raise c.WinError(c.get_last_error())
        sid = c.cast(buffer, c.POINTER(c.c_void_p))[0]
        rid = a.GetSidSubAuthority(sid, a.GetSidSubAuthorityCount(sid)[0] - 1)[0]
        print(json.dumps({"pid": pid, "integrityRid": rid}))
    except OSError as error:
        print(json.dumps({"pid": pid, "error": error.winerror}))
    finally:
        if token:
            k.CloseHandle(token)
        if process:
            k.CloseHandle(process)
