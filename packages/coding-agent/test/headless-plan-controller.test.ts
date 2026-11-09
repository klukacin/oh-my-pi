import { persistPlanRestoreState, readPlanRestoreState } from "../src/plan-mode/restore-state";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
import { ModelRegistry } from "../src/config/model-registry";
import { cfgModelRoles } from "../src/config/model-settings";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import type { PlanReviewRequestedEvent, PlanReviewResolvedEvent } from "../src/extensibility/extensions/types";
import { HeadlessPlanController } from "../src/plan-mode/headless-controller";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import type { AuthStorage } from "../src/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, createAssistantMessage } from "./helpers/agent-session-setup";

let temp: TempDir;
let auth: AuthStorage;
let registry: ModelRegistry;
let session: AgentSession;
let controller: HeadlessPlanController;
let events: (PlanReviewRequestedEvent | PlanReviewResolvedEvent)[];
let errors: Error[];
let prompts: { text: string; synthetic?: boolean }[];

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("anthropic", "test-key");
	registry = new ModelRegistry(auth);
});
beforeEach(() => {
	temp = TempDir.createSync("headless-plan-");
	const model = registry.find("anthropic", "claude-sonnet-4-5")!;
	session = new AgentSession({
		agent: new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				throw new Error("Tests must not invoke a provider");
			},
		}),
		sessionManager: SessionManager.create(temp.path(), temp.path()),
		settings: Settings.isolated(),
		modelRegistry: registry,
	});
	events = [];
	errors = [];
	prompts = [];
	controller = new HeadlessPlanController(session, {
		onEvent: event => events.push(event),
		onError: error => errors.push(error),
		runPrompt: async (text, options) => {
			prompts.push({ text, ...options });
		},
	});
});
afterEach(async () => {
	controller.dispose();
	await session.dispose();
	vi.restoreAllMocks();
	temp.removeSync();
});
afterAll(() => {
	auth.close();
	resetSettingsForTest();
});
async function review() {
	await controller.enter();
	await Bun.write(controller.resolvePlanFilePath("local://feature-plan.md"), "# Feature\n\nInitial draft");
	expect(await controller.open()).toBe(true);
	return controller.getPending()!;
}

it("rejects stale, duplicate and incomplete answers and refines verbatim without leaving plan mode", async () => {
	const request = await review();
	controller.options.runPrompt = async (text, options) => {
		prompts.push({ text, ...options });
		await controller.handleApproval({ planFilePath: request.planFilePath, title: "Refined", planExists: true });
	};
	expect(controller.resolve("stale", "keep")).toBe(false);
	expect(controller.resolve(request.reviewId, "refine", { feedback: " " })).toBe(false);
	expect(controller.resolve(request.reviewId, "keep", { role: "unknown" })).toBe(false);
	expect(controller.resolve(request.reviewId, "refine", { feedback: "  Add tests\n" })).toBe(true);
	expect(controller.resolve(request.reviewId, "keep")).toBe(false);
	await controller.waitForIdle();
	expect(prompts).toEqual([{ text: "  Add tests\n" }]);
	expect(session.getPlanModeState()?.enabled).toBe(true);
	expect(events.filter(event => event.type === "plan_review_resolved")).toHaveLength(1);
	expect(controller.getPending()?.title).toBe("Refined");
	expect(controller.getPending()?.reviewId).not.toBe(request.reviewId);
});
it("rereads a modified plan at approval and keeps the same session with a synthetic execution prompt", async () => {
	const request = await review();
	const id = session.sessionManager.getSessionId();
	await Bun.write(controller.resolvePlanFilePath(request.planFilePath), "# Feature\n\nRevised on disk");
	expect(controller.resolve(request.reviewId, "keep")).toBe(true);
	await controller.waitForIdle();
	expect(errors).toEqual([]);
	expect(prompts[0]?.text).toContain("Revised on disk");
	expect(prompts[0]?.synthetic).toBe(true);
	expect(session.sessionManager.getSessionId()).toBe(id);
	expect(session.getPlanModeState()).toBeUndefined();
	expect(session.getPlanReferencePath()).toBe(request.planFilePath);
});
it("executes in a new session and carries the approved artifact into it", async () => {
	const request = await review();
	const id = session.sessionManager.getSessionId();
	const identities: { sessionId: string; sessionFile: string }[] = [];
	controller.options.onSessionChanged = identity => identities.push(identity);
	expect(controller.resolve(request.reviewId, "execute")).toBe(true);
	await controller.waitForIdle();
	expect(errors).toEqual([]);
	expect(session.sessionManager.getSessionId()).not.toBe(id);
	expect(await Bun.file(controller.resolvePlanFilePath(request.planFilePath)).text()).toContain("Initial draft");
	expect(prompts[0]?.synthetic).toBe(true);
	expect(identities).toEqual([
		{ sessionId: session.sessionId, sessionFile: session.sessionManager.getSessionFile()! },
	]);
	expect(await Bun.file(identities[0]!.sessionFile).exists()).toBe(true);
});
it("save writes the latest plan to the native suggested filename and clears the session without execution", async () => {
	const request = await review();
	const id = session.sessionManager.getSessionId();
	expect(controller.resolve(request.reviewId, "save")).toBe(true);
	await controller.waitForIdle();
	expect(errors).toEqual([]);
	expect(await Bun.file(path.join(temp.path(), "FEATURE_PLAN.md")).text()).toContain("Initial draft");
	expect(session.sessionManager.getSessionId()).not.toBe(id);
	expect(prompts).toEqual([]);
});
it("cancel and session replacement invalidate request identities without losing a reopenable draft", async () => {
	const request = await review();
	controller.cancel();
	expect(controller.resolve(request.reviewId, "keep")).toBe(false);
	expect(await controller.open()).toBe(true);
	const replacement = controller.getPending()!;
	expect(replacement.reviewId).not.toBe(request.reviewId);
	controller.options.runPrompt = async () => {
		await controller.withSessionChange(() => session.newSession());
	};
	expect(controller.resolve(replacement.reviewId, "refine", { feedback: "/new" })).toBe(true);
	await controller.waitForIdle();
	expect(errors).toEqual([]);
	expect(controller.resolve(replacement.reviewId, "keep")).toBe(false);
	expect(controller.getPending()).toBeUndefined();
	await controller.restore();
	expect(controller.getState().enabled).toBe(false);
	expect(prompts).toEqual([]);
});
it("copies pending snapshots so a client cannot enable a refused choice", async () => {
	vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 99, contextWindow: 100, percent: 99 });
	const request = await review();
	request.options.find(option => option.id === "keep")!.disabled = false;
	expect(controller.resolve(request.reviewId, "keep")).toBe(false);
	expect(controller.getPending()?.options.find(option => option.id === "keep")?.disabled).toBe(true);
});
it("cancellation during compaction stops execution and restores the execution model", async () => {
	const initial = session.model;
	cfgModelRoles.set(session.settings, { plan: "anthropic/claude-haiku-4-5" });
	const request = await review();
	session.sessionManager.appendMessage({ role: "user", content: "plan", timestamp: 0 });
	session.sessionManager.appendMessage({ role: "user", content: "review", timestamp: 1 });
	vi.spyOn(session, "compact").mockRejectedValue(new CompactionCancelledError());
	expect(controller.resolve(request.reviewId, "compact")).toBe(true);
	await controller.waitForIdle();
	expect(prompts).toEqual([]);
	expect(session.model?.id).toBe(initial?.id);
	expect(session.getPlanModeState()).toBeUndefined();
});
it("disconnect during compaction cannot dispatch an already accepted approval", async () => {
	const request = await review();
	session.sessionManager.appendMessage({ role: "user", content: "plan", timestamp: 0 });
	session.sessionManager.appendMessage({ role: "user", content: "review", timestamp: 1 });
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	vi.spyOn(session, "compact").mockImplementation(async () => {
		started.resolve();
		await release.promise;
		throw new CompactionCancelledError();
	});
	expect(controller.resolve(request.reviewId, "compact")).toBe(true);
	await started.promise;
	expect(controller.isWorking).toBe(true);
	expect(await controller.open()).toBe(false);
	await expect(controller.enter()).rejects.toThrow("still running");
	await expect(controller.exit()).rejects.toThrow("still running");
	const oldId = session.sessionId;
	await expect(controller.withSessionChange(() => session.newSession())).rejects.toThrow("still running");
	expect(session.sessionId).toBe(oldId);
	expect(controller.resolve(request.reviewId, "keep")).toBe(false);
	controller.cancel();
	release.resolve();
	await controller.waitForIdle();
	expect(prompts).toEqual([]);
	expect(errors.some(error => error.message.includes("no longer owns"))).toBe(true);
});

it("resumes native plan state with fresh review IDs and restores the pre-plan model after approval", async () => {
	const initial = session.model;
	cfgModelRoles.set(session.settings, { plan: "anthropic/claude-haiku-4-5" });
	const request = await review();
	expect(session.model?.id).not.toBe(initial?.id);
	const sessionFile = session.sessionManager.getSessionFile()!;
	const planModel = session.model;
	await session.sessionManager.flush();
	controller.dispose();
	await session.dispose();
	const restoredManager = await SessionManager.open(sessionFile, temp.path());
	session = new AgentSession({
		agent: new Agent({
			initialState: { model: planModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				throw new Error("Tests must not invoke a provider");
			},
		}),
		sessionManager: restoredManager,
		settings: Settings.isolated(),
		modelRegistry: registry,
	});
	controller = new HeadlessPlanController(session, {
		onError: error => errors.push(error),
		runPrompt: async (text, options) => {
			prompts.push({ text, ...options });
		},
	});
	await controller.restore();
	expect(controller.getState().enabled).toBe(true);
	expect(controller.getPending()).toBeDefined();
	const resumed = controller.getPending()!;
	expect(resumed.reviewId).not.toBe(request.reviewId);
	expect(controller.resolve(request.reviewId, "keep")).toBe(false);
	expect(controller.resolve(resumed.reviewId, "keep")).toBe(true);
	await controller.waitForIdle();
	expect(errors).toEqual([]);
	expect(session.model?.id).toBe(initial?.id);
	expect(prompts[0]?.synthetic).toBe(true);
});

it("does not resurrect a dismissed review or auto-review a draft on controller restore", async () => {
	const request = await review();
	controller.cancel();
	controller.dispose();
	controller = new HeadlessPlanController(session);
	await controller.restore();
	expect(controller.getState().enabled).toBe(true);
	expect(controller.getPending()).toBeUndefined();
	expect(controller.resolve(request.reviewId, "keep")).toBe(false);
	expect(await controller.open()).toBe(true);
});

it("rejects a second controller while the first still owns the session", () => {
	expect(() => new HeadlessPlanController(session)).toThrow("already owns");
});

it.each(["ok", "failed"] as const)(
	"%s compaction dispatches with the native model transition policy",
	async outcome => {
		const initial = session.model;
		cfgModelRoles.set(session.settings, { plan: "anthropic/claude-haiku-4-5" });
		const request = await review();
		const planModel = session.model;
		session.sessionManager.appendMessage({ role: "user", content: "plan", timestamp: 0 });
		session.sessionManager.appendMessage(createAssistantMessage("Draft"));
		vi.spyOn(session, "compact").mockImplementation(async (_instructions, options) => {
			expect(session.model?.id).toBe(planModel?.id);
			expect(options?.suppressContinuation).toBe(true);
			expect(options?.readerModel?.id).toBe(initial?.id);
			if (outcome === "failed") throw new Error("Fixture summarization failure");
			return { summary: "Plan summary", tokensBefore: 10, firstKeptEntryId: "fixture" };
		});
		expect(controller.resolve(request.reviewId, "compact")).toBe(true);
		await controller.waitForIdle();
		expect(prompts[0]?.synthetic).toBe(true);
		expect(session.model?.id).toBe(outcome === "ok" ? initial?.id : planModel?.id);
	},
);

it("applies an explicit execution role after leaving the plan model", async () => {
	cfgModelRoles.set(session.settings, {
		default: "anthropic/claude-sonnet-4-5",
		smol: "anthropic/claude-haiku-4-5",
		plan: "anthropic/claude-sonnet-4-5",
	});
	const request = await review();
	expect(request.tiers?.some(tier => tier.role === "smol")).toBe(true);
	expect(controller.resolve(request.reviewId, "keep", { role: "smol" })).toBe(true);
	await controller.waitForIdle();
	expect(session.model?.id).toBe("claude-haiku-4-5");
	expect(prompts[0]?.synthetic).toBe(true);
});

it("restores model and tool snapshots from the active branch rather than a later sibling", () => {
	const root = session.sessionManager.appendCustomEntry("fixture-root");
	const firstModel = registry.find("anthropic", "claude-sonnet-4-5")!;
	const siblingModel = registry.find("anthropic", "claude-haiku-4-5")!;
	persistPlanRestoreState(session, { enabled: ["read"], mounted: [], registered: ["read"] }, { model: firstModel });
	const firstLeaf = session.sessionManager.getLeafId()!;
	session.sessionManager.branch(root);
	persistPlanRestoreState(
		session,
		{ enabled: ["write"], mounted: [], registered: ["write"] },
		{ model: siblingModel },
	);
	session.sessionManager.branch(firstLeaf);
	const restored = readPlanRestoreState(session);
	expect(restored.model?.model.id).toBe(firstModel.id);
	expect(restored.tools?.enabled).toEqual(["read"]);
});
