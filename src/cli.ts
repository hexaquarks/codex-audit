export const usage = `Usage: codex-audit [--limit <n>]

Show token usage from recent local Codex sessions.
Prompt and command content are never printed.`;

const DEFAULT_SESSION_LIMIT = 5;

export type CliCommand =
    | { kind: "help" }
    | { kind: "report"; sessionLimit: number };

export const parseCommandArguments = (arguments_: readonly string[]): CliCommand => {
    let sessionLimit = DEFAULT_SESSION_LIMIT;

    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];

        if (argument === "--help" || argument === "-h") return { kind: "help" };
        if (argument === "--limit") {
            const limitArgument = arguments_[index + 1];
            if (limitArgument === undefined) throw new Error("--limit needs a positive integer");

            sessionLimit = Number(limitArgument);
            index += 1;
            continue;
        }

        throw new Error(`Unknown argument: ${argument}`);
    }

    if (!Number.isInteger(sessionLimit) || sessionLimit < 1) {
        throw new Error("--limit must be a positive integer");
    }

    return { kind: "report", sessionLimit };
};
