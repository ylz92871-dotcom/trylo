import assert from "node:assert/strict";
import { test } from "node:test";
import { ExactTiming } from "./exact.js";
import { failTiming, runTimingJson, TimingStop, type TimingFailure } from "./boundary.js";

const fails = (status: TimingFailure["status"], reason: string) => (error: unknown) =>
  error instanceof TimingStop && error.failure.status === status && error.failure.reason === reason;

test("exact timing distinguishes binary64 values from non-dyadic fraction literals", () => {
  const exact = new ExactTiming();

  assert.equal(exact.text(exact.from(0.1)), "3602879701896397/36028797018963968");
  const third = exact.from("1/3");

  assert.equal(exact.text(exact.add(third, third)), "2/3");
  assert.equal(exact.text(exact.div(exact.one, exact.from(3))), "1/3");
  assert.deepEqual(exact.normalize([exact.from(1), exact.from(2)]).map(value => exact.text(value)), ["1/3", "2/3"]);
  assert.equal(exact.text(exact.from(-0)), "0/1");
  assert.throws(() => exact.from("0.1"), fails("invalid_input", "invalid_fraction_literal"));
});

test("a positive rare contribution remains exact below binary64 underflow", () => {
  const exact = new ExactTiming();
  const contribution = exact.mul(exact.from(Number.MIN_VALUE), exact.from("1/2"));
  assert.equal(exact.compare(contribution, exact.zero), 1);
  assert.equal(exact.text(contribution), `1/${1n << 1075n}`);
});

test("work caps and instance ownership fail explicitly rather than returning a prefix value", () => {
  const small = new ExactTiming(16), other = new ExactTiming(16);

  assert.throws(() => small.mul(small.from(256), small.from(256)), fails("numeric_limit", "rational_work_bits"));
  assert.throws(() => small.from("65536/1"), fails("numeric_limit", "rational_work_bits"));
  assert.throws(() => small.add(small.one, other.one), fails("invalid_input", "foreign_or_invalid_rational"));
  assert.throws(() => small.text({ n: 1n, d: 1n }), fails("invalid_input", "foreign_or_invalid_rational"));
  assert.throws(() => small.div(small.one, small.zero), fails("invalid_input", "division_by_zero"));
  assert.throws(() => small.normalize([small.zero]), fails("invalid_input", "zero_weight_total"));
  assert.throws(() => new ExactTiming(4097), fails("invalid_input", "invalid_numeric_bits"));
});

test("JSON boundary translates only parser syntax and known timing failures", () => {
  assert.deepEqual(runTimingJson("{", raw => raw), { status: "invalid_input", reason: "invalid_json", at: "input" });
  assert.deepEqual(runTimingJson(" ".repeat(65537), raw => raw),
    { status: "invalid_input", reason: "json_size_limit", at: "input" });
  assert.deepEqual(runTimingJson("null", () => failTiming("planning_limit", "nodes", "graph")),
    { status: "planning_limit", reason: "nodes", at: "graph" });
  const unexpected = new Error("unexpected-evaluator-error");
  const evaluatorSyntax = new SyntaxError("not-a-parser-error");

  assert.throws(() => runTimingJson("null", () => { throw unexpected; }), (error: unknown) => error === unexpected);
  assert.throws(() => runTimingJson("null", () => { throw evaluatorSyntax; }), (error: unknown) => error === evaluatorSyntax);
});
