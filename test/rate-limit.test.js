"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createWindowCounter } = require("../lib/rate-limit");

test("window counter enforces limits and bounds stored keys", () => {
  const counter = createWindowCounter({ windowMs: 60_000, max: 2, maxEntries: 3 });
  assert.equal(counter.consume("same").allowed, true);
  assert.equal(counter.consume("same").allowed, true);
  const blocked = counter.consume("same");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0);

  counter.consume("one");
  counter.consume("two");
  counter.consume("three");
  counter.consume("four");
  assert.ok(counter.size() <= 3);
});
