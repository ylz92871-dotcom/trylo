// Trylo Work — Work capability components. See README.md.
//
// v1.16.5+ (M3, W-UI-003): the previous WorkPanel was a
// page shell (bar + chat slot wrapper) that gave Work a
// second layout around the shared conversation surface.
// It is gone. What remains of the Work capability is:
//   - WorkDiagnostics: a self-contained toggle + drawer
//     that exposes raw runtime bookkeeping (diagnostic
//     records + connection status). Default CLOSED,
//     absolutely positioned top-right by the host, so it
//     never takes first-screen real estate.
//   - ApiKeyMissingBanner: the "configure your provider"
//     banner the surface shows in its banner slot.
// Both render inside the shared AgentConversationSurface
// — Work no longer owns a timeline, composer, or scroll
// container.
//
// M3 closure (spec §10, fixing M3-P1-07 / M3-P2-03):
//   - the drawer opens even with ZERO events — the
//     connection state, the last connection error and
//     the retry hint are always shown (spec §10.2);
//   - records carry routeDecision + severity, so
//     dropped/replayed/late frames are never disguised
//     as normal log lines;
//   - a search box locates an ErrorCard's diagnosticId
//     exactly (the error record reuses that id);
//   - details expose the REDACTED raw payload (large
//     text fields arrive as length markers);
//   - "Copy diagnostics" produces version / project /
//     task-run / connection / diagnosticId text.

import { useMemo, useState, type ReactElement } from "react";
import type { ClientStatus } from "../control-plane/types";
import type { DaemonEventLine } from "../consume-frame";

// Re-exported for hosts that imported DaemonEventLine
// from this module; the type now lives in the core
// (consume-frame) so the runtime never imports renderer
// types (M3-P2-04).
export type { DaemonEventLine };

const STATUS_LABEL: Record<ClientStatus, string> = {
  disconnected: "disconnected",
  connecting: "connecting…",
  handshaking: "handshaking…",
  connected: "connected",
  error: "error",
};

/** Records shown at once; the App-side store keeps the
 *  same bound (spec §13.1 capacity policy). */
const MAX_VISIBLE = 50;

export interface WorkDiagnosticsProps {
  /** Recent diagnostic records. Newest first. */
  readonly daemonEvents: readonly DaemonEventLine[];
  /** Authoritative ControlPlane connection status — the
   *  client owns it; this component only displays it. */
  readonly connectionStatus?: ClientStatus;
  /** Last connection error reported by the client
   *  (spec §10.2: visible even before any event). */
  readonly connectionError?: string;
  /** Project identifier for the copy-diagnostics text. */
  readonly projectKey?: string;
  /** Active task/run binding for the copy text. */
  readonly activeTask?: { readonly taskId: string; readonly runId: string };
  /** Host application version for the copy text. */
  readonly appVersion?: string;
}

export function WorkDiagnostics(props: WorkDiagnosticsProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const lines = useMemo(() => {
    const q = query.trim().toLowerCase();
    const source = props.daemonEvents.slice(0, MAX_VISIBLE);
    if (q.length === 0) return source;
    return source.filter(
      (l) =>
        l.id.toLowerCase().includes(q) ||
        l.summary.toLowerCase().includes(q) ||
        (l.eventType ?? "").toLowerCase().includes(q),
    );
  }, [props.daemonEvents, query]);

  const connDown =
    props.connectionStatus === "error" ||
    props.connectionStatus === "disconnected";

  const copyDiagnostics = (): void => {
    // Spec §10.2: version, project identifier, task/run,
    // connection state and diagnosticId in one block.
    const diagIds =
      expandedId !== null
        ? expandedId
        : lines.slice(0, 20).map((l) => l.id).join("\n  ");
    const text = [
      "Trylo Work diagnostics",
      `version: ${props.appVersion ?? "unknown"}`,
      `project: ${props.projectKey ?? "unknown"}`,
      `connection: ${
        props.connectionStatus !== undefined
          ? STATUS_LABEL[props.connectionStatus]
          : "unknown"
      }${props.connectionError ? ` (${props.connectionError})` : ""}`,
      `task: ${props.activeTask?.taskId ?? "none"}`,
      `run: ${props.activeTask?.runId ?? "none"}`,
      `diagnosticId:\n  ${diagIds.length > 0 ? diagIds : "none"}`,
    ].join("\n");
    const done = (): void => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => undefined);
      }
    } catch {
      // Clipboard unavailable — copying is best-effort.
    }
  };

  return (
    <div className="work-diagnostics-widget">
      <button
        type="button"
        className="work-diagnostics-widget__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="work-diagnostics"
        // Spec §10.2: the drawer must open even with zero
        // events — connection failures are otherwise
        // invisible (M3-P1-07).
        title="Runtime diagnostics & connection status"
      >
        Diagnostics
        {props.daemonEvents.length > 0 && (
          <span className="work-diagnostics-widget__count">
            {props.daemonEvents.length}
          </span>
        )}
      </button>
      {open && (
        <div
          id="work-diagnostics"
          className="work-diagnostics"
          role="region"
          aria-label="Work runtime diagnostics"
        >
          {props.connectionStatus !== undefined && (
            <p
              className={
                "work-diagnostics__status" +
                (connDown ? " work-diagnostics__status--down" : "")
              }
            >
              control plane: {STATUS_LABEL[props.connectionStatus]}
            </p>
          )}
          {props.connectionError !== undefined &&
            props.connectionError.length > 0 && (
              <p className="work-diagnostics__conn-error" role="alert">
                {props.connectionError}
              </p>
            )}
          {connDown && (
            <p className="work-diagnostics__retry-hint">
              连接不可用 — 客户端将自动重试；发送已暂停。
            </p>
          )}
          <div className="work-diagnostics__toolbar">
            <input
              className="work-diagnostics__search"
              type="search"
              placeholder="搜索 diagnosticId…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter diagnostics by id"
            />
            <button
              type="button"
              className="work-diagnostics__copy"
              onClick={copyDiagnostics}
            >
              {copied ? "已复制" : "复制诊断"}
            </button>
          </div>
          {lines.length === 0 ? (
            <p className="work-diagnostics__empty">
              {query.length > 0
                ? "没有匹配的诊断记录。"
                : "尚无事件记录 — 连接状态见上。"}
            </p>
          ) : (
            <ul className="work-diagnostics__list">
              {lines.map((line) => {
                const expanded = expandedId === line.id;
                return (
                  <li key={line.id} className="work-diagnostics__item">
                    <button
                      type="button"
                      className={
                        "work-diagnostics__line" +
                        (line.severity === "error"
                          ? " work-diagnostics__line--error"
                          : "")
                      }
                      onClick={() =>
                        setExpandedId(expanded ? null : line.id)
                      }
                      aria-expanded={expanded}
                      title={line.id}
                    >
                      <span className="work-diagnostics__time">
                        {new Date(line.at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                      <span className="work-diagnostics__event">
                        {line.event}
                      </span>
                      <span className="work-diagnostics__route">
                        {line.routeDecision}
                      </span>
                      <span className="work-diagnostics__summary">
                        {line.summary}
                      </span>
                    </button>
                    {expanded && (
                      <div className="work-diagnostics__details">
                        <div className="work-diagnostics__detail-grid">
                          <span>id</span>
                          <span>{line.id}</span>
                          {line.taskId !== undefined && (
                            <>
                              <span>task</span>
                              <span>{line.taskId}</span>
                            </>
                          )}
                          {line.runId !== undefined && (
                            <>
                              <span>run</span>
                              <span>{line.runId}</span>
                            </>
                          )}
                          {line.eventType !== undefined && (
                            <>
                              <span>type</span>
                              <span>{line.eventType}</span>
                            </>
                          )}
                          <span>severity</span>
                          <span>{line.severity}</span>
                        </div>
                        {line.normalizedError !== undefined && (
                          <p className="work-diagnostics__detail-error">
                            [{line.normalizedError.code}]{" "}
                            {line.normalizedError.userMessage}
                          </p>
                        )}
                        {line.rawPayloadRedacted !== undefined && (
                          <pre className="work-diagnostics__payload">
                            {line.rawPayloadRedacted}
                          </pre>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function ApiKeyMissingBanner(props: {
  readonly onOpenSettings?: () => void;
}): ReactElement {
  return (
    <div className="work-banner" role="status">
      <div className="work-banner__body">
        <strong className="work-banner__title">
          {/* M4-D: Work is not an Office document generator.
              The banner is capability-neutral. */}
          Configure an LLM provider
        </strong>
        <p className="work-banner__text">
          Work uses the same provider as Code. Open Settings to paste a key
          and get started.
        </p>
      </div>
      <button
        type="button"
        className="work-banner__cta"
        onClick={props.onOpenSettings}
        disabled={!props.onOpenSettings}
      >
        Open Settings
      </button>
    </div>
  );
}
