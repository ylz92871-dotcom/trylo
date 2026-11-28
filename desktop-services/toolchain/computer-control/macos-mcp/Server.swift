import Foundation

@MainActor
private struct Tool {
    let name: String
    let description: String
    let fields: Object
    let required: [String]

    init(_ name: String, _ description: String, fields: Object = [:], required: [String] = []) {
        self.name = name
        self.description = description
        self.fields = fields
        self.required = required
    }

    var specification: Object {
        ["name": name, "description": description, "inputSchema": [
            "type": "object", "properties": fields, "required": required, "additionalProperties": false,
        ]]
    }

    func validate(_ arguments: Object) throws {
        guard arguments.keys.allSatisfy({ fields[$0] != nil }), required.allSatisfy({ arguments[$0] != nil }) else {
            throw ComputerError("invalid_arguments", "Check the arguments for \(name) against its tool schema.")
        }
    }
}

func textContent(_ data: Object) throws -> Object {
    let bytes = try JSONSerialization.data(withJSONObject: data, options: [.sortedKeys])
    return ["type": "text", "text": String(decoding: bytes, as: UTF8.self)]
}

@main @MainActor
enum Server {
    private static let version = "0.1.0"
    private static let protocols = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
    private static let pid: Object = ["type": "integer", "minimum": 1, "maximum": Int32.max,
                                      "description": "PID from the latest foreground app observation."]
    private static let tools = [
        Tool("status", "Check macOS permission state and identify the foreground app and main display."),
        Tool("inspect", "Inspect the foreground window's Accessibility controls and their desktop-point bounds.", fields: [
            "expectedPid": pid, "depth": ["type": "integer", "minimum": 0, "maximum": 12],
            "maxNodes": ["type": "integer", "minimum": 1, "maximum": 1000],
        ]),
        Tool("screenshot", "Capture one screen JPEG. To convert image pixels to global points for click, scale by displayBounds.width/imageWidth and displayBounds.height/imageHeight, then add displayBounds.x/y.", fields: [
            "displayId": ["type": "integer", "minimum": 1, "maximum": UInt32.max],
            "maxWidth": ["type": "integer", "minimum": 320, "maximum": 2400],
        ]),
        Tool("click", "Click a point in the observed foreground app. Use global desktop points, not image pixels.", fields: [
            "expectedPid": pid, "x": ["type": "number"], "y": ["type": "number"],
        ], required: ["expectedPid", "x", "y"]),
        Tool("press_key", "Send a navigation or editing key to the expected foreground app.", fields: [
            "expectedPid": pid, "key": ["type": "string", "enum": Computer.keys.keys.sorted()],
        ], required: ["expectedPid", "key"]),
        Tool("type_text", "Send literal Unicode text to the focused control of the expected foreground app.", fields: [
            "expectedPid": pid, "text": ["type": "string", "minLength": 1],
        ], required: ["expectedPid", "text"]),
    ]

    static func main() async {
        if CommandLine.arguments.dropFirst().elementsEqual(["--version"]) {
            print("trylo-macos-mcp \(version)")
            return
        }
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments.first == "--permissions" {
            guard arguments.count <= 2, arguments.count == 1 || ["accessibility", "screen"].contains(arguments[1]) else {
                FileHandle.standardError.write(Data("Invalid permission request\n".utf8))
                exit(2)
            }
            do {
                let result = Computer.permissions(request: arguments.count == 2 ? arguments[1] : nil)
                let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
                print(String(decoding: data, as: UTF8.self))
            } catch { exit(1) }
            return
        }
        while let line = readLine() {
            guard !line.isEmpty else { continue }
            do {
                let message = try await response(to: line)
                if let message {
                    var data = try JSONSerialization.data(withJSONObject: message)
                    data.append(0x0a)
                    try FileHandle.standardOutput.write(contentsOf: data)
                }
            } catch {
                FileHandle.standardError.write(Data("trylo-macos-mcp: could not write response\n".utf8))
                return
            }
        }
    }

    private static func response(to line: String) async throws -> Object? {
        let parsed: Any
        do { parsed = try JSONSerialization.jsonObject(with: Data(line.utf8), options: [.fragmentsAllowed]) }
        catch { return errorResponse(id: NSNull(), code: -32700, message: "Parse error") }
        guard let request = parsed as? Object, request["jsonrpc"] as? String == "2.0",
              let method = request["method"] as? String else {
            return errorResponse(id: NSNull(), code: -32600, message: "Invalid request")
        }
        guard let id = request["id"] else { return nil }
        let params = request["params"] as? Object ?? [:]
        let result: Object
        switch method {
        case "initialize":
            let offered = params["protocolVersion"] as? String
            result = ["protocolVersion": offered.flatMap { protocols.contains($0) ? $0 : nil } ?? protocols[0],
                      "serverInfo": ["name": "trylo-macos", "version": version], "capabilities": ["tools": [:]]]
        case "ping": result = [:]
        case "tools/list": result = ["tools": tools.map(\.specification)]
        case "tools/call": result = await call(params)
        default: return errorResponse(id: id, code: -32601, message: "Method not found")
        }
        return ["jsonrpc": "2.0", "id": id, "result": result]
    }

    private static func call(_ params: Object) async -> Object {
        do {
            guard let name = params["name"] as? String, let tool = tools.first(where: { $0.name == name }) else {
                throw ComputerError("unknown_tool", "Use one of the tools returned by tools/list.")
            }
            guard let arguments = (params["arguments"] ?? [:]) as? Object else {
                throw ComputerError("invalid_arguments", "arguments must be an object.")
            }
            try tool.validate(arguments)
            let content: [Object]
            switch tool.name {
            case "status": content = [try textContent(Computer.status())]
            case "inspect": content = [try textContent(Computer.inspect(arguments))]
            case "click": content = [try textContent(Computer.click(arguments))]
            case "press_key": content = [try textContent(Computer.pressKey(arguments))]
            case "type_text": content = [try textContent(Computer.typeText(arguments))]
            case "screenshot": content = try await Computer.screenshot(arguments)
            default: throw ComputerError("unknown_tool", "Use one of the tools returned by tools/list.")
            }
            return ["content": content]
        } catch let reason as ComputerError {
            return ["isError": true, "content": [["type": "text", "text": "\(reason.code): \(reason.message)"]]]
        } catch {
            return ["isError": true, "content": [["type": "text", "text": "native_error: \(error.localizedDescription)"]]]
        }
    }

    private static func errorResponse(id: Any, code: Int, message: String) -> Object {
        ["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": message]]
    }
}
