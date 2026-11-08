"""UIA subscription source inside the broker process.

Callbacks run on the COM STA that created the subscription. They must only
extract primitive identity fields (runtime id, hwnd, pid, name, property id)
and enqueue — no tree traversal, no pattern calls, no screenshot, no model
logic (spec §6.3). All registration errors are swallowed by the caller
(``broker.__main__``) so a broken provider degrades to polling.
"""

from __future__ import annotations


from windows_mcp.broker import BrokerCore
from windows_mcp.broker.protocol import PROPERTY_NAMES, SubscribeRequest

_KIND_FOCUS = "focus_changed"
_KIND_PROPERTY = "property_changed"
_KIND_STRUCTURE = "structure_changed"


# UIA event ids carried by the generic (IUIAutomationEventHandler) source.
# Window open/close and menu open/close come through the root element with
# TreeScope_Subtree and give the host a window-lifecycle stream without a
# separate SetWinEventHook; invoke/selection give the verifier cheap wake-ups
# for postcondition checks that property changes alone do not cover.
_AUTOMATION_EVENT_IDS: tuple[tuple[int, str], ...] = (
    (20016, "window_opened"),      # UIA_Window_WindowOpenedEventId
    (20017, "window_closed"),      # UIA_Window_WindowClosedEventId
    (20003, "window_opened"),      # UIA_MenuOpenedEventId
    (20007, "structure_changed"),  # UIA_MenuClosedEventId
    (20009, "property_changed"),   # UIA_Invoke_InvokedEventId → Invoke
    (20012, "property_changed"),   # UIA_SelectionItem_ElementSelectedEventId → Selection
)

_AUTOMATION_EVENT_KINDS: dict[int, str] = dict(_AUTOMATION_EVENT_IDS)


def _runtime_id_of(sender) -> tuple[int, ...] | None:
    try:
        return tuple(int(part) for part in sender.GetRuntimeId())
    except Exception:
        return None


def _name_of(sender) -> str | None:
    try:
        return str(sender.CurrentName or "") or None
    except Exception:
        return None


def _hwnd_pid_of(sender) -> tuple[int, int] | None:
    try:
        handle = sender.CurrentNativeWindowHandle
        if not handle:
            return None
        import win32process

        _, pid = win32process.GetWindowThreadProcessId(int(handle))
        return int(handle), int(pid)
    except Exception:
        return None


class UiaEventSource:
    """Owns the broker's UIA event subscriptions on its own STA thread."""

    def __init__(self, core: BrokerCore) -> None:
        self._core = core
        self._uia = None
        self._focus_handler = None
        self._property_handler = None
        self._property_target = None
        self._property_ids = ()
        self._window_handler = None

    def apply(self, request: SubscribeRequest) -> None:
        """(Re)register handlers for the requested window/properties.

        Registration happens lazily on the calling thread; comtypes creates
        the COM object in this thread's apartment and pumps are driven by the
        publisher-independent COM message loop that comtypes maintains for
        the handler callbacks.
        """
        import comtypes

        comtypes.CoInitialize()
        if self._uia is None:
            from windows_mcp.uia.core import _AutomationClient

            client = _AutomationClient.instance()
            self._uia = comtypes.client.CreateObject(
                "{ff48dba4-60ef-4201-aa87-54103eef594e}",
                interface=client.UIAutomationCore.IUIAutomation,
            )
        self._register_focus()
        self._register_property(request)
        self._register_automation_events(request)

    def _register_automation_events(self, request: SubscribeRequest) -> None:
        """Window lifecycle + invoke/selection via the generic handler.

        Registration failure degrades the source (the caller swallows it);
        an already-registered handler set is not re-registered — the
        window scope is desktop-wide on purpose, so one registration per
        broker process lifetime is the steady state.
        """
        if self._window_handler is not None:
            return
        from windows_mcp.uia.core import _AutomationClient
        from windows_mcp.uia.enums import TreeScope

        event_interface = _AutomationClient.instance().UIAutomationCore.IUIAutomationEventHandler

        def on_automation(sender, event_id: int) -> None:
            kind = _AUTOMATION_EVENT_KINDS.get(int(event_id))
            if kind is None:
                return
            hwnd_pid = _hwnd_pid_of(sender)
            self._core.emit(
                kind,
                runtime_id=_runtime_id_of(sender),
                name_hint=_name_of(sender),
                window_hwnd=hwnd_pid[0] if hwnd_pid else None,
                window_pid=hwnd_pid[1] if hwnd_pid else None,
            )

        handler_class = _make_handler_class(event_interface, "HandleAutomationEvent")
        self._window_handler = handler_class(on_automation)
        root = self._uia.GetRootElement()
        for event_id, _kind in _AUTOMATION_EVENT_IDS:
            try:
                self._uia.AddAutomationEventHandler(
                    event_id, root, TreeScope.TreeScope_Children, None, self._window_handler
                )
            except Exception:
                # A provider that rejects one event id must not take down the
                # others; the verifier's reconciliation polling still works.
                continue

    def _register_focus(self) -> None:
        if self._focus_handler is not None:
            return
        from windows_mcp.uia.core import _AutomationClient

        focus_interface = _AutomationClient.instance().UIAutomationCore.IUIAutomationFocusChangedEventHandler

        def on_focus(sender) -> None:
            hwnd_pid = _hwnd_pid_of(sender)
            self._core.emit(
                _KIND_FOCUS,
                runtime_id=_runtime_id_of(sender),
                name_hint=_name_of(sender),
                window_hwnd=hwnd_pid[0] if hwnd_pid else None,
                window_pid=hwnd_pid[1] if hwnd_pid else None,
            )

        handler_class = _make_handler_class(focus_interface, "HandleFocusChangedEvent")
        self._focus_handler = handler_class(on_focus)
        self._uia.AddFocusChangedEventHandler(None, self._focus_handler)

    def _register_property(self, request: SubscribeRequest) -> None:
        from windows_mcp.uia.core import _AutomationClient

        client = _AutomationClient.instance()
        property_interface = client.UIAutomationCore.IUIAutomationPropertyChangedEventHandler
        from windows_mcp.uia.enums import TreeScope

        property_ids = list(request.properties) or list(PROPERTY_NAMES)
        target = self._uia.GetRootElement()
        if request.window_hwnd:
            try:
                target = self._uia.ElementFromHandle(int(request.window_hwnd))
            except Exception:
                target = self._uia.GetRootElement()

        def on_property(sender, property_id, _new_value) -> None:
            # newValue is a hint only; verifiers must re-read live state.
            hwnd_pid = _hwnd_pid_of(sender)
            self._core.emit(
                _KIND_PROPERTY,
                runtime_id=_runtime_id_of(sender),
                name_hint=_name_of(sender),
                window_hwnd=hwnd_pid[0] if hwnd_pid else None,
                window_pid=hwnd_pid[1] if hwnd_pid else None,
                changed_properties=(
                    PROPERTY_NAMES.get(int(property_id), str(property_id)),
                ),
            )

        # Re-registration replaces the previous handler set.
        if self._property_handler is not None:
            try:
                self._uia.RemovePropertyChangedEventHandler(self._property_target, self._property_handler)
            except Exception:
                pass
            self._property_handler = None
        handler_class = _make_handler_class(property_interface, "HandlePropertyChangedEvent")
        self._property_handler = handler_class(on_property)
        self._property_target = target
        self._property_ids = tuple(property_ids)
        self._uia.AddPropertyChangedEventHandler(
            target, TreeScope.TreeScope_Subtree, None, self._property_handler, property_ids
        )


def _make_handler_class(com_interface, method_name: str):
    """Build a comtypes COMObject class for one UIA handler interface that
    forwards the raw callback args to a Python callable. Building the class
    lazily keeps module import free of COM construction (see #374).

    The instance callback is stored via ``__new__``: ``COMObject.__init__``
    is plain ``object.__init__``, so a callback passed to the constructor
    would be silently swallowed (the P1-05 audit live-fire found exactly
    that — every handler fired with ``_callback=None`` and no event ever
    reached the queue)."""
    from comtypes import COMObject

    def _new(cls, callback=None):
        instance = COMObject.__new__(cls)
        instance._callback = callback
        return instance

    def handle(self, *args) -> int:
        callback = self._callback
        if callback is None:
            return 0  # S_OK
        try:
            callback(*args)
        except Exception:
            pass
        return 0  # S_OK

    return type(
        "BrokerUiaEventHandler",
        (COMObject,),
        {
            "_com_interfaces_": [com_interface],
            "_callback": None,
            "__new__": _new,
            method_name: handle,
        },
    )
