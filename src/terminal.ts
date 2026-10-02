import type { WriteStream } from "node:tty";

const ANSI = {
	reset: "\u001B[0m",
	bold: "\u001B[1m",
	dim: "\u001B[2m",
	cyan: "\u001B[36m",
	green: "\u001B[32m",
	yellow: "\u001B[33m",
	red: "\u001B[31m",
} as const;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export interface TerminalStyle {
	accent: (text: string) => string; // Highlights headings and interactive status.
	danger: (text: string) => string; // Highlights an actionable problem.
	dim: (text: string) => string; // De-emphasizes supporting text.
	strong: (text: string) => string; // Emphasizes a key value without relying on color.
	success: (text: string) => string; // Highlights normal or healthy status.
	warning: (text: string) => string; // Highlights a condition needing attention.
}

export interface LoadingIndicator {
	stop: () => void; // Clears the transient terminal line after the task completes.
}

const applyStyle = (escapeCode: string, enabled: boolean, text: string): string => {
	if (!enabled) return text;
	return `${escapeCode}${text}${ANSI.reset}`;
};

export const supportsColor = (stream: WriteStream = process.stdout): boolean => {
	const noColorRequested = Boolean(process.env.NO_COLOR);
	const terminalIsDumb = process.env.TERM === "dumb";

	return stream.isTTY && !noColorRequested && !terminalIsDumb;
};

export const createTerminalStyle = (colorEnabled = supportsColor()): TerminalStyle => ({
	accent: (text) => applyStyle(`${ANSI.bold}${ANSI.cyan}`, colorEnabled, text),
	danger: (text) => applyStyle(`${ANSI.bold}${ANSI.red}`, colorEnabled, text),
	dim: (text) => applyStyle(ANSI.dim, colorEnabled, text),
	strong: (text) => applyStyle(ANSI.bold, colorEnabled, text),
	success: (text) => applyStyle(ANSI.green, colorEnabled, text),
	warning: (text) => applyStyle(`${ANSI.bold}${ANSI.yellow}`, colorEnabled, text),
});

const createNoopIndicator = (): LoadingIndicator => ({
	stop: () => undefined,
});

export const startLoadingIndicator = (
	message: string,
	stream: WriteStream = process.stderr,
): LoadingIndicator => {
	if (!stream.isTTY) return createNoopIndicator();

	const style = createTerminalStyle(supportsColor(stream));
	let frameIndex = 0;

	const render = (): void => {
		const frame = style.accent(SPINNER_FRAMES[frameIndex]);
		stream.write(`\r\u001B[2K${frame} ${style.dim(message)}`);
		frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
	};

	render();
	const interval = setInterval(render, SPINNER_INTERVAL_MS);

	return {
		stop: () => {
			clearInterval(interval);
			stream.write("\r\u001B[2K");
		},
	};
};
