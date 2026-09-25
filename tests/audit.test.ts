import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSession, sumUsage } from "../src/audit.js";

test("parses token events without returning transcript content", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-audit-"));
  const file = path.join(directory, "rollout.jsonl");
  await writeFile(file, [
    JSON.stringify({ type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { cwd: "/work/demo" } }),
    JSON.stringify({ type: "turn_context", timestamp: "2026-01-01T00:00:01Z", payload: { model: "test-model" } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-01-01T00:00:02Z", payload: { content: "private prompt" } }),
    JSON.stringify({ type: "token_usage_record", timestamp: "2026-01-01T00:00:03Z", payload: {
      session_id: "s", thread_id: "t", turn_id: "1", response_id: "r1",
      usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 110 },
    } }),
  ].join("\n"));

  const session = await parseSession(file);
  assert.equal(session?.project, "demo");
  assert.equal(session?.model, "test-model");
  assert.equal(session?.totalTokens, 110);
  assert.equal(session?.cachedInputTokens, 80);
  assert.deepEqual(sumUsage(session ? [session] : []), {
    inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 0,
    outputTokens: 10, reasoningOutputTokens: 4, totalTokens: 110,
  });
});
