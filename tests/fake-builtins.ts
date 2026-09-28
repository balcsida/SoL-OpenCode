/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

/**
 * Stand-ins for OpenCode's built-in `edit`, `write`, and `shell` tools with the
 * v2.0.18 names, input fields, and result shapes (core/src/tool/plugin/*.ts).
 * Their failures are typed, like the Effect built-ins they replace.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FakeToolFailure, type FakeTool, type FakeToolContext } from "./fake-opencode.ts";

const OBJECT = (properties: Record<string, unknown>, required: string[]) => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});

export function writeTool(directory: string, onWrite?: (path: string, content: string) => Promise<void> | void): FakeTool {
	return {
		name: "write",
		description: "Writes a file to the local filesystem.",
		input: OBJECT({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
		execute: async (input: { path: string; content: string }) => {
			const target = resolve(directory, input.path);
			const existed = await readFile(target).then(
				() => true,
				() => false,
			);
			await onWrite?.(target, input.content);
			await writeFile(target, input.content);
			return {
				output: { operation: "write", target, resource: input.path, existed },
				content: `${existed ? "Wrote" : "Created"} file successfully: ${input.path}`,
			};
		},
	};
}

export function editTool(directory: string): FakeTool {
	return {
		name: "edit",
		description: "Performs exact string replacements in a file.",
		input: OBJECT(
			{
				path: { type: "string" },
				oldString: { type: "string" },
				newString: { type: "string" },
				replaceAll: { type: "boolean" },
			},
			["path", "oldString", "newString"],
		),
		execute: async (input: { path: string; oldString: string; newString: string }) => {
			const target = resolve(directory, input.path);
			let current: string;
			try {
				current = await readFile(target, "utf8");
			} catch {
				throw new FakeToolFailure({ message: `Unable to edit ${input.path}` });
			}
			if (!current.includes(input.oldString)) {
				throw new FakeToolFailure({ message: `Unable to edit ${input.path}: oldString not found` });
			}
			await writeFile(target, current.replace(input.oldString, input.newString));
			return { output: { files: [], replacements: 1 }, content: `Edit applied successfully to ${input.path}.` };
		},
	};
}

export interface ShellRun {
	readonly output: string;
	readonly exit?: number;
	readonly timeout?: boolean;
	readonly truncated?: boolean;
}

export type ShellHandler = (
	input: { command: string; timeout?: number; workdir?: string },
	context: FakeToolContext,
) => Promise<ShellRun>;

/** OpenCode's shell result: output text, then an exit notice for a non-zero exit (core/src/shell/result.ts). */
export function shellResult(run: ShellRun) {
	const notice = run.timeout
		? "Timed out before completion"
		: run.exit !== undefined && run.exit !== 0
			? `Exited with code ${run.exit}`
			: undefined;
	return {
		output: {
			output: run.output,
			truncated: run.truncated ?? false,
			status: "completed",
			...(run.exit === undefined ? {} : { exit: run.exit }),
		},
		content: [
			...(run.output ? [{ type: "text" as const, text: run.output }] : []),
			...(notice ? [{ type: "text" as const, text: notice }] : []),
		],
		metadata: {
			status: "completed",
			truncated: run.truncated ?? false,
			...(run.exit === undefined ? {} : { exit: run.exit }),
			...(run.timeout ? { timeout: true } : {}),
		},
	};
}

export function shellTool(handler: ShellHandler): FakeTool {
	return {
		name: "shell",
		description: "Execute a shell command and return its output.",
		input: OBJECT(
			{
				command: { type: "string" },
				workdir: { type: "string" },
				timeout: { type: "integer", minimum: 0 },
				background: { type: "boolean" },
			},
			["command"],
		),
		execute: async (input, context) => shellResult(await handler(input, context)),
	};
}
