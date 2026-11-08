from _ctypes import COMError
from unittest.mock import MagicMock

from windows_mcp.tree import cache_utils
from windows_mcp.tree.cache_utils import CacheRequestFactory, CachedControlHelper
from windows_mcp.uia import PropertyId


UIA_E_ELEMENTNOTAVAILABLE = -2147220991


def _cache_request():
    request = MagicMock()
    clone = MagicMock()
    request.Clone.return_value = clone
    clone.check_request = object()
    return request


def _stale_element_error():
    return COMError(
        UIA_E_ELEMENTNOTAVAILABLE,
        "An event was unable to invoke any of the subscribers",
        (None, None, None, 0, None),
    )


def test_unavailable_element_skips_regular_children_fallback():
    node = MagicMock()
    node.Element.BuildUpdatedCache.side_effect = _stale_element_error()

    children = CachedControlHelper.get_cached_children(node, _cache_request())

    assert children == []
    node.GetChildren.assert_not_called()


def test_unavailable_element_during_fallback_is_pruned():
    node = MagicMock()
    node.Element.BuildUpdatedCache.side_effect = RuntimeError("cache provider failed")
    node.GetChildren.side_effect = _stale_element_error()

    children = CachedControlHelper.get_cached_children(node, _cache_request())

    assert children == []


def test_unexpected_cache_failure_still_uses_regular_children():
    node = MagicMock()
    expected = [MagicMock(), MagicMock()]
    node.Element.BuildUpdatedCache.side_effect = RuntimeError("cache provider failed")
    node.GetChildren.return_value = expected

    assert CachedControlHelper.get_cached_children(node, _cache_request()) == expected


def test_tree_cache_batches_identity_and_capability_properties(monkeypatch):
    request = MagicMock()
    monkeypatch.setattr(cache_utils, "CacheRequest", lambda: request)

    assert CacheRequestFactory.create_tree_traversal_cache() is request

    cached_properties = {call.args[0] for call in request.AddProperty.call_args_list}
    assert PropertyId.RuntimeIdProperty in cached_properties
    assert PropertyId.FrameworkIdProperty in cached_properties
    assert PropertyId.ClickablePointProperty in cached_properties
    assert PropertyId.IsInvokePatternAvailableProperty in cached_properties
    assert PropertyId.IsValuePatternAvailableProperty in cached_properties
    assert PropertyId.IsScrollItemPatternAvailableProperty in cached_properties
