import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSession, readSessionSummaries, sumUsage } from "../src/audit.js";

const createTemporarySessionFile = async (lines: readonly string[]): Promise<string> => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-audit-"));
    const file = path.join(directory, "rollout.jsonl");

    await writeFile(file, lines.join("\n"));

    return file;
};

const tokenCountEvent = (total: number, last: number): string =>
    JSON.stringify({
        type: "event_msg",
        timestamp: `2026-01-01T00:00:${total.toString().padStart(2, "0")}Z`,
        payload: {
            type: "token_count",
            info: {
                total_token_usage: { input_tokens: total, total_tokens: total },
                last_token_usage: { input_tokens: last, total_tokens: last },
                model_context_window: 1_000,
            },
        },
    });

test("parses usage without returning transcript content", async () => {
    const file = await createTemporarySessionFile([
        JSON.stringify({
            type: "session_meta",
            timestamp: "2026-01-01T00:00:00Z",
            payload: { cwd: "/work/demo" },
        }),
        JSON.stringify({
            type: "turn_context",
            timestamp: "2026-01-01T00:00:01Z",
            payload: { model: "test-model" },
        }),
        JSON.stringify({
            type: "response_item",
            timestamp: "2026-01-01T00:00:02Z",
            payload: { content: "private prompt" },
        }),
        JSON.stringify({
            type: "token_usage_record",
            timestamp: "2026-01-01T00:00:03Z",
            payload: {
                usage: {
                    input_tokens: 100,
                    cached_input_tokens: 80,
                    output_tokens: 10,
                    reasoning_output_tokens: 4,
                    total_tokens: 110,
                },
            },
        }),
    ]);

    const session = await parseSession(file);

    assert.equal(session?.project, "demo");
    assert.equal(session?.model, "test-model");
    assert.equal(session?.totalTokens, 110);
    assert.equal(session?.cachedInputTokens, 80);
    assert.deepEqual(sumUsage(session ? [session] : []), {
        inputTokens: 100,
        cachedInputTokens: 80,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
        reasoningOutputTokens: 4,
        totalTokens: 110,
    });
});

test("uses the latest cumulative snapshot without summing repeated call usage", async () => {
    const file = await createTemporarySessionFile([
        JSON.stringify({
            type: "session_meta",
            timestamp: "2026-01-01T00:00:00Z",
            payload: { cwd: "/work/demo", id: "root" },
        }),
        tokenCountEvent(100, 100),
        tokenCountEvent(150, 100),
    ]);

    const session = await parseSession(file);

    assert.equal(session?.totalTokens, 150);
    assert.equal(session?.latestActiveContext?.totalTokens, 100);
    assert.equal(session?.modelContextWindow, 1_000);
});

test("attaches one tool result to the matching tool call in a turn", async () => {
    const file = await createTemporarySessionFile([
        JSON.stringify({
            type: "session_meta",
            timestamp: "2026-01-01T00:00:00Z",
            payload: { cwd: "/work/demo", id: "root" },
        }),
        JSON.stringify({
            type: "response_item",
            timestamp: "2026-01-01T00:00:01Z",
            payload: { type: "message", role: "user" },
        }),
        JSON.stringify({
            type: "response_item",
            timestamp: "2026-01-01T00:00:02Z",
            payload: { type: "function_call", name: "exec", arguments: "redacted", call_id: "call-1" },
        }),
        JSON.stringify({
            type: "response_item",
            timestamp: "2026-01-01T00:00:03Z",
            payload: { type: "function_call_output", call_id: "call-1", output: "tool result" },
        }),
        tokenCountEvent(100, 50),
    ]);

    const session = await parseSession(file);
    const tool = session?.turns[0]?.tools[0];

    assert.equal(session?.turns[0]?.tools.length, 1);
    assert.equal(tool?.name, "exec");
    assert.equal(tool?.outputBytes, Buffer.byteLength("tool result"));
});

test("excludes forked sessions from root session summaries", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-audit-"));
    const root = path.join(directory, "root.jsonl");
    const fork = path.join(directory, "fork.jsonl");

    await writeFile(root, [
        JSON.stringify({
            type: "session_meta",
            timestamp: "2026-01-01T00:00:00Z",
            payload: { cwd: "/work/demo", id: "root" },
        }),
        tokenCountEvent(100, 100),
    ].join("\n"));
    await writeFile(fork, [
        JSON.stringify({
            type: "session_meta",
            timestamp: "2026-01-01T00:00:00Z",
            payload: { cwd: "/work/demo", id: "fork", parent_session_id: "root" },
        }),
        tokenCountEvent(200, 100),
    ].join("\n"));

    const sessions = await readSessionSummaries(directory);

    assert.deepEqual(sessions.map((session) => session.sessionId), ["root"]);
});
