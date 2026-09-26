import assert from "node:assert/strict";
import test from "node:test";
import { parseCommandArguments } from "../src/cli.js";

test("uses five sessions when no limit is provided", () => {
    assert.deepEqual(parseCommandArguments([]), { kind: "report", sessionLimit: 5 });
});

test("uses the requested session limit", () => {
    assert.deepEqual(parseCommandArguments(["--limit", "10"]), {
        kind: "report",
        sessionLimit: 10,
    });
});

test("opens the latest saved dashboard", () => {
    assert.deepEqual(parseCommandArguments(["open"]), { kind: "open" });
});

test("rejects an invalid session limit", () => {
    assert.throws(() => parseCommandArguments(["--limit", "0"]), /positive integer/);
});

test("rejects a session option without a value", () => {
    assert.throws(() => parseCommandArguments(["--sessions"]), /needs a positive integer/);
});
