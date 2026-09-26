export const usage = `Usage: codex-audit [--sessions <n>]
       codex-audit explain <number> [--sessions <n>]

Read local Codex session logs and show rule-based token-usage patterns.
Prompt, command, path, and tool-output content are never printed.`;

export type CliCommand =
    | {
        kind: "help"; // Prints command usage without reading session logs.
    }
    | {
        kind: "report"; // Renders the standard session summary and insight list.
        sessionLimit: number; // Maximum number of recent root sessions to inspect.
    }
    | {
        kind: "explain"; // Renders evidence and caveats for one ranked insight.
        insightNumber: number; // One-based position in the current ranked insight list.
        sessionLimit: number; // Maximum number of recent root sessions to inspect.
    };

const DEFAULT_SESSION_LIMIT = 5;

const parseSessionLimit = (arguments_: readonly string[]): number => {
    let sessionLimit = DEFAULT_SESSION_LIMIT;

    for (let index = 0; index < arguments_.length; index += 1) {
        const option = arguments_[index];
        if (option !== "--sessions" && option !== "--limit") {
            throw new Error(`Unknown argument: ${option}`);
        }

        const value = arguments_[index + 1];
        if (value === undefined) throw new Error(`${option} needs a positive integer`);

        sessionLimit = Number(value);
        index += 1;
    }

    if (!Number.isInteger(sessionLimit) || sessionLimit < 1) {
        throw new Error("--sessions must be a positive integer");
    }

    return sessionLimit;
};

export const parseCommandArguments = (arguments_: readonly string[]): CliCommand => {
    if (!arguments_.length) return { kind: "report", sessionLimit: DEFAULT_SESSION_LIMIT };
    if (arguments_[0] === "--help" || arguments_[0] === "-h") return { kind: "help" };

    if (arguments_[0] === "explain") {
        const insightNumber = Number(arguments_[1]);
        if (!Number.isInteger(insightNumber) || insightNumber < 1) {
            throw new Error("explain needs a positive insight number");
        }

        return {
            kind: "explain",
            insightNumber,
            sessionLimit: parseSessionLimit(arguments_.slice(2)),
        };
    }

    return { kind: "report", sessionLimit: parseSessionLimit(arguments_) };
};
