"""windows_mcp.broker — crash-isolated desktop event pump package."""

from windows_mcp.broker.protocol import (
    DEFAULT_PROPERTY_IDS,
    PROPERTY_NAMES,
    BrokerHello,
    DesktopEvent,
    Heartbeat,
    ProtocolError,
    SubscribeRequest,
    decode,
    encode,
)
from windows_mcp.broker.supervisor import EventBrokerSupervisor

# BrokerCore lives in __main__ (it is the process body), but
# uia_subscriptions imports it from here — importing windows_mcp.broker.__main__
# first would otherwise make `from windows_mcp.broker import BrokerCore` fail.
from windows_mcp.broker.__main__ import BrokerCore

__all__ = [
    "BrokerCore",
    "DEFAULT_PROPERTY_IDS",
    "PROPERTY_NAMES",
    "BrokerHello",
    "DesktopEvent",
    "EventBrokerSupervisor",
    "Heartbeat",
    "ProtocolError",
    "SubscribeRequest",
    "decode",
    "encode",
]
