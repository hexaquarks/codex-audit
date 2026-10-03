import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary, TokenUsage, ToolCall } from "../src/audit.js";
import { findInsights, InsightKind } from "../src/insights.js";

const createUsage = (inputTokens: number, totalTokens = inputTokens): TokenUsage => ({
	inputTokens,
	cachedInputTokens: 0,
	cacheWriteInputTokens: 0,
	outputTokens: 0,
	reasoningOutputTokens: 0,
	totalTokens,
});

const createToolCall = (overrides: Partial<ToolCall> = {}): ToolCall => ({
	timestamp: "2026-01-01T00:00:00Z",
	name: "exec",
	callId: "call-1",
	fingerprint: "exec:redacted",
	failed: false,
	editsFiles: false,
	...overrides,
});

const createSession = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
	file: "session.jsonl",
	sessionId: "session",
	project: "demo",
	projectPath: "/work/demo",
	model: "test-model",
	lastActivity: "2026-01-01T00:00:00Z",
	usageRecords: 1,
	malformedLines: 0,
	modelContextWindow: 100_000,
	latestActiveContext: createUsage(10_000),
	turns: [],
	tools: [],
	...createUsage(10_000),
	...overrides,
});

test("uses active context rather than cumulative session usage for crowded context", () => {
	const insights = findInsights([
		createSession({
			latestActiveContext: createUsage(81_000),
			totalTokens: 9_000_000,
		}),
	]);

	assert.equal(insights[0]?.kind, InsightKind.CrowdedContext);
	assert.equal(insights[0]?.title, "Context is getting tight");
	assert.match(insights[0]?.cause ?? "", /81%/);
	assert.match(insights[0]?.method ?? "", /input tokens logged/);
});

test("flags an output that is unusually large for its session", () => {
	const tools = [1, 2, 3, 4].map((number) =>
		createToolCall({
			timestamp: `2026-01-01T00:00:0${number}Z`,
			callId: `call-${number}`,
			fingerprint: `exec:${number}`,
			outputBytes: number === 4 ? 80_000 : 10_000,
		}),
	);

	const insight = findInsights([createSession({ tools })]).find(
		(item) => item.kind === InsightKind.LargeToolOutputs,
	);

	assert.ok(insight);
	assert.equal(insight.title, "Unusually large tool output");
	assert.match(insight.cause, /8 times larger/);
	assert.equal(
		insight.action,
		"Run a narrower command or limit its output to the lines you need.",
	);
});

test("tailors large-output advice to a file read", () => {
	const tools = [1, 2, 3, 4].map((number) =>
		createToolCall({
			timestamp: `2026-01-01T00:00:0${number}Z`,
			callId: `call-${number}`,
			name: "read_file",
			fingerprint: `read_file:${number}`,
			outputBytes: number === 4 ? 80_000 : 10_000,
		}),
	);

	const insight = findInsights([createSession({ tools })]).find(
		(item) => item.kind === InsightKind.LargeToolOutputs,
	);

	assert.equal(insight?.action, "Read only the relevant section instead of the whole file.");
});

test("flags a retry loop when failed commands repeat without a state change", () => {
	const tools = [1, 2, 3].map((number) =>
		createToolCall({
			timestamp: `2026-01-01T00:00:0${number}Z`,
			callId: `call-${number}`,
			outputBytes: 20,
			failed: true,
		}),
	);

	const insight = findInsights([createSession({ tools })]).find(
		(item) => item.kind === InsightKind.RetryLoop,
	);

	assert.ok(insight);
	assert.equal(insight.title, "Retry loop");
	assert.match(insight.cause, /repeated 3 times/);
});

test("flags a redundant read when the same file is read without a state change", () => {
	const tools = [1, 2, 3].map((number) =>
		createToolCall({
			timestamp: `2026-01-01T00:00:0${number}Z`,
			callId: `call-${number}`,
			name: "read_file",
			fingerprint: "read_file:package.json",
			outputBytes: 20,
		}),
	);

	const insight = findInsights([createSession({ tools })]).find(
		(item) => item.kind === InsightKind.RedundantRead,
	);

	assert.ok(insight);
	assert.equal(insight.title, "Redundant read");
	assert.match(insight.cause, /repeated 3 times/);
});

test("does not flag repeated behavior when a file edit separates attempts", () => {
	const tools = [
		createToolCall({ callId: "call-1", outputBytes: 20, failed: true }),
		createToolCall({ callId: "call-2", outputBytes: 20, failed: true }),
		createToolCall({
			callId: "call-3",
			fingerprint: "apply_patch:redacted",
			editsFiles: true,
			outputBytes: 20,
		}),
		createToolCall({ callId: "call-4", outputBytes: 20, failed: true }),
	];

	const insight = findInsights([createSession({ tools })]).find(
		(item) => item.kind === InsightKind.RetryLoop,
	);

	assert.equal(insight, undefined);
});

test("does not flag similarly sized tool outputs as unusual", () => {
	const tools = [1, 2, 3, 4].map((number) =>
		createToolCall({
			callId: `call-${number}`,
			fingerprint: `exec:${number}`,
			outputBytes: 13_000,
		}),
	);

	const insight = findInsights([createSession({ tools })]).find(
		(item) => item.kind === InsightKind.LargeToolOutputs,
	);

	assert.equal(insight, undefined);
});
