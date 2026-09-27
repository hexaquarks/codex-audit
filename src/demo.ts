import { InsightKind, type Insight } from "./insights.js";
import type { AuditSnapshot } from "./snapshot.js";

const demoInsights: Insight[] = [
  {
    kind: InsightKind.RepeatedToolCalls,
    rank: 100,
    title: "Repeated failed action or file read",
    cause:
      "3 identical failed terminal commands were logged without a detected file edit between them.",
    action:
      "Inspect the earlier result before trying again. If you need the file again, reuse that result or request only the section that changed.",
    events: [
      {
        session: "sample-app",
        timestamp: "2026-09-27T14:10:00Z",
        activity: "Terminal command",
        detail: "Repeated without a detected file edit between attempts.",
      },
      {
        session: "sample-app",
        timestamp: "2026-09-27T14:12:00Z",
        activity: "Terminal command",
        detail: "Repeated without a detected file edit between attempts.",
      },
      {
        session: "sample-app",
        timestamp: "2026-09-27T14:14:00Z",
        activity: "Terminal command",
        detail: "Repeated without a detected file edit between attempts.",
      },
    ],
    method:
      "Matches identical failed actions or file reads when the session log does not show a file edit between attempts.",
    caveat:
      "Demo data only. In a real report, edit detection is conservative; an unrecognized or external edit may not be visible in the log.",
  },
  {
    kind: InsightKind.CrowdedContext,
    rank: 90,
    title: "Limited room for the next steps",
    cause:
      "The latest request in 1 recent conversation is using 78% of its model context window. That leaves about 22% for further messages, tool results, and replies.",
    action:
      "If more investigation is ahead, save a short handoff before adding large results or changing topics.",
    events: [
      {
        session: "sample-app",
        timestamp: "2026-09-27T14:20:00Z",
        recordedTokens: 199_680,
        contextWindowTokens: 256_000,
        detail: "199,680 active input tokens of 256,000 (78%)",
      },
    ],
    method:
      "75% is this tool's working-room guardrail. It compares the input tokens logged for the latest request with that model's logged context window; it is not a model limit.",
    caveat:
      "Demo data only. A conversation can still continue normally at this level, and the report cannot predict answer quality or when the window will fill.",
  },
  {
    kind: InsightKind.LargeToolOutputs,
    rank: 80,
    title: "Tool-output volume to review",
    cause:
      "4 tool outputs each contained at least 12,000 bytes of recorded text. Together, they contained 203,000 bytes. A tool output is the text returned after Codex runs a command, search, or file read.",
    action:
      "Ask for the smallest useful slice: a named file, a section, or a limited number of matches. Less irrelevant tool text leaves more room for the work that follows.",
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
        recordedBytes: 57_000,
        detail: "About 57,000 bytes recorded.",
      },
      {
        session: "sample-api",
        timestamp: "2026-09-27T14:34:00Z",
        activity: "Project search",
        recordedBytes: 38_000,
        detail: "About 38,000 bytes recorded.",
      },
      {
        session: "sample-api",
        timestamp: "2026-09-27T14:35:00Z",
        activity: "Terminal command",
        recordedBytes: 22_000,
        detail: "About 22,000 bytes recorded.",
      },
    ],
    method:
      "12,000 bytes is a screening threshold used to find unusually long tool outputs. It is not a model limit or billing measurement.",
    caveat:
      "Demo data only. Recorded output bytes show text volume only and cannot confirm how much later entered model context.",
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
