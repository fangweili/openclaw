import assert from "node:assert/strict";
import { test } from "node:test";
import { readAppActivity } from "./collect-app-activity.mjs";

const session = "agent:tutor-one:kids:profile-one";
const snapshot = {
  now: 1234,
  date: "2026-10-14",
  pet: { lastInteractionAt: 1200 },
  activity: { id: "saved-activity", completed: true },
  daily: { date: "2026-10-14", total: 3, completed: 1 },
  nextActivity: { id: "saved-next", title: "One more tiny mystery" },
};

test("reads only bound sessions with bounded joined CLI calls", () => {
  const calls = [];
  const result = readAppActivity(
    { "child-one": session },
    {
      run(...args) {
        calls.push(args);
        return { status: 0, stdout: JSON.stringify(snapshot) };
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "openclaw");
  assert.deepEqual(calls[0][1].slice(0, 5), [
    "gateway",
    "call",
    "kids.activity.get",
    "--params",
    JSON.stringify({ sessionKey: session }),
  ]);
  assert.equal(calls[0][2].timeout, 30000);
  assert.equal(calls[0][2].maxBuffer, 1024 * 1024);
  assert.deepEqual(result["child-one"], { complete: true, snapshot });
});

test("read errors are explicit coverage gaps without provider or credential diagnostics", () => {
  for (const response of [
    { status: 1, stdout: "secret credential error" },
    { status: 0, stdout: "{}" },
    { status: 0, stdout: "not json" },
    { status: null, error: new Error("timed out secret") },
  ]) {
    const result = readAppActivity(
      { "child-one": session },
      {
        run() {
          return response;
        },
      },
    );
    assert.deepEqual(result["child-one"], {
      complete: false,
      warning: "Saved app activity could not be read.",
    });
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
});

test("a sibling read failure does not invent a missing activity for the successful child", () => {
  let count = 0;
  const result = readAppActivity(
    { "child-one": session, "child-two": "agent:tutor-two:kids:profile-two" },
    {
      run() {
        return ++count === 1 ? { status: 0, stdout: JSON.stringify(snapshot) } : { status: 1 };
      },
    },
  );
  assert.equal(result["child-one"].complete, true);
  assert.equal(result["child-two"].complete, false);
});
