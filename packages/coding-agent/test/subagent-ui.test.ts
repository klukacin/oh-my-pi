import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { ExtensionUIContext } from "../src/extensibility/extensions/types";
import { SubagentUIBridge } from "../src/extensibility/subagent-ui";
import { initializeExtensions } from "../src/modes/runtime-init";
import { type PendingExtensionRequest, requestRpcSelect } from "../src/modes/rpc/rpc-mode";
import { createAgentSession } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

it("routes concurrent child answers independently and revokes aborted, disposed and old-generation dialogs", async () => {
	using dir = TempDir.createSync("omp-child-ui-");
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, path.join(dir.path(), "models.yml"));
	const pending = new Map<string, PendingExtensionRequest>();
	const frames: Array<{ agentId: string; frame: unknown }> = [];
	const bridge = new SubagentUIBridge(
		(identity, signal) =>
			({
				setWidget: () => {},
				select: (title, choices, options) =>
					requestRpcSelect(pending, frame => frames.push({ agentId: identity.agentId, frame }), title, choices, {
						...options,
						signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
					}),
			}) satisfies Pick<ExtensionUIContext, "select" | "setWidget"> as unknown as ExtensionUIContext,
	);
	const sessions: AgentSession[] = [];
	const createChild = async (id: string, parentAgentId = "Main") => {
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			modelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(),
			agentId: id,
			parentAgentId,
			taskDepth: 1,
			subagentUIBridge: bridge,
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: [],
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
		});
		sessions.push(session);
		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw new Error(error.error);
			},
		});
		return session;
	};
	const ask = (session: AgentSession) => session.extensionRunner!.getUIContext().select("Approve?", ["yes", "no"]);
	try {
		const first = await createChild("first");
		const second = await createChild("second", "first");
		const a = ask(first);
		const b = ask(second);
		const [aId, bId] = [...pending.keys()];
		expect(frames.map(frame => frame.agentId)).toEqual(["first", "second"]);
		pending.get(bId!)!.resolve({ type: "extension_ui_response", id: bId!, value: "no" });
		pending.get(aId!)!.resolve({ type: "extension_ui_response", id: aId!, value: "yes" });
		expect(await Promise.all([a, b])).toEqual(["yes", "no"]);
		const cancelled = ask(first);
		const stale = [...pending.values()][0]!;
		await first.abort();
		expect(await cancelled).toBeUndefined();
		expect(pending.size).toBe(0);
		stale.resolve({ type: "extension_ui_response", id: "stale", value: "yes" });
		const nextTurn = ask(first);
		expect(pending.size).toBe(1);
		await first.dispose();
		expect(await nextTurn).toBeUndefined();
		const nestedAsk = ask(second);
		bridge.close();
		expect(await nestedAsk).toBeUndefined();
		expect(await ask(second)).toBeUndefined();
		expect(pending.size).toBe(0);
	} finally {
		bridge.close();
		await Promise.all(sessions.map(session => session.dispose()));
		authStorage.close();
	}
});
