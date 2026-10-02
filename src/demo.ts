import { InsightKind, type Insight } from "./insights.js";
import type { AuditSnapshot } from "./snapshot.js";

const demoInsights: Insight[] = [
	{
		kind: InsightKind.RetryLoop,
		rank: 100,
		title: "Retry loop",
		cause: "The same failed terminal command was repeated 3 times without a detected file edit between attempts.",
		action: "Check the first failure before trying again. Change the command, its inputs, or the relevant files first.",
		events: [
			{
				session: "sample-app",
				timestamp: "2026-09-27T14:10:00Z",
				activity: "Terminal command",
				detail: "Failed again without a detected file edit between attempts.",
			},
			{
				session: "sample-app",
				timestamp: "2026-09-27T14:12:00Z",
				activity: "Terminal command",
				detail: "Failed again without a detected file edit between attempts.",
			},
			{
				session: "sample-app",
				timestamp: "2026-09-27T14:14:00Z",
				activity: "Terminal command",
				detail: "Failed again without a detected file edit between attempts.",
			},
		],
		method: "Matches identical failed actions when the session log does not show a file edit between attempts.",
		caveat: "Demo data only. In a real report, edit detection is conservative; an unrecognized or external edit may not be visible in the log.",
	},
	{
		kind: InsightKind.CrowdedContext,
		rank: 90,
		title: "Limited room for the next steps",
		cause: "The latest request in 1 recent conversation is using 78% of its model context window. That leaves about 22% for further messages, tool results, and replies.",
		action: "If more investigation is ahead, save a short handoff before adding large results or changing topics.",
		events: [
			{
				session: "sample-app",
				timestamp: "2026-09-27T14:20:00Z",
				recordedTokens: 199_680,
				contextWindowTokens: 256_000,
				detail: "199,680 active input tokens of 256,000 (78%)",
			},
		],
		method: "75% is this tool's working-room guardrail. It compares the input tokens logged for the latest request with that model's logged context window; it is not a model limit.",
		caveat: "Demo data only. A conversation can still continue normally at this level, and the report cannot predict answer quality or when the window will fill.",
	},
	{
		kind: InsightKind.LargeToolOutputs,
		rank: 80,
		title: "Unusually large tool output",
		cause: "86,000 bytes from a terminal command was about 7 times larger than the typical recorded output in that session. If later included in requests, that much text can use substantial conversation room.",
		action: "Run a narrower command or limit its output to the lines you need.",
		events: [
			{
				session: "sample-app",
				timestamp: "2026-09-27T14:30:00Z",
				activity: "Terminal command",
				recordedBytes: 86_000,
				detail: "About 86,000 bytes recorded.",
			},
			{
				session: "sample-app",
				timestamp: "2026-09-27T14:32:00Z",
				activity: "File read",
				recordedBytes: 12_000,
				detail: "About 12,000 bytes recorded.",
			},
			{
				session: "sample-api",
				timestamp: "2026-09-27T14:34:00Z",
				activity: "Project search",
				recordedBytes: 11_000,
				detail: "About 11,000 bytes recorded.",
			},
			{
				session: "sample-api",
				timestamp: "2026-09-27T14:35:00Z",
				activity: "Terminal command",
				recordedBytes: 10_000,
				detail: "About 10,000 bytes recorded.",
			},
		],
		method: "Compares recorded output sizes within each session and flags results at least 4 times the session median. Codex logs do not record per-result token use or whether later requests included the result.",
		caveat: "Demo data only. Recorded bytes measure text volume, not token use or cost, and cannot confirm how much of the result later entered model context.",
	},
];

// Provides predictable evidence for reviewing every insight currently shown in the dashboard.
export const createDemoAuditSnapshot = (): AuditSnapshot => ({
	generatedAt: "2026-09-27T14:40:00Z",
	isDemo: true,
	sessions: [
		{
			project: "sample-app",
			lastActivity: "2026-09-27T14:35:00Z",
			totalTokens: 310_000,
			activeContextTokens: 199_680,
			contextWindowTokens: 256_000,
		},
		{
			project: "sample-api",
			lastActivity: "2026-09-27T14:35:00Z",
			totalTokens: 145_000,
			activeContextTokens: 62_000,
			contextWindowTokens: 256_000,
		},
	],
	totals: {
		inputTokens: 370_000,
		cachedInputTokens: 250_000,
		cacheWriteInputTokens: 0,
		outputTokens: 65_000,
		reasoningOutputTokens: 20_000,
		totalTokens: 455_000,
	},
	insights: demoInsights,
});
