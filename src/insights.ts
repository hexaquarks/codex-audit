import type { SessionSummary, ToolCall, TurnUsage } from "./audit.js";

export const InsightKind = {
  CostliestTurns: "costliest_turns", // Highest per-call usage for each user turn.
  RepeatedToolCalls: "repeated_tool_calls", // Failed calls or file reads repeated without an edit.
  LargeToolOutputs: "large_tool_outputs", // Repeated tool results large enough to crowd context.
  CrowdedContext: "crowded_context", // Active context nearing the model's context window.
  HeavyStartup: "heavy_startup", // Consistently large first calls in one repository.
} as const;

export type InsightKind = (typeof InsightKind)[keyof typeof InsightKind];

export interface InsightEvent {
  session: string; // Project label of the source session.
  turn?: number; // User turn when the detector can identify one.
  timestamp: string; // Event timestamp used as supporting evidence.
  activity?: string; // Plain-language category of the activity that produced this event.
  recordedBytes?: number; // Result size when this event represents tool output.
  recordedTokens?: number; // Token total when this event represents a model request.
  contextWindowTokens?: number; // Model context capacity when this event represents context use.
  detail: string; // Privacy-preserving description of the matching event.
}

export interface Insight {
  kind: InsightKind; // Stable detector identity.
  rank: number; // Relative priority used to order the report.
  title: string; // Short presentation heading.
  cause: string; // Plain-language reason this finding appeared.
  action: string; // One-line recommended next action.
  events: InsightEvent[]; // Evidence that caused the detector to match.
  method: string; // Rule and threshold used to generate the finding.
  caveat: string; // Limitations of the signal.
}

// Checks a session sample and returns one finding when its rule matches.
type InsightDetector = (
  sessions: readonly SessionSummary[],
) => Insight | undefined;

const format = (value: number): string =>
  new Intl.NumberFormat("en-US").format(value);
const isTerminalCommand = (name: string): boolean => name.includes("exec");
const isFileRead = (name: string): boolean =>
  name.includes("read_file") || name.includes("readfile");
const isProjectSearch = (name: string): boolean =>
  name.includes("search") || name.includes("find");
const isFileEdit = (name: string): boolean =>
  name.includes("patch") || name.includes("edit") || name.includes("write");

const describeTool = (name: string): string => {
  const normalizedName = name.toLowerCase();
  if (isTerminalCommand(normalizedName)) return "Terminal command";
  if (isFileRead(normalizedName)) return "File read";
  if (isProjectSearch(normalizedName)) return "Project search";
  if (isFileEdit(normalizedName)) return "File edit";
  return "Tool action";
};

const toolSummary = (tools: readonly ToolCall[]): string => {
  if (!tools.length) return "no tool calls logged";

  const activities = [
    ...new Set(tools.map((tool) => describeTool(tool.name))),
  ].join(", ");
  return `${tools.length} action${tools.length === 1 ? "" : "s"}: ${activities}`;
};

const MAX_FINDINGS = 3;
const MAX_HIGHEST_TOKEN_REQUESTS = 3;
const MIN_REPEATED_CALLS = 3;
const LARGE_TOOL_OUTPUT_BYTES = 12_000;
const CONTEXT_REVIEW_RATIO = 0.75;
const CONTEXT_ACTION_RATIO = 0.8;
const HEAVY_STARTUP_INPUT_TOKENS = 20_000;
const MIN_HEAVY_STARTUP_SESSIONS = 3;
const HEAVY_STARTUP_RATIO = 0.75;

const detectCostliestTurns = (
  sessions: readonly SessionSummary[],
): Insight | undefined => {
  const mostCostlyByTurn = new Map<
    string,
    { session: SessionSummary; turn: TurnUsage }
  >();

  for (const session of sessions) {
    for (const turn of session.turns) {
      if (turn.usage.totalTokens <= 0) continue;

      const key = `${session.sessionId}:${turn.userTurn}`;
      const existing = mostCostlyByTurn.get(key);

      if (
        !existing ||
        turn.usage.totalTokens > existing.turn.usage.totalTokens
      ) {
        mostCostlyByTurn.set(key, { session, turn });
      }
    }
  }

  const candidates = [...mostCostlyByTurn.values()]
    .sort((a, b) => b.turn.usage.totalTokens - a.turn.usage.totalTokens)
    .slice(0, MAX_HIGHEST_TOKEN_REQUESTS);

  if (!candidates.length) return undefined;

  return {
    kind: InsightKind.CostliestTurns,
    rank: 10,
    title: "Highest token use",
    cause:
      "These requests used more tokens than the other requests in the sessions reviewed.",
    action: "Use this list to see which requests used the most tokens.",
    events: candidates.map(({ session, turn }) => ({
      session: session.project,
      turn: turn.userTurn,
      timestamp: turn.timestamp,
      activity: toolSummary(turn.tools),
      recordedTokens: turn.usage.totalTokens,
      detail: `${format(turn.usage.totalTokens)} tokens; ${toolSummary(turn.tools)}`,
    })),
    method:
      "Ranks the highest token total recorded for each request. Repeated token snapshots within one request are not added together.",
    caveat:
      "A costly turn is investigation context, not a warning, and does not prove the tools caused the token use.",
  };
};

const isRepeatedFileRead = (tool: ToolCall): boolean =>
  /(?:read_file|readfile)/i.test(tool.name);

const detectRepeatedToolCalls = (
  sessions: readonly SessionSummary[],
): Insight | undefined => {
  for (const session of sessions) {
    const calls = session.tools.filter(
      (tool) => tool.outputBytes !== undefined,
    );
    const groups = new Map<
      string,
      {
        tool: ToolCall;
        events: ToolCall[];
        editedSinceLast: boolean;
        revision: number;
      }
    >();
    let revision = 0;

    for (const tool of calls) {
      if (tool.editsFiles) revision += 1;

      const group = groups.get(tool.fingerprint) ?? {
        tool,
        events: [],
        editedSinceLast: false,
        revision,
      };

      if (group.events.length && group.revision !== revision)
        group.editedSinceLast = true;
      group.revision = revision;

      group.events.push(tool);
      groups.set(tool.fingerprint, group);
    }

    const match = [...groups.values()].find(
      (group) =>
        group.events.length >= MIN_REPEATED_CALLS &&
        !group.editedSinceLast &&
        (group.events.every((tool) => tool.failed) ||
          isRepeatedFileRead(group.tool)),
    );

    if (match) {
      return {
        kind: InsightKind.RepeatedToolCalls,
        rank: 100,
        title: "Repeated failed action or file read",
        cause: `${match.events.length} identical failed actions or file reads were logged without a detected file edit between them.`,
        action:
          "Inspect the earlier result before trying again. If you need the file again, reuse that result or request only the section that changed.",
        events: match.events.map((tool) => ({
          session: session.project,
          timestamp: tool.timestamp,
          activity: describeTool(tool.name),
          detail: "Repeated without a detected file edit between attempts.",
        })),
        method:
          "Matches identical failed actions or file reads when the session log does not show a file edit between attempts.",
        caveat:
          "Edit detection is conservative; an unrecognized or external edit may not be visible in the log.",
      };
    }
  }

  return undefined;
};

const detectLargeToolOutputs = (
  sessions: readonly SessionSummary[],
): Insight | undefined => {
  const outputs = sessions.flatMap((session) =>
    session.tools
      .filter((tool) => (tool.outputBytes ?? 0) >= LARGE_TOOL_OUTPUT_BYTES)
      .map((tool) => ({ session, tool })),
  );

  if (outputs.length < 3) return undefined;

  const largestResults = outputs.sort(
    (a, b) => (b.tool.outputBytes ?? 0) - (a.tool.outputBytes ?? 0),
  );

  return {
    kind: InsightKind.LargeToolOutputs,
    rank: 80,
    title: "Tool-output volume to review",
    cause: `${outputs.length} tool outputs each contained at least ${format(LARGE_TOOL_OUTPUT_BYTES)} bytes of recorded text. Together, they contained ${format(outputs.reduce((total, { tool }) => total + (tool.outputBytes ?? 0), 0))} bytes. A tool output is the text returned after Codex runs a command, search, or file read.`,
    action:
      "Ask for the smallest useful slice: a named file, a section, or a limited number of matches. Less irrelevant tool text leaves more room for the work that follows.",
    events: largestResults.map(({ session, tool }) => ({
      session: session.project,
      timestamp: tool.timestamp,
      activity: describeTool(tool.name),
      recordedBytes: tool.outputBytes,
      detail: `About ${format(tool.outputBytes ?? 0)} bytes recorded.`,
    })),
    method: `${format(LARGE_TOOL_OUTPUT_BYTES)} bytes is a screening threshold used to find unusually long tool outputs. It is not a model limit or billing measurement.`,
    caveat:
      "Review opportunity, not a measured token or cost impact. Recorded output bytes show text volume only and cannot confirm how much later entered model context.",
  };
};

const detectCrowdedContext = (
  sessions: readonly SessionSummary[],
): Insight | undefined => {
  const matches = sessions
    .map((session) => ({
      session,
      used: session.latestActiveContext?.inputTokens ?? 0,
      window: session.modelContextWindow ?? 0,
    }))
    .filter(
      ({ used, window }) => window > 0 && used / window >= CONTEXT_REVIEW_RATIO,
    )
    .sort((a, b) => b.used / b.window - a.used / a.window);

  if (!matches.length) return undefined;

  const mostCrowded = matches[0];
  const occupancy = Math.round((mostCrowded.used / mostCrowded.window) * 100);
  const remaining = 100 - occupancy;
  const needsHandoff = occupancy >= CONTEXT_ACTION_RATIO * 100;

  return {
    kind: InsightKind.CrowdedContext,
    rank: 90,
    title: needsHandoff
      ? "Context is getting tight"
      : "Limited room for the next steps",
    cause: `The latest request in ${matches.length} recent conversation${matches.length === 1 ? " is" : "s are"} using up to ${occupancy}% of its model context window. That leaves about ${remaining}% for further messages, tool results, and replies.`,
    action: needsHandoff
      ? "Save a short handoff and start a follow-up conversation before continuing substantial investigation."
      : "If more investigation is ahead, save a short handoff before adding large results or changing topics.",
    events: matches.map(({ session, used, window }) => ({
      session: session.project,
      timestamp: session.lastActivity,
      recordedTokens: used,
      contextWindowTokens: window,
      detail: `${format(used)} active input tokens of ${format(window)} (${Math.round((used / window) * 100)}%)`,
    })),
    method: `${needsHandoff ? "80%" : "75%"} is this tool's working-room guardrail. It compares the input tokens logged for the latest request with that model's logged context window; it is not a model limit.`,
    caveat:
      "A conversation can still continue normally at this level. Context use changes with each request, and this report cannot predict answer quality or when the window will fill.",
  };
};

const detectHeavyStartup = (
  sessions: readonly SessionSummary[],
): Insight | undefined => {
  const byProject = new Map<
    string,
    { session: SessionSummary; turn: TurnUsage }[]
  >();

  for (const session of sessions) {
    const turn = session.turns[0];
    if (!turn) continue;

    byProject.set(session.projectPath, [
      ...(byProject.get(session.projectPath) ?? []),
      { session, turn },
    ]);
  }

  for (const starts of byProject.values()) {
    const heavy = starts.filter(
      ({ turn }) => turn.usage.inputTokens >= HEAVY_STARTUP_INPUT_TOKENS,
    );

    if (
      heavy.length >= MIN_HEAVY_STARTUP_SESSIONS &&
      heavy.length / starts.length >= HEAVY_STARTUP_RATIO
    ) {
      return {
        kind: InsightKind.HeavyStartup,
        rank: 50,
        title: "New conversations use many tokens before work begins",
        cause: `${heavy.length} of ${starts.length} reviewed conversations in this project began with at least ${format(HEAVY_STARTUP_INPUT_TOKENS)} input tokens.`,
        action:
          "If this is unexpected, review the instructions and tools loaded when a conversation starts.",
        events: heavy.map(({ session, turn }) => ({
          session: session.project,
          turn: turn.userTurn,
          timestamp: turn.timestamp,
          recordedTokens: turn.usage.inputTokens,
          detail: `${format(turn.usage.inputTokens)} input tokens on the first logged call`,
        })),
        method: `Requires at least ${MIN_HEAVY_STARTUP_SESSIONS} conversations in one project, with at least ${Math.round(HEAVY_STARTUP_RATIO * 100)}% beginning above ${format(HEAVY_STARTUP_INPUT_TOKENS)} input tokens.`,
        caveat:
          "This suggests a possible startup cause; it does not identify which instructions or tools were responsible.",
      };
    }
  }

  return undefined;
};

const detectorByKind: Record<InsightKind, InsightDetector> = {
  [InsightKind.CostliestTurns]: detectCostliestTurns,
  [InsightKind.RepeatedToolCalls]: detectRepeatedToolCalls,
  [InsightKind.LargeToolOutputs]: detectLargeToolOutputs,
  [InsightKind.CrowdedContext]: detectCrowdedContext,
  [InsightKind.HeavyStartup]: detectHeavyStartup,
};

const insightOrder: InsightKind[] = [
  InsightKind.RepeatedToolCalls,
  InsightKind.CrowdedContext,
  InsightKind.LargeToolOutputs,
] satisfies InsightKind[];

export const findInsights = (sessions: readonly SessionSummary[]): Insight[] =>
  insightOrder
    .map((kind) => detectorByKind[kind](sessions))
    .filter((insight): insight is Insight => insight !== undefined)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, MAX_FINDINGS);
