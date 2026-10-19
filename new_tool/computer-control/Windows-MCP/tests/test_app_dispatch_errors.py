import pytest
from windows_mcp.desktop.service import Desktop


@pytest.mark.parametrize('mode', ['switch','resize','launch'])
def test_failed_window_dispatch_raises_instead_of_success_text(mode):
    desktop=Desktop.__new__(Desktop)
    desktop.switch_app=lambda name: ('focus denied',1)
    desktop.resize_app=lambda **kwargs: ('resize denied',1)
    desktop.launch_app=lambda name: ('launch denied',1,0)
    with pytest.raises(RuntimeError, match='denied'):
        desktop.app(mode,'fixture')
