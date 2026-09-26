import { sumUsage, type SessionSummary } from "./audit.js";
import { findInsights, InsightKind, type Insight } from "./insights.js";
import { createTerminalStyle, type TerminalStyle } from "./terminal.js";

const CONTEXT_WARNING_RATIO = 0.8;
const CONTEXT_DANGER_RATIO = 0.95;
const PROJECT_COLUMN_WIDTH = 24;
const TOKEN_COLUMN_WIDTH = 12;

const formatNumber = (value: number): string => new Intl.NumberFormat("en-US").format(value);

const formatLocalTime = (timestamp: string): string => {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "unknown time";

    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(date);
};

const formatContextOccupancy = (session: SessionSummary, style: TerminalStyle): string => {
    if (!session.latestActiveContext || !session.modelContextWindow) return style.dim("—");

    const occupancy = session.latestActiveContext.inputTokens / session.modelContextWindow;
    const label = `${Math.round(occupancy * 100)}%`;

    if (occupancy >= CONTEXT_DANGER_RATIO) return style.danger(label);
    if (occupancy >= CONTEXT_WARNING_RATIO) return style.warning(label);
    return style.success(label);
};

const formatSession = (session: SessionSummary, style: TerminalStyle): string => {
    const time = formatLocalTime(session.lastActivity).padEnd(14);
    const project = session.project.slice(0, PROJECT_COLUMN_WIDTH).padEnd(PROJECT_COLUMN_WIDTH);
    const totalTokens = formatNumber(session.totalTokens).padStart(TOKEN_COLUMN_WIDTH);

    return [
        style.dim(time),
        project,
        style.strong(totalTokens),
        formatContextOccupancy(session, style),
    ].join("  ");
};

const sourceSessions = (insight: Insight): string => {
    const projects = [...new Set(insight.events.map((event) => event.session))];
    return projects.join(", ");
};

const formatInsightTitle = (insight: Insight, style: TerminalStyle): string => {
    const title = insight.title.toUpperCase();

    switch (insight.kind) {
        case InsightKind.RepeatedToolCalls:
            return style.danger(title);
        case InsightKind.CrowdedContext:
            return style.warning(title);
        case InsightKind.LargeToolOutputs:
            return style.accent(title);
        case InsightKind.HeavyStartup:
            return style.warning(title);
        case InsightKind.CostliestTurns:
            return style.accent(title);
    }
};

const formatInsight = (insight: Insight, index: number, style: TerminalStyle): string[] => {
    const source = sourceSessions(insight);
    const sourceLabel = source ? `  ${style.dim(`from ${source}`)}` : "";

    return [
        `${style.strong(`${index + 1}.`)} ${formatInsightTitle(insight, style)}${sourceLabel}`,
        `   ${style.dim("Why:")} ${insight.cause}`,
        `   ${style.dim("Possible next step:")} ${insight.action}`,
    ];
};

const sectionHeading = (title: string, style: TerminalStyle): string =>
    style.accent(title.toUpperCase());

export const createUsageReport = (
    allSessions: readonly SessionSummary[],
    sessionLimit: number,
    style: TerminalStyle = createTerminalStyle(),
): string => {
    const sessions = allSessions.slice(0, sessionLimit);
    const totals = sumUsage(sessions);
    const insights = findInsights(sessions);
    const insightLines = insights.flatMap((insight, index) => formatInsight(insight, index, style));

    return [
        `${style.accent("CODEX AUDIT")} ${style.dim("local session insights")}`,
        `${style.strong(formatNumber(totals.totalTokens))} cumulative tokens across ${sessions.length} recent root sessions`,
        style.dim("Cached input is already included in input usage."),
        "",
        sectionHeading("Recent sessions · local time", style),
        style.dim(`${"TIME".padEnd(14)}  ${"PROJECT".padEnd(PROJECT_COLUMN_WIDTH)}  ${"TOKENS".padStart(TOKEN_COLUMN_WIDTH)}  CONTEXT`),
        ...(sessions.length
            ? sessions.map((session) => formatSession(session, style))
            : [style.dim("No local sessions with token records found.")]),
        "",
        sectionHeading("Insights", style),
        ...(insightLines.length ? insightLines : [style.success("No clear action found.")]),
        "",
        style.dim("Run `codex-audit explain <number>` for matching events and caveats."),
    ].join("\n");
};

export const createExplanation = (
    insights: readonly Insight[],
    insightNumber: number,
    style: TerminalStyle = createTerminalStyle(),
): string => {
    const insight = insights[insightNumber - 1];
    if (!insight) {
        return style.warning(
            `No insight numbered ${insightNumber}. Run codex-audit first to see the current ranked insights.`,
        );
    }

    const matchingEvents = insight.events.map((event) => {
        const turn = event.turn === undefined ? "" : ` · user turn ${event.turn}`;
        const time = formatLocalTime(event.timestamp);

        return `  ${style.dim("•")} ${time} · ${event.session}${turn}\n    ${event.detail}`;
    });

    return [
        `${sectionHeading(`Insight ${insightNumber}`, style)} ${formatInsightTitle(insight, style)}`,
        style.dim(`Source: ${sourceSessions(insight) || "unknown session"}`),
        "",
        sectionHeading("Why you're seeing this", style),
        insight.cause,
        "",
        sectionHeading("What was found", style),
        ...matchingEvents,
        "",
        sectionHeading("How this was checked", style),
        insight.method,
        "",
        sectionHeading("Keep in mind", style),
        style.dim(insight.caveat),
        "",
        sectionHeading("Possible next step", style),
        insight.action,
    ].join("\n");
};
