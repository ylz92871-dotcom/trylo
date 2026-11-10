"""Native acceptance fixture with observable button/text state."""
import win32api
import win32con
import win32gui

count = 0
label = None


def handler(hwnd, message, wparam, lparam):
    global count
    if message == win32con.WM_COMMAND and (wparam & 0xffff) == 101:
        count += 1
        win32gui.SetWindowText(label, "Count: " + str(count))
        return 0
    if message == win32con.WM_DESTROY:
        win32gui.PostQuitMessage(0)
        return 0
    return win32gui.DefWindowProc(hwnd, message, wparam, lparam)


klass = win32gui.WNDCLASS()
klass.hInstance = win32api.GetModuleHandle(None)
klass.lpszClassName = "TryloSoftwareAcceptance"
klass.lpfnWndProc = handler
klass.hbrBackground = win32con.COLOR_WINDOW + 1
win32gui.RegisterClass(klass)
window = win32gui.CreateWindow(klass.lpszClassName, "Trylo Software Workspace Acceptance", win32con.WS_OVERLAPPEDWINDOW | win32con.WS_VISIBLE,
                               0, 0, 800, 560, 0, 0, klass.hInstance, None)
win32gui.CreateWindow("BUTTON", "Add one", win32con.WS_VISIBLE | win32con.WS_CHILD | win32con.BS_PUSHBUTTON,
                       30, 30, 160, 44, window, 101, klass.hInstance, None)
label = win32gui.CreateWindow("STATIC", "Count: 0", win32con.WS_VISIBLE | win32con.WS_CHILD, 30, 100, 200, 40, window, 102, klass.hInstance, None)
win32gui.CreateWindow("EDIT", "", win32con.WS_VISIBLE | win32con.WS_CHILD | win32con.WS_BORDER, 30, 160, 500, 40, window, 103, klass.hInstance, None)
win32gui.PumpMessages()
