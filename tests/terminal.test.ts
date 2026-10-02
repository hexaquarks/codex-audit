import assert from "node:assert/strict";
import test from "node:test";
import type { WriteStream } from "node:tty";
import { createTerminalStyle, startLoadingIndicator } from "../src/terminal.js";

test("leaves text unstyled when color is disabled", () => {
	const style = createTerminalStyle(false);

	assert.equal(style.accent("Codex audit"), "Codex audit");
	assert.equal(style.warning("Crowded context"), "Crowded context");
});

test("clears an interactive loading indicator when it stops", () => {
	const writes: string[] = [];
	const stream = {
		isTTY: true,
		write: (text: string) => {
			writes.push(text);
			return true;
		},
	} as unknown as WriteStream;

	const indicator = startLoadingIndicator("Reading sessions", stream);
	indicator.stop();

	assert.match(writes[0] ?? "", /Reading sessions/);
	assert.equal(writes.at(-1), "\r\u001B[2K");
});
