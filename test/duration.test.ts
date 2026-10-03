import assert from "node:assert/strict";
import test from "node:test";
import { parseLookbackDuration, parseScheduleDuration } from "../src/utils/duration.js";

void test("parseScheduleDuration only accepts schedule-safe units", () => {
  assert.deepEqual(parseScheduleDuration("1h"), {
    ms: 60 * 60 * 1000,
    display: "1 hour",
  });
  assert.deepEqual(parseScheduleDuration("daily"), {
    ms: 24 * 60 * 60 * 1000,
    display: "daily",
  });
  assert.equal(parseScheduleDuration("1m"), undefined);
});

void test("parseLookbackDuration distinguishes minutes from months", () => {
  assert.equal(parseLookbackDuration("30m"), 30 * 60 * 1000);
  assert.equal(parseLookbackDuration("1mo"), 30 * 24 * 60 * 60 * 1000);
  assert.equal(parseLookbackDuration("weekly"), undefined);
});

void test("parseScheduleDuration accepts the monthly alias offered by autocomplete", () => {
  assert.deepEqual(parseScheduleDuration("monthly"), {
    ms: 30 * 24 * 60 * 60 * 1000,
    display: "monthly",
  });
  assert.deepEqual(parseScheduleDuration("1mo"), {
    ms: 30 * 24 * 60 * 60 * 1000,
    display: "1 month",
  });
});
