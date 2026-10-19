import { execFile } from 'node:child_process';
import path from 'node:path';

// Query our own token only. This does not send input, change a token or prompt
// for elevation. TokenElevation alone does not reveal Low integrity.
export const WINDOWS_INPUT_ACCESS_PROBE = String.raw`
import ctypes as c, json, sys
from ctypes import wintypes as w
k=c.WinDLL('kernel32',use_last_error=True)
a=c.WinDLL('advapi32',use_last_error=True)
k.GetCurrentProcess.restype=w.HANDLE
a.OpenProcessToken.argtypes=[w.HANDLE,w.DWORD,c.POINTER(w.HANDLE)]
a.GetTokenInformation.argtypes=[w.HANDLE,c.c_int,c.c_void_p,w.DWORD,c.POINTER(w.DWORD)]
a.GetSidSubAuthorityCount.argtypes=[c.c_void_p]
a.GetSidSubAuthorityCount.restype=c.POINTER(c.c_ubyte)
a.GetSidSubAuthority.argtypes=[c.c_void_p,w.DWORD]
a.GetSidSubAuthority.restype=c.POINTER(w.DWORD)
k.CloseHandle.argtypes=[w.HANDLE]
a.GetNamedSecurityInfoW.argtypes=[w.LPWSTR,c.c_int,w.DWORD,c.c_void_p,c.c_void_p,c.c_void_p,c.POINTER(c.c_void_p),c.POINTER(c.c_void_p)]
a.GetNamedSecurityInfoW.restype=w.DWORD
a.GetSecurityDescriptorSacl.argtypes=[c.c_void_p,c.POINTER(w.BOOL),c.POINTER(c.c_void_p),c.POINTER(w.BOOL)]
a.GetAce.argtypes=[c.c_void_p,w.DWORD,c.POINTER(c.c_void_p)]
k.LocalFree.argtypes=[c.c_void_p]
k.LocalFree.restype=c.c_void_p

def file_integrity(path):
 # Read LABEL_SECURITY_INFORMATION, including inherited executable labels.
 # A launcher can cap its child even when the adjacent Python probes High.
 sacl=c.c_void_p(); descriptor=c.c_void_p()
 status=a.GetNamedSecurityInfoW(path,1,0x10,None,None,None,c.byref(sacl),c.byref(descriptor))
 if status: raise c.WinError(status)
 try:
  present=w.BOOL(); defaulted=w.BOOL()
  if not a.GetSecurityDescriptorSacl(descriptor,c.byref(present),c.byref(sacl),c.byref(defaulted)): raise c.WinError(c.get_last_error())
  levels=[]
  if present and sacl.value:
   count=c.c_ushort.from_address(sacl.value+4).value
   for index in range(count):
    ace=c.c_void_p()
    if not a.GetAce(sacl,index,c.byref(ace)): raise c.WinError(c.get_last_error())
    if c.c_ubyte.from_address(ace.value).value==0x11:
     sid=ace.value+8
     levels.append(a.GetSidSubAuthority(sid,a.GetSidSubAuthorityCount(sid)[0]-1)[0])
  return min(levels) if levels else 8192
 finally: k.LocalFree(descriptor)
t=w.HANDLE()
if not a.OpenProcessToken(k.GetCurrentProcess(),8,c.byref(t)): raise c.WinError(c.get_last_error())
def info(kind):
 n=w.DWORD(); a.GetTokenInformation(t,kind,None,0,c.byref(n))
 b=c.create_string_buffer(n.value)
 if not a.GetTokenInformation(t,kind,b,n,c.byref(n)): raise c.WinError(c.get_last_error())
 return b
try:
 b=info(25); sid=c.cast(b,c.POINTER(c.c_void_p))[0]
 rid=a.GetSidSubAuthority(sid,a.GetSidSubAuthorityCount(sid)[0]-1)[0]
 ui=bool(c.cast(info(26),c.POINTER(w.DWORD))[0])
 entry=file_integrity(sys.argv[1])
 base=file_integrity(sys._base_executable)
 effective=min(rid,entry,base)
 print(json.dumps({'integrityRid':rid,'entryIntegrityRid':entry,'baseIntegrityRid':base,'effectiveIntegrityRid':effective,'uiAccess':ui}))
finally: k.CloseHandle(t)
`;

export function defaultProbeWindowsInputAccess(entryExecutable, timeoutMs = 6000) {
  if (process.platform !== 'win32') return Promise.resolve({ available: true, platform: process.platform });
  return new Promise(resolve => {
    const python = path.join(path.dirname(entryExecutable), 'python.exe');
    execFile(python, ['-B', '-c', WINDOWS_INPUT_ACCESS_PROBE, entryExecutable],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8192 }, (error, stdout) => {
        if (error) { resolve({ available: false, reason: 'input_permission_probe_failed' }); return; }
        try {
          const result = JSON.parse(stdout.trim());
          if (![result.integrityRid, result.entryIntegrityRid, result.baseIntegrityRid, result.effectiveIntegrityRid].every(Number.isInteger)
            || typeof result.uiAccess !== 'boolean') throw Error('invalid token metadata');
          const available = result.effectiveIntegrityRid >= 8192 || result.uiAccess;
          resolve({ ...result, available, reason: available ? null : 'input_runtime_low_integrity' });
        } catch { resolve({ available: false, reason: 'input_permission_probe_failed' }); }
      });
  });
}
