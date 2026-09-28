// SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
// SPDX-License-Identifier: MIT
//
// Diagnostic plugin for live verification, loaded after SoL-OpenCode. Its
// context hook runs last, so it sees the outgoing request after SoL's hooks,
// and compares it with the persisted session history.
import { appendFileSync } from "node:fs";

const LOG = process.env.SOL_REQUEST_LOG ?? "/tmp/sol-request-log.jsonl";

function partBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "");
}

export default {
	id: "zz.sol-request-log",
	async setup(ctx: any) {
		let request = 0;
		await ctx.session.hook("context", async (event: any) => {
			request += 1;
			const outgoing = event.messages.flatMap((message: any) =>
				message.content.filter((part: any) => part.type === "tool-result").map((part: any) => ({ id: part.id, name: part.name, bytes: partBytes(part.result.value) })),
			);
			let persisted: { id: string; name: string; bytes: number }[] = [];
			let persistedMessages = 0;
			try {
				const history = await ctx.session.context({ sessionID: event.sessionID });
				persistedMessages = history.length;
				persisted = history.flatMap((message: any) =>
					message.type !== "assistant"
						? []
						: message.content
								.filter((item: any) => item.type === "tool" && item.state?.status === "completed")
								.map((item: any) => ({ id: item.id, name: item.name, bytes: partBytes(item.state.content) })),
				);
			} catch (error) {
				persisted = [{ id: "error", name: String(error), bytes: -1 }];
			}
			appendFileSync(
				LOG,
				`${JSON.stringify({
					request,
					sessionID: event.sessionID,
					outgoingMessages: event.messages.length,
					outgoingBytes: partBytes(event.messages),
					persistedMessages,
					outgoingToolResults: outgoing,
					persistedToolResults: persisted,
					firstMessage: JSON.stringify(event.messages[0]?.content ?? "").slice(0, 160),
				})}\n`,
			);
		});
	},
};
