import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { isTimerRunning, MAX_TIMER_DELAY_MS, startTimer, stopTimer } from "../src/utils/timer.js";

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

void test("monthly intervals wait a full month instead of overflowing to 1 ms", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let runs = 0;
  try {
    assert.ok(MONTH_MS > MAX_TIMER_DELAY_MS);
    startTimer(MONTH_MS, () => {
      runs += 1;
    });
    assert.equal(runs, 1, "runs immediately without an initial delay");

    mock.timers.tick(MAX_TIMER_DELAY_MS);
    mock.timers.tick(1000);
    assert.equal(runs, 1);
    assert.equal(isTimerRunning(), true);

    mock.timers.tick(MONTH_MS - MAX_TIMER_DELAY_MS - 1000);
    assert.equal(runs, 2);
  } finally {
    stopTimer();
    mock.timers.reset();
  }
});

void test("long initial delays are honored and stopTimer cancels between chunks", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let runs = 0;
  try {
    startTimer(
      MONTH_MS,
      () => {
        runs += 1;
      },
      { initialDelayMs: MONTH_MS }
    );
    mock.timers.tick(MAX_TIMER_DELAY_MS);
    assert.equal(runs, 0);
    stopTimer();
    assert.equal(isTimerRunning(), false);
    mock.timers.tick(MONTH_MS);
    assert.equal(runs, 0);
  } finally {
    stopTimer();
    mock.timers.reset();
  }
});
