"""Placement-only COM guard for the existing, unmodified CAD MCP tools.

Never allow a server to attach a foreground instance or launch through the
COM service manager, which may place that instance on Default instead.
"""
import os
import sys
import json

if os.environ.get("TRYLO_SOFTWARE_BINDING"):
    try:
        import pythoncom
        import pywintypes
        import win32com.client.dynamic
        import win32process

        kind = os.environ["TRYLO_SOFTWARE_APP_KIND"]
        clsid = pywintypes.IID("SldWorks.Application" if kind == "solidworks" else "AutoCAD.Application")
        original_active = pythoncom.GetActiveObject
        original_connect = pythoncom.connect
        original_create = pythoncom.CoCreateInstance
        original_create_ex = pythoncom.CoCreateInstanceEx

        def is_target(value):
            try:
                return pywintypes.IID(value) == clsid
            except (TypeError, pywintypes.com_error):
                return False

        def checked(value, identifier):
            if not is_target(identifier):
                return value
            with open(os.environ["TRYLO_SOFTWARE_BINDING"], encoding="utf-8") as binding:
                expected = json.load(binding).get(kind)
            if expected is None:
                raise RuntimeError("请先在软件工作区启动所需软件")
            app = win32com.client.dynamic.Dispatch(value.QueryInterface(pythoncom.IID_IDispatch))
            if kind == "solidworks":
                app._FlagAsMethod("GetProcessID")
                actual = int(app.GetProcessID())
            else:
                actual = win32process.GetWindowThreadProcessId(int(app.HWND))[1]
            if actual != expected:
                raise RuntimeError("软件 API 未绑定到当前后台实例；没有操作其他桌面中的软件。请等待后台软件启动或处理其对话框后重试。")
            return value

        def active(identifier, *args, **kwargs):
            return checked(original_active(identifier, *args, **kwargs), identifier)

        def connect(identifier, *args, **kwargs):
            return checked(original_connect(identifier, *args, **kwargs), identifier)

        def create(identifier, *args, **kwargs):
            if is_target(identifier):
                raise RuntimeError("后台软件尚未注册 API。请用 software_snapshot 查看并处理启动对话框，再重试本次工具；没有另外启动软件。")
            return original_create(identifier, *args, **kwargs)

        def create_ex(identifier, *args, **kwargs):
            if is_target(identifier):
                raise RuntimeError("请先在软件工作区启动对应实例；没有通过 COM 另外启动软件。")
            return original_create_ex(identifier, *args, **kwargs)

        pythoncom.GetActiveObject = active
        pythoncom.connect = connect
        pythoncom.CoCreateInstance = create
        pythoncom.CoCreateInstanceEx = create_ex
    except Exception as error:
        # A broken guard must prevent the server from starting, not disappear
        # behind Python's normal sitecustomize import-error handling.
        sys.stderr.write("software_workspace_guard_failed: " + str(error) + "\n")
        os._exit(1)
