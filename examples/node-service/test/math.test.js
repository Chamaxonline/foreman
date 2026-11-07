import { test } from "node:test";
import assert from "node:assert/strict";
import { mean, sum } from "../src/math.js";

test("sum adds numbers", () => {
  assert.equal(sum([1, 2, 3]), 6);
});

test("mean averages numbers", () => {
  assert.equal(mean([2, 4]), 3);
});
