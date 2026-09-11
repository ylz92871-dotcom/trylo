// Trylo Desktop — RunTelemetry tests.
//
// M4-C5 (§7.2): the telemetry store splits cold vs warm latency
// into the segments the audit couldn't measure. These tests pin
// the schema, the monotonic guard, and the derived-latency slicing
// (child-created vs CLI-ready vs provider TTFT must stay separate).

import { describe, expect, it } from 'vitest';
import { RunTelemetry } from './run-telemetry';

describe('RunTelemetry', () => {
  it('keeps each mark first-write-wins', () => {
    const t = new RunTelemetry({ mode: 'code' });
    t.mark('sendClickAt', 1000);
    t.mark('sendClickAt', 9999); // ignored
    expect(t.finish().marks.sendClickAt).toBe(1000);
  });

  it('refuses a mark that contradicts already-set monotonic order', () => {
    const t = new RunTelemetry({ mode: 'code' });
    t.mark('cliSessionReadyAt', 800);
    // spawnRequestedAt sits BEFORE cliSessionReadyAt in the order:
    // adding it at a time LATER than the already-set ready mark
    // violates monotonicity → refused.
    t.mark('spawnRequestedAt', 2000);
    expect(t.finish().marks.spawnRequestedAt).toBeUndefined();
    // A valid earlier slot (before ready) is accepted.
    t.mark('spawnRequestedAt', 0);
    expect(t.finish().marks.spawnRequestedAt).toBe(0);
  });

  it('coldOrWarm only sticks on first declaration', () => {
    const t = new RunTelemetry({ mode: 'code' });
    t.setColdOrWarm('cold');
    t.setColdOrWarm('warm');
    expect(t.finish().coldOrWarm).toBe('cold');
  });

  it('derived latencies appear only when both endpoints exist', () => {
    const t = new RunTelemetry({ mode: 'code' });
    t.mark('sendClickAt', 0);
    t.mark('spawnRequestedAt', 0);
    t.mark('childCreatedAt', 100);
    t.mark('cliSessionReadyAt', 800);
    t.mark('providerRequestStartedAt', 900);
    t.mark('firstSemanticEventAt', 1400);
    t.mark('firstPaintAt', 1500);
    t.mark('terminalAt', 4000);
    t.setColdOrWarm('cold');
    const d = t.derived();
    expect(d.spawnLatency).toBe(100);
    expect(d.runtimeReadyLatency).toBe(700);
    expect(d.runtimeQueueLatency).toBe(100);
    expect(d.providerTTFT).toBe(500);
    expect(d.adapterLatency).toBe(100);
    expect(d.uiSubmitToPaint).toBe(1500);
    expect(d.totalDuration).toBe(4000);
    expect(d.eventToSemantic).toBeUndefined(); // firstRawFrameAt never set
  });

  it('warm reuse maps spawnLatency to the reuse slice', () => {
    const t = new RunTelemetry({ mode: 'code' });
    t.setColdOrWarm('warm');
    t.mark('reuseAttemptAt', 0);
    t.mark('reuseOkAt', 40);
    const d = t.derived();
    expect(d.spawnLatency).toBe(40);
    expect(d.runtimeReadyLatency).toBeUndefined();
    expect(d.providerTTFT).toBeUndefined();
  });

  it('carries the grouping dimensions', () => {
    const t = new RunTelemetry({
      mode: 'work',
      projectKey: 'proj',
      conversationId: 'conv',
      model: 'claude-3.7',
      provider: 'anthropic',
      historyMessageCount: 12,
      historyApproxBytes: 2048,
    });
    const s = t.finish();
    expect(s.mode).toBe('work');
    expect(s.model).toBe('claude-3.7');
    expect(s.provider).toBe('anthropic');
    expect(s.historyMessageCount).toBe(12);
    expect(s.historyApproxBytes).toBe(2048);
  });
});