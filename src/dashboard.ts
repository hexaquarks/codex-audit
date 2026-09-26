import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Insight } from "./insights.js";
import type { AuditSnapshot, SavedSession } from "./snapshot.js";

const DASHBOARD_FILE = path.join(os.homedir(), ".codex-audit", "latest.html");

const formatNumber = (value: number): string => new Intl.NumberFormat("en-US").format(value);

const formatTime = (timestamp: string): string => {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "Unknown time";

    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(date);
};

const escapeHtml = (value: string): string => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const formatEvents = (insight: Insight): string => insight.events.map((event) => {
    const heading = `${formatTime(event.timestamp)} · ${event.session}`;
    const detail = event.activity === undefined ? event.detail : `${event.activity}: ${event.detail}`;

    return `<article class="event">
  <p class="event-heading">${escapeHtml(heading)}</p>
  <p class="event-detail">${escapeHtml(detail)}</p>
</article>`;
}).join("\n");

const formatInsight = (insight: Insight, index: number): string => `<details class="insight">
  <summary>
    <span class="insight-number">${String(index + 1).padStart(2, "0")}</span>
    <span><strong>${escapeHtml(insight.title)}</strong><small>${escapeHtml(insight.cause)}</small></span>
  </summary>
  <div class="insight-details">
    <section><h3>What was found</h3><div class="event-list">${formatEvents(insight)}</div></section>
    <section class="muted-section"><h3>How this was checked</h3><p>${escapeHtml(insight.method)}</p></section>
    <section class="muted-section"><h3>Keep in mind</h3><p>${escapeHtml(insight.caveat)}</p></section>
    <section class="next-step"><h3>Possible next step</h3><p>${escapeHtml(insight.action)}</p></section>
  </div>
</details>`;

const formatSession = (session: SavedSession): string => {
    const context = session.activeContextTokens && session.contextWindowTokens
        ? `${Math.round((session.activeContextTokens / session.contextWindowTokens) * 100)}%`
        : "—";

    return `<tr><td>${escapeHtml(formatTime(session.lastActivity))}</td><td>${escapeHtml(session.project)}</td><td class="number">${formatNumber(session.totalTokens)}</td><td class="number">${context}</td></tr>`;
};

const dashboardStyles = `
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #10131a; color: #eef2f7; }
* { box-sizing: border-box; } body { margin: 0; background: radial-gradient(circle at 15% 0%, #1c2b3a, #10131a 42rem); }
main { width: min(980px, calc(100% - 48px)); margin: 0 auto; padding: 56px 0 72px; }
.eyebrow, h3 { color: #7dd3fc; font-size: .72rem; font-weight: 750; letter-spacing: .12em; margin: 0 0 .55rem; text-transform: uppercase; }
header { display: flex; justify-content: space-between; gap: 2rem; align-items: end; margin-bottom: 32px; } h1 { font-size: clamp(2rem, 5vw, 3.8rem); letter-spacing: -.05em; line-height: .95; margin: 0; }
.subtitle, .generated-at, .muted-section { color: #aab5c5; } .subtitle { margin: .8rem 0 0; max-width: 40rem; }
.summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 36px; }
.metric, .panel, .insight { background: rgba(22, 28, 39, .86); border: 1px solid #293448; border-radius: 14px; } .metric { padding: 18px; }
.metric strong { display: block; font-size: 1.6rem; letter-spacing: -.04em; margin-bottom: 4px; } .metric span { color: #aab5c5; font-size: .88rem; }
.panel { overflow: hidden; } .panel-heading { padding: 20px 20px 12px; } .panel-heading h2 { font-size: 1rem; margin: 0; }
.insight-list { display: grid; gap: 12px; margin-top: 16px; } .insight { overflow: hidden; }
.insight summary { cursor: pointer; display: flex; gap: 14px; list-style: none; padding: 18px 20px; } .insight summary::-webkit-details-marker { display: none; } .insight summary::after { color: #7dd3fc; content: "›"; font-size: 1.4rem; margin-left: auto; transform: rotate(0deg); transition: transform .15s ease; } .insight[open] summary::after { transform: rotate(90deg); } .insight summary:hover { background: #202d3e; } .insight summary:focus-visible { outline: 3px solid #7dd3fc; outline-offset: -3px; }
.insight-number { color: #7dd3fc; font: 700 .72rem ui-monospace, monospace; padding-top: 3px; } .insight summary span:last-child { display: grid; gap: 5px; } .insight summary small { color: #aab5c5; line-height: 1.4; }
.insight-details { border-top: 1px solid #293448; padding: 0 20px 22px; } .insight-details section { border-top: 1px solid #293448; padding-top: 20px; margin-top: 20px; } .insight-details section:first-child { border-top: 0; } .insight-details p { line-height: 1.55; margin: 0; }
.event-list { display: grid; gap: 10px; } .event { background: #10151f; border: 1px solid #293448; border-radius: 8px; padding: 12px 14px; } .event-heading { color: #c8d3e2; font-size: .88rem; font-weight: 650; margin: 0; } .event-detail { color: #aab5c5; font-size: .9rem; margin: 3px 0 0 !important; }
.next-step { border-color: #335875 !important; } .sessions { margin-top: 16px; padding: 8px 20px 20px; } table { border-collapse: collapse; width: 100%; } th, td { border-bottom: 1px solid #293448; padding: 12px 0; text-align: left; } th { color: #aab5c5; font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; } .number { text-align: right; font-variant-numeric: tabular-nums; } footer { color: #8090a4; font-size: .82rem; margin-top: 22px; }
@media (max-width: 760px) { main { width: min(100% - 28px, 980px); padding-top: 32px; } header { display: block; } .generated-at { margin-top: 1rem; } .summary { grid-template-columns: 1fr; } }
`;

export const createDashboardDocument = (snapshot: AuditSnapshot): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Codex audit</title><style>${dashboardStyles}</style></head>
<body><main><header><div><p class="eyebrow">Saved only on this computer</p><h1>Codex audit</h1><p class="subtitle">A closer look at recent conversation patterns and the evidence behind them.</p></div><p class="generated-at">Saved ${escapeHtml(formatTime(snapshot.generatedAt))}</p></header>
<section class="summary" aria-label="Audit summary"><article class="metric"><strong>${snapshot.sessions.length}</strong><span>recent conversations</span></article><article class="metric"><strong>${formatNumber(snapshot.totals.totalTokens)}</strong><span>tokens recorded</span></article><article class="metric"><strong>${snapshot.insights.length}</strong><span>findings</span></article></section>
<section class="panel"><div class="panel-heading"><p class="eyebrow">What stood out</p><h2>Open a finding to see the activity that led to it.</h2></div></section><section class="insight-list">${snapshot.insights.map(formatInsight).join("\n")}</section>
<section class="panel sessions"><div class="panel-heading"><p class="eyebrow">Recent activity</p><h2>Conversations included in this report</h2></div><table><thead><tr><th>Time</th><th>Project</th><th class="number">Tokens</th><th class="number">Context</th></tr></thead><tbody>${snapshot.sessions.map(formatSession).join("\n")}</tbody></table></section>
<footer>Saved only on this computer. This report does not include prompts, commands, file paths, or result contents.</footer></main></body></html>`;

const browserLaunch = (file: string): { command: string; arguments_: string[] } => {
    if (process.platform === "darwin") return { command: "open", arguments_: [file] };
    if (process.platform === "win32") return { command: "cmd", arguments_: ["/c", "start", "", file] };
    return { command: "xdg-open", arguments_: [file] };
};

const launchBrowser = (file: string): Promise<void> => new Promise((resolve, reject) => {
    const { command, arguments_ } = browserLaunch(file);
    const browser = spawn(command, arguments_, { detached: true, stdio: "ignore" });
    browser.once("error", reject);
    browser.once("spawn", () => { browser.unref(); resolve(); });
});

export const openDashboard = async (snapshot: AuditSnapshot): Promise<void> => {
    await writeFile(DASHBOARD_FILE, createDashboardDocument(snapshot), { encoding: "utf8", mode: 0o600 });
    await launchBrowser(DASHBOARD_FILE);
};
