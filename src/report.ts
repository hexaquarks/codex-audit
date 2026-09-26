import { sumUsage, type SessionSummary } from "./audit.js";
import { findInsights, type Insight } from "./insights.js";

const format = (value: number): string => new Intl.NumberFormat("en-US").format(value);

const formatContextOccupancy = (session: SessionSummary): string => {
    if (!session.latestActiveContext || !session.modelContextWindow) return "";

    const occupancy = Math.round(
        (session.latestActiveContext.inputTokens / session.modelContextWindow) * 100,
    );

    return ` · context ${occupancy}%`;
};

const formatSession = (session: SessionSummary): string => {
    const timestamp = session.lastActivity.slice(0, 16).replace("T", " ");
    const project = session.project.slice(0, 24).padEnd(24);
    const totalTokens = format(session.totalTokens).padStart(10);

    return `${timestamp}  ${project} ${totalTokens} tokens${formatContextOccupancy(session)}`;
};

const sourceSessions = (insight: Insight): string => {
    const projects = [...new Set(insight.events.map((event) => event.session))];
    return projects.length ? ` [${projects.join(", ")}]` : "";
};

export const createUsageReport = (allSessions: readonly SessionSummary[], sessionLimit: number): string => {
    const sessions = allSessions.slice(0, sessionLimit);
    const totals = sumUsage(sessions);
    const insights = findInsights(sessions);
    return [
        "Codex audit · local root sessions",
        `${sessions.length} most recently active sessions · ${format(totals.totalTokens)} cumulative tokens`,
        "Cached input is included in input and is not counted twice.",
        "",
        "Recent sessions",
        ...(sessions.length ? sessions.map(formatSession) : ["No local sessions with token records found."]),
        "",
        "Insights",
        ...(insights.length
            ? insights.map((insight, index) => `${index + 1}. ${insight.title}${sourceSessions(insight)} — ${insight.action}`)
            : ["No clear action found"]),
    ].join("\n");
};

export const createExplanation = (insights: readonly Insight[], insightNumber: number): string => {
    const insight = insights[insightNumber - 1];
    if (!insight) {
        return `No insight numbered ${insightNumber}. Run codex-audit first to see the current ranked insights.`;
    }

    const matchingEvents = insight.events.map((event) => {
        const turn = event.turn === undefined ? "" : ` · user turn ${event.turn}`;
        return `- ${event.timestamp || "unknown time"} · ${event.session}${turn} · ${event.detail}`;
    });

    return [
        `${insightNumber}. ${insight.title}`,
        "",
        "Matching events",
        ...matchingEvents,
        "",
        `Calculation: ${insight.calculation}`,
        `Recommendation: ${insight.action}`,
        `Caveat: ${insight.caveat}`,
    ].join("\n");
};
