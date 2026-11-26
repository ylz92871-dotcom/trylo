import AppKit
import ApplicationServices
import Carbon.HIToolbox
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

typealias Object = [String: Any]

struct ComputerError: Error {
    let code: String
    let message: String

    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

func number(_ object: Object, _ key: String) throws -> Double {
    guard let value = object[key] as? NSNumber,
          CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else {
        throw ComputerError("invalid_arguments", "\(key) must be a finite number.")
    }
    return value.doubleValue
}

func integer(_ object: Object, _ key: String, range: ClosedRange<Int>) throws -> Int {
    let value = try number(object, key)
    guard let value = Int(exactly: value), range.contains(value) else {
        throw ComputerError("invalid_arguments", "\(key) must be an integer in \(range).")
    }
    return value
}

func text(_ object: Object, _ key: String) throws -> String {
    guard let value = object[key] as? String, !value.isEmpty else {
        throw ComputerError("invalid_arguments", "\(key) must be a nonempty string.")
    }
    return value
}

@MainActor
enum Computer {
    private static let accessibilityRequired = ComputerError("accessibility_required", "Allow Trylo (or its launching app) in System Settings → Privacy & Security → Accessibility, then retry.")

    static func appInfo(_ app: NSRunningApplication) -> Object {
        var info: Object = ["pid": app.processIdentifier, "name": app.localizedName ?? ""]
        if let bundle = app.bundleIdentifier { info["bundleId"] = bundle }
        return info
    }

    static func bounds(_ rect: CGRect) -> Object {
        ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
    }

    static func status() -> Object {
        var count: UInt32 = 0
        _ = CGGetActiveDisplayList(0, nil, &count)
        var ids = Array(repeating: CGDirectDisplayID(0), count: Int(count))
        let displays: [Object]
        if count > 0, CGGetActiveDisplayList(count, &ids, &count) == .success {
            displays = ids.prefix(Int(count)).map { ["displayId": $0, "bounds": bounds(CGDisplayBounds($0))] }
        } else {
            displays = []
        }
        return ["accessibility": AXIsProcessTrusted(), "postEvents": CGPreflightPostEventAccess(),
         "screenRecording": CGPreflightScreenCaptureAccess(), "mainDisplayId": CGMainDisplayID(),
         "displays": displays,
         "frontmostApp": NSWorkspace.shared.frontmostApplication.map(appInfo) as Any? ?? NSNull()]
    }

    private static func frontmost(_ input: Object, requirePostEvents: Bool = false) throws -> NSRunningApplication {
        guard AXIsProcessTrusted() else { throw accessibilityRequired }
        if requirePostEvents && !CGPreflightPostEventAccess() { throw accessibilityRequired }
        guard let app = NSWorkspace.shared.frontmostApplication else {
            throw ComputerError("no_foreground_app", "Open the target application and try again.")
        }
        if input["expectedPid"] != nil {
            let expected = try integer(input, "expectedPid", range: 1...Int(Int32.max))
            guard app.processIdentifier == expected else {
                throw ComputerError("foreground_changed", "The foreground app changed. Inspect the desktop and retry.")
            }
        }
        return app
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }

    static func inspect(_ input: Object) throws -> Object {
        let depth = try input["depth"].map { _ in try integer(input, "depth", range: 0...12) } ?? 5
        var remaining = try input["maxNodes"].map { _ in try integer(input, "maxNodes", range: 1...1000) } ?? 120
        let app = try frontmost(input)
        let application = AXUIElementCreateApplication(app.processIdentifier)
        let focused = attribute(application, kAXFocusedWindowAttribute)
        let window = focused.flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
        let tree = node(window ?? application, depth: depth, remaining: &remaining)
        return ["app": appInfo(app), "tree": tree, "maxDepth": depth, "nodeLimitReached": remaining == 0]
    }

    private static func node(_ element: AXUIElement, depth: Int, remaining: inout Int) -> Object {
        remaining -= 1
        var result: Object = [:]
        for (key, name) in [("role", kAXRoleAttribute), ("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute)] {
            if let value = attribute(element, name) as? String, !value.isEmpty { result[key] = value }
        }
        if let enabled = attribute(element, kAXEnabledAttribute) as? Bool { result["enabled"] = enabled }
        if let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
           let size = attribute(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() {
            var point = CGPoint.zero
            var dimensions = CGSize.zero
            if AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions),
               [point.x, point.y, dimensions.width, dimensions.height].allSatisfy(\.isFinite) {
                result["bounds"] = bounds(CGRect(origin: point, size: dimensions))
            }
        }
        guard depth > 0, remaining > 0 else { return result }
        var values: CFArray?
        if AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, remaining, &values) == .success,
           let children = values as? [AXUIElement] {
            var rows: [Object] = []
            for child in children {
                if remaining == 0 { break }
                rows.append(node(child, depth: depth - 1, remaining: &remaining))
            }
            if !rows.isEmpty { result["children"] = rows }
        }
        return result
    }

    static func click(_ input: Object) throws -> Object {
        let point = try CGPoint(x: number(input, "x"), y: number(input, "y"))
        let x = Float(point.x), y = Float(point.y)
        guard x.isFinite, y.isFinite else { throw ComputerError("invalid_arguments", "Invalid global screen point.") }
        let app = try frontmost(input, requirePostEvents: true)
        var element: AXUIElement?
        let status = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), x, y, &element)
        var targetPid: pid_t = 0
        guard status == .success, let element, AXUIElementGetPid(element, &targetPid) == .success,
              targetPid == app.processIdentifier else {
            throw ComputerError("target_changed", "The click point is outside the foreground app. Inspect its current window and retry.")
        }
        guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
            throw ComputerError("event_creation_failed", "Quartz could not create the click events.")
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        return ["submitted": true, "app": appInfo(app)]
    }

    static let keys: [String: CGKeyCode] = [
        "Escape": CGKeyCode(kVK_Escape), "Enter": CGKeyCode(kVK_Return), "Tab": CGKeyCode(kVK_Tab),
        "Backspace": CGKeyCode(kVK_Delete), "Space": CGKeyCode(kVK_Space),
        "ArrowLeft": CGKeyCode(kVK_LeftArrow), "ArrowRight": CGKeyCode(kVK_RightArrow),
        "ArrowUp": CGKeyCode(kVK_UpArrow), "ArrowDown": CGKeyCode(kVK_DownArrow),
    ]

    static func pressKey(_ input: Object) throws -> Object {
        let key = try text(input, "key")
        guard let code = keys[key] else { throw ComputerError("invalid_arguments", "Unsupported key: \(key). Use type_text for characters.") }
        let app = try frontmost(input, requirePostEvents: true)
        try sendKey(code, text: nil, pid: app.processIdentifier)
        return ["submitted": true, "app": appInfo(app)]
    }

    static func typeText(_ input: Object) throws -> Object {
        let content = try text(input, "text")
        let app = try frontmost(input, requirePostEvents: true)
        // Keep event payloads short without splitting UTF-16 surrogate pairs.
        var chunk: [UniChar] = []
        for scalar in content.unicodeScalars {
            let units = String(scalar).utf16
            if chunk.count + units.count > 20 {
                try sendKey(0, text: chunk, pid: app.processIdentifier)
                chunk.removeAll(keepingCapacity: true)
            }
            chunk.append(contentsOf: units)
        }
        if !chunk.isEmpty {
            try sendKey(0, text: chunk, pid: app.processIdentifier)
        }
        return ["submitted": true, "app": appInfo(app)]
    }

    private static func sendKey(_ code: CGKeyCode, text: [UniChar]?, pid: pid_t) throws {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
            throw ComputerError("event_creation_failed", "Quartz could not create the key events.")
        }
        if let text {
            down.keyboardSetUnicodeString(stringLength: text.count, unicodeString: text)
            up.keyboardSetUnicodeString(stringLength: text.count, unicodeString: text)
        }
        down.postToPid(pid)
        up.postToPid(pid)
    }

    static func screenshot(_ input: Object) async throws -> [Object] {
        let requestedDisplay = try input["displayId"].map { _ in try integer(input, "displayId", range: 1...Int(UInt32.max)) }
        let maxWidth = try input["maxWidth"].map { _ in try integer(input, "maxWidth", range: 320...2400) } ?? 1600
        guard CGPreflightScreenCaptureAccess() else {
            throw ComputerError("screen_recording_required", "Allow Trylo (or its launching app) in System Settings → Privacy & Security → Screen & System Audio Recording, then reopen it.")
        }
        let id = requestedDisplay.map(UInt32.init) ?? CGMainDisplayID()
        let foreground = NSWorkspace.shared.frontmostApplication
        let current = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = current.displays.first(where: { $0.displayID == id }) else {
            throw ComputerError("display_unavailable", "Display \(id) is not available. Use the current main display or check display settings.")
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        // Bound both dimensions for tall or scaled Retina displays and provider image limits.
        let scale = min(1, Double(maxWidth) / Double(display.width), 2400 / Double(display.height))
        config.width = max(1, Int(Double(display.width) * scale))
        config.height = max(1, Int(Double(display.height) * scale))
        config.showsCursor = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let bytes = NSMutableData()
        guard let encoder = CGImageDestinationCreateWithData(bytes, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw ComputerError("image_encoding_failed", "Could not create the screenshot encoder.")
        }
        CGImageDestinationAddImage(encoder, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(encoder) else { throw ComputerError("image_encoding_failed", "Could not encode the screenshot.") }
        var details: Object = ["displayId": id, "displayBounds": bounds(CGDisplayBounds(id)), "imageWidth": image.width, "imageHeight": image.height]
        if let foreground { details["app"] = appInfo(foreground) }
        return [try textContent(details), ["type": "image", "mimeType": "image/jpeg", "data": bytes.base64EncodedString()]]
    }
}
