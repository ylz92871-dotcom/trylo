"""Installed application discovery; launch targets are never shell commands."""
import os
from pathlib import Path
import winreg


def discover():
    found = {}

    def add(value):
        candidate = str(value).strip().strip('"')
        path = Path(os.path.expandvars(candidate))
        if path.is_file() and path.suffix.lower() == ".exe":
            key = str(path).lower()
            name = path.stem
            kind = {"sldworks": "solidworks", "acad": "autocad"}.get(name.lower(), "application")
            found[key] = {"path": str(path), "name": {"solidworks": "SOLIDWORKS", "autocad": "AutoCAD"}.get(kind, name), "kind": kind}

    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths", 0, winreg.KEY_READ | view) as key:
                    for index in range(winreg.QueryInfoKey(key)[0]):
                        try:
                            with winreg.OpenKey(key, winreg.EnumKey(key, index)) as child:
                                add(winreg.QueryValue(child, None))
                        except OSError:
                            continue
            except OSError:
                continue
    for progid in ("SldWorks.Application", "AutoCAD.Application"):
        try:
            with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, progid + r"\CLSID") as key:
                clsid = winreg.QueryValue(key, None)
            with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, "CLSID\\" + clsid + r"\LocalServer32") as key:
                command = winreg.QueryValue(key, None)
                end = command.lower().find(".exe")
                if end >= 0:
                    add(command[:end + 4].strip('"'))
        except OSError:
            continue
    return sorted(found.values(), key=lambda app: (app["kind"] == "application", app["name"].lower()))
