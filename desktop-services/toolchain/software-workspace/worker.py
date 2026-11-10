"""Commands execute only inside the owned hidden desktop and process job."""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import traceback

import psutil
import pythoncom
import pywintypes
import win32com.client.dynamic
import win32gui
import win32process
from PIL import Image
from applications import discover
from native import capture, frame, keyboard, pointer, windows, window_coordinates
from launcher import launch

OUTPUT_LOCK = threading.Lock()


def emit(value):
    with OUTPUT_LOCK:
        print(json.dumps(value, ensure_ascii=False), flush=True)


class Workspace:
    def __init__(self, desktop, owner_pids):
        self.desktop = desktop
        self.apps = {}
        self.servers = {}
        self.focus = None
        self.revision = 0
        self.binding = Path(os.environ["TEMP"]) / "software-binding.json"
        self.binding.write_text("{}", encoding="utf-8")
        self.runtime_pids = set(owner_pids) | {os.getpid(), os.getppid()}
        self.owned_pids = set()
        self.processes = {}

    def pids(self):
        return self.owned_pids - self.runtime_pids

    def status(self):
        live = self.pids()
        observed = windows(live)
        for app in self.apps.values():
            app["exitCode"] = self.processes[app["id"]].poll()
            app["running"] = app["pid"] in live and app["exitCode"] is None
        return {"applications": list(self.apps.values()), "windows": observed}

    def launch(self, executable, args=None):
        path = Path(executable).resolve(strict=True)
        if path.suffix.lower() != ".exe":
            raise RuntimeError("请选择软件的 .exe 可执行文件")
        for app in self.apps.values():
            if app["path"].lower() == str(path).lower() and self.processes[app["id"]].poll() is None:
                return app
        # The managed interpreter may have a venv launcher and controller
        # ancestors using the same executable. They are not user app instances.
        owned = self.pids() | self.runtime_pids
        for process in psutil.process_iter(["pid", "exe"]):
            if process.info["exe"] and str(path).lower() == process.info["exe"].lower() and process.pid not in owned:
                raise RuntimeError("此软件已在其他桌面运行。请保存并关闭现有实例，再在工作区启动；不会接管它。")
        process = launch([str(path), *(args or [])], self.desktop, cwd=str(path.parent))
        kind = {"sldworks": "solidworks", "acad": "autocad"}.get(path.stem.lower(), "application")
        app = {"id": str(process.pid), "pid": process.pid, "path": str(path), "name": path.stem,
               "kind": kind, "running": True}
        self.apps[app["id"]] = app
        self.processes[app["id"]] = process
        replacement = self.binding.with_suffix(".new")
        replacement.write_text(json.dumps({item["kind"]: item["pid"] for item in self.apps.values() if item["running"]}), encoding="utf-8")
        replacement.replace(self.binding)
        emit({"event": "applicationLaunched", "application": app})
        return app

    def window(self, requested=None, prefer_dialog=False):
        choices = self.status()["windows"]
        if requested is not None:
            selected = next((window for window in choices if window["id"] == requested), None)
            if not selected:
                raise RuntimeError("窗口已经关闭或不属于当前工作区，请刷新画面")
            if prefer_dialog and not selected["dialog"]:
                pid = win32process.GetWindowThreadProcessId(int(selected["id"]))[1]
                dialog = next((window for window in choices if window["dialog"] and win32process.GetWindowThreadProcessId(int(window["id"]))[1] == pid), None)
                if dialog:
                    return dialog
            return selected
        dialogs = [window for window in choices if window["dialog"]]
        if dialogs:
            return dialogs[0]
        if not choices:
            raise RuntimeError("软件正在启动，尚未提供窗口画面")
        return max(choices, key=lambda w: (w["rect"][2] - w["rect"][0]) * (w["rect"][3] - w["rect"][1]))

    def solidworks(self):
        owned = next((app for app in self.apps.values() if app["kind"] == "solidworks" and app["running"]), None)
        if not owned:
            raise RuntimeError("请先在工作区启动 SOLIDWORKS")
        raw = pythoncom.GetActiveObject(pywintypes.IID("SldWorks.Application"))
        app = win32com.client.dynamic.Dispatch(raw.QueryInterface(pythoncom.IID_IDispatch))
        app._FlagAsMethod("GetProcessID")
        if int(app.GetProcessID()) != owned["pid"]:
            raise RuntimeError("SOLIDWORKS API 属于其他实例；没有操作该实例")
        return app

    def snapshot(self, params):
        selected = self.window(params.get("windowId"), prefer_dialog=True)
        mode = params.get("mode", "window")
        if mode == "model" and not selected["dialog"]:
            app = self.solidworks()
            model = app.ActiveDoc
            if model is None:
                raise RuntimeError("SOLIDWORKS 尚未打开模型，请先建模或切换到软件窗口")
            destination = Path(os.environ["TEMP"]) / "software-model-view.jpg"
            model._FlagAsMethod("SaveAs3")
            if model.SaveAs3(str(destination), 0, 2) != 0 or not destination.is_file():
                raise RuntimeError("SOLIDWORKS 没有返回模型画面，请查看软件窗口中的提示")
            with Image.open(destination) as image:
                model._FlagAsMethod("GetTitle")
                result = frame(image.copy(), mode="model", windowId=selected["id"], title=model.GetTitle())
        else:
            result = frame(capture(int(selected["id"])), mode="window", windowId=selected["id"], title=selected["title"])
        self.revision += 1
        return {**result, "seq": self.revision, "dialog": selected["dialog"]}

    def view(self, params):
        app = self.solidworks()
        model = app.ActiveDoc
        if model is None:
            raise RuntimeError("请先打开模型")
        model._FlagAsMethod("ShowNamedView2", "ViewZoomtofit2", "GraphicsRedraw2")
        model.ShowNamedView2("", {"front": 1, "top": 5, "right": 4, "isometric": 7}[params["preset"]])
        model.ViewZoomtofit2()
        model.GraphicsRedraw2()
        return {"ok": True}

    def input(self, params):
        selected = self.window(params["windowId"])
        if params.get("dialogOnly") and not selected["dialog"]:
            raise RuntimeError("对话框已经关闭，本次输入没有发送")
        hwnd = int(selected["id"])
        if params["kind"] in ("click", "wheel"):
            width, height = selected["rect"][2] - selected["rect"][0], selected["rect"][3] - selected["rect"][1]
            if not 0 <= params["x"] < width or not 0 <= params["y"] < height:
                raise RuntimeError("画面尺寸已变化，请刷新后重试")
            self.focus = pointer(hwnd, params)
        else:
            target = self.focus if self.focus and win32gui.IsWindow(self.focus) and (win32gui.IsChild(hwnd, self.focus) or self.focus == hwnd) else hwnd
            keyboard(target, params)
        return {"ok": True, "delivery": "window-message", "verification": "Inspect a fresh software_snapshot; delivery is not proof the app accepted the action."}

    def resize(self, params):
        hwnd = int(self.window(params["windowId"])["id"])
        with window_coordinates(hwnd):
            win32gui.SetWindowPos(hwnd, 0, 0, 0, params["width"], params["height"], 0x0010 | 0x0004 | 0x0002)
        return {"ok": True}

    def rpc(self, request_id, params):
        package = params["packageId"]
        server_key = package + ":" + params["clientId"]
        message = params["message"]
        kind = "solidworks" if package == "solidworks-mcp" else "autocad"
        if kind == "autocad" and params["server"].get("env", {}).get("CAD_PROGID", os.environ.get("CAD_PROGID", "AutoCAD.Application")) != "AutoCAD.Application":
            raise RuntimeError("当前软件工作区尚未绑定自定义 CAD_PROGID。请使用 AutoCAD.Application，或为该软件接入独立的实例绑定适配；没有启动其他桌面的软件。")
        # Discovery/initialize do not launch applications. Launch only after an
        # approved API tool call reaches the existing execution engine.
        if message.get("method") == "tools/call" and not message.get("params", {}).get("name", "").startswith("cadstudio_"):
            installed = next((app for app in discover() if app["kind"] == kind), None)
            if not installed:
                raise RuntimeError("未发现所需软件，请从软件工作区选择其可执行文件")
            app = self.launch(installed["path"])
        else:
            app = next((app for app in self.apps.values() if app["kind"] == kind and app["running"]), None)
        if server_key not in self.servers:
            spec = params["server"]
            environment = {**os.environ, **spec.get("env", {}), "PYTHONIOENCODING": "utf-8"}
            environment.update(TRYLO_SOFTWARE_BINDING=str(self.binding), TRYLO_SOFTWARE_APP_KIND=kind,
                               PYTHONPATH=str(Path(__file__).with_name("guard")))
            child = launch([spec["command"], *spec["args"]], self.desktop, environment=environment, pipes=True)
            bootstrap = message.get("method") != "initialize" and params.get("initialize") is not None
            server = {"process": child, "pending": {}, "pid": app["pid"] if app else None,
                      "next": 0, "ready": not bootstrap, "queue": [], "lock": threading.Lock()}
            self.servers[server_key] = server

            def receive():
                try:
                    for line in child.stdout:
                        value = json.loads(line)
                        if value.get("id") == "__trylo_initialize":
                            if "error" in value:
                                raise RuntimeError("软件 API 重连初始化失败：" + str(value["error"]))
                            with server["lock"]:
                                child.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
                                server["ready"] = True
                                for queued in server["queue"]:
                                    child.stdin.write(json.dumps(queued) + "\n")
                                server["queue"].clear()
                                child.stdin.flush()
                            continue
                        pending = server["pending"].pop(value.get("id"), None)
                        if pending:
                            caller, original_id = pending
                            emit({"id": caller, "result": {**value, "id": original_id}})
                finally:
                    for caller, _ in list(server["pending"].values()):
                        emit({"id": caller, "error": "软件 API 服务已断开；该调用的结果未知，请先检查当前模型，再决定后续操作。"})
                    server["pending"].clear()
                    if self.servers.get(server_key) is server:
                        del self.servers[server_key]

            threading.Thread(target=receive, daemon=True).start()
            if bootstrap:
                child.stdin.write(json.dumps({"jsonrpc": "2.0", "id": "__trylo_initialize", "method": "initialize", "params": params["initialize"]}) + "\n")
                child.stdin.flush()
        server = self.servers[server_key]
        outgoing = message.copy()
        if message.get("method") == "notifications/cancelled":
            original = message.get("params", {}).get("requestId")
            translated = next((key for key, (_, value) in server["pending"].items() if value == original), None)
            if translated:
                outgoing["params"] = {**message["params"], "requestId": translated}
        if "id" in message:
            server["next"] += 1
            outgoing["id"] = str(server["next"])
            server["pending"][outgoing["id"]] = (request_id, message["id"])
        with server["lock"]:
            if server["ready"]:
                server["process"].stdin.write(json.dumps(outgoing) + "\n")
                server["process"].stdin.flush()
            else:
                server["queue"].append(outgoing)
        return "deferred" if "id" in message else {"ok": True}

    def rpc_close(self, params):
        server = self.servers.pop(params["key"], None)
        if server:
            server["process"].terminate()
        return {"ok": True}


def main():
    bootstrap = json.loads(sys.stdin.readline())
    pythoncom.CoInitialize()
    workspace = Workspace(bootstrap["desktop"], bootstrap["ownerPids"])
    emit({"event": "ready"})
    for line in sys.stdin:
        request = json.loads(line)
        workspace.owned_pids = set(request.get("ownedPids", []))
        try:
            operation, params = request["operation"], request.get("params", {})
            if operation == "discover":
                result = {"applications": discover()}
            elif operation == "launch":
                result = workspace.launch(params["path"], params.get("args"))
            elif operation == "rpc":
                result = workspace.rpc(request["id"], params)
            else:
                result = getattr(workspace, operation)(params) if operation != "status" else workspace.status()
            if result != "deferred":
                emit({"id": request["id"], "result": result})
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            emit({"id": request["id"], "error": str(error)})
        pythoncom.PumpWaitingMessages()


if __name__ == "__main__":
    main()
