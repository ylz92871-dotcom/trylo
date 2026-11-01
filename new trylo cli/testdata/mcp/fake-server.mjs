// Fake MCP stdio server for the mcp-stdio client tests.
//
// Node standard-library only: no third-party dependency. It speaks NDJSON
// JSON-RPC 2.0 over stdio the same way the client does, and it is a real child
// process — the client tests spawn it with `process.execPath` rather than
// mocking `spawn`.
//
// Scenario is the first argv value; everything else is a convenience override.
// Each scenario exists to provoke exactly one contract under test:
//
//   ok                       normal handshake; publishes echo / fail / hash
//                            plus two resources, one template, and read for both
//                            (unknown URIs fail with -32002)
//   version-mismatch        initialize replies with a revision the client rejects
//   version-other           initialize replies with "2024-11-05" (also supported)
//   exit                     exits immediately, writing nothing
//   garbage                  writes non-JSON to stdout and exits
//   stderr                   writes >64KiB of stderr (client metadata truncation)
//   timeout                  answers initialize+list, but never tools/call
//   elicitation              sends elicitation/create after the handshake
//   sampling                 sends sampling/createMessage after the handshake
//   notification-elicitation sends a notifications/elicitation notification
//   bad-tool                 publishes a tool named "a__b" (separator attack)
//   bad-schema               publishes a tool whose inputSchema is a string
//   big-frame                tools/call returns a single line larger than 8MiB

import readline from "node:readline";

const scenario = process.argv[2] ?? "ok";

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (scenario === "exit") {
  process.exit(0);
}

if (scenario === "garbage") {
  process.stdout.write("this is not json\nneither is this\n");
  process.exit(0);
}

if (scenario === "stderr") {
  // 100 KiB, well past the client's 64 KiB stderr budget.
  process.stderr.write("noise ".repeat(20000));
}

function protocolVersion() {
  if (scenario === "version-mismatch") {
    return "1999-01-01";
  }
  if (scenario === "version-other") {
    return "2024-11-05";
  }
  return "2025-03-26";
}

function toolsFor() {
  const tools = [
    {
      name: "echo",
      description: "echo back the supplied text",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "fail",
      description: "always fails",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "hash",
      description: "returns structured content",
      inputSchema: { type: "object", properties: {} },
    },
  ];
  if (scenario === "bad-tool") {
    tools.push({ name: "a__b", description: "sneaky separator", inputSchema: { type: "object" } });
  }
  if (scenario === "bad-schema") {
    tools.push({ name: "weird", description: "schema is a string", inputSchema: "not-an-object" });
  }
  return tools;
}

const tools = toolsFor();

const reader = readline.createInterface({ input: process.stdin, terminal: false });

reader.on("line", (line) => {
  if (line.trim() === "") {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const method = message.method;
  const id = message.id;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: protocolVersion(),
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "fake-server", version: "1.0.0" },
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    // A notification has no id and expects no reply; here is also where a
    // misbehaving server would start asking for capabilities it was not given.
    if (scenario === "elicitation") {
      send({ jsonrpc: "2.0", id: 9001, method: "elicitation/create", params: { message: "help me" } });
    } else if (scenario === "sampling") {
      send({ jsonrpc: "2.0", id: 9002, method: "sampling/createMessage", params: { messages: [] } });
    } else if (scenario === "notification-elicitation") {
      // A capability *method* fired as a bare notification: no id, so the client
      // cannot reply — the only honest answer is to close the child.
      send({ jsonrpc: "2.0", method: "elicitation/create", params: {} });
    }
    return;
  }

  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }

  if (method === "resources/list") {
    if (scenario === "timeout") {
      // Deliberately no reply: the listing deadline must fire here too.
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      result: {
        resources: [
          { uri: "file:///notes/today.md", name: "today", mimeType: "text/markdown" },
          { uri: "binary:///logo.png", name: "logo", mimeType: "image/png" },
        ],
      },
    });
    return;
  }

  if (method === "resources/templates/list") {
    if (scenario === "timeout") {
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      result: { resourceTemplates: [{ uriTemplate: "file:///logs/{date}.log", name: "logs" }] },
    });
    return;
  }

  if (method === "resources/read") {
    if (scenario === "timeout") {
      // Deliberately no reply: the client's deadline must fire here too.
      return;
    }
    const uri = message.params?.uri;
    if (uri === "file:///notes/today.md") {
      send({
        jsonrpc: "2.0",
        id,
        result: { contents: [{ uri, mimeType: "text/markdown", text: "# today\nshipped WP15" }] },
      });
      return;
    }
    if (uri === "binary:///logo.png") {
      send({ jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "image/png", blob: "aGVsbG8=" }] } });
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32002, message: `unknown resource ${uri}` } });
    return;
  }

  if (method === "tools/call") {
    if (scenario === "timeout") {
      // Deliberately no reply: the client's deadline must fire.
      return;
    }
    if (scenario === "big-frame") {
      // A single frame far past the 8MiB ceiling the client enforces.
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }] } });
      return;
    }
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (name === "fail") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "the tool failed" }], isError: true } });
      return;
    }
    if (name === "hash") {
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "hashed" }], structuredContent: { digest: "abc123" } },
      });
      return;
    }
    const text = typeof args.text === "string" ? args.text : "";
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `echo:${text}` }],
        structuredContent: { echoed: true },
      },
    });
    return;
  }

  if (method === "input-required") {
    // A tool result that asks for another round trip (D3 §10.11 refusal path).
    send({
      jsonrpc: "2.0",
      id,
      result: { resultType: "input_required", content: [{ type: "text", text: "more?" }] },
    });
    return;
  }

  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
});
