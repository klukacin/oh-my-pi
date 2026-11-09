import { RpcClient } from "../src/modes/rpc/rpc-client";
import type { PlanReviewRequestedEvent, PlanReviewResolvedEvent } from "../src/extensibility/extensions/types";
import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

it("keeps native reviews session-owned, recoverable from snapshots and cancelled by host abort", async () => {
	await using temp = await TempDir.create("@rpc-plan-review-");
	const sourceDir = path.resolve(import.meta.dir, "../src");
	const fixture = temp.join("runtime.ts");
	await Bun.write(
		fixture,
		`
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};
import { resolveLocalRoot } from ${JSON.stringify(path.join(sourceDir, "internal-urls/index.ts"))};
globalThis.fetch = async () => { throw new Error("Offline plan fixture refuses network"); };
const { session } = await createAgentSession({ cwd:process.cwd(), toolNames:[], enableMCP:false, enableLsp:false, disableExtensionDiscovery:true, settings:Settings.isolated({"compaction.enabled":false,"plan.enabled":true}) });
session.sessionManager.appendMessage({ role:"user", content:"Before plan", timestamp:0 });
const local = resolveLocalRoot({getArtifactsDir:()=>session.sessionManager.getArtifactsDir(),getSessionId:()=>session.sessionId});
await Bun.write(local+"/fixture-plan.md", "# Fixture plan\\n\\nNo model call is permitted.\\n");
await runRpcMode(session);
`,
	);
	using client = new RpcClient({
		command: () => [process.execPath, fixture],
		cwd: temp.path(),
		env: {
			HOME: temp.join("home"),
			PI_CODING_AGENT_DIR: temp.join("agent"),
			XDG_CONFIG_HOME: temp.join("config"),
			XDG_DATA_HOME: temp.join("data"),
			XDG_CACHE_HOME: temp.join("cache"),
			CI: "true",
			PI_NO_TITLE: "1",
		},
	});
	const events: Array<PlanReviewRequestedEvent | PlanReviewResolvedEvent> = [];
	const unsubscribe = client.onPlanReview(event => events.push(event));
	try {
		await client.start();
		const initial = await client.getState();
		expect(initial.capabilities).toMatchObject({ nativePlanReview: 1 });
		await client.setPlanMode(true);
		expect(await client.openPlanReview()).toBe(true);
		const review = await client.getPendingPlanReview();
		if (!review) throw new Error("Expected pending review");
		expect(review.planContent).toContain("No model call");
		expect(events.some(event => event.type === "plan_review_requested" && event.reviewId === review.reviewId)).toBe(
			true,
		);
		expect((await client.getState()).pendingPlanReview).toEqual(review);
		expect(await client.resolvePlanReview("other-session", review.reviewId, "save")).toBe(false);
		expect(await client.resolvePlanReview(initial.sessionId, "old-review", "save")).toBe(false);
		await client.abort();
		expect(await client.getPendingPlanReview()).toBeNull();
		expect(
			events.some(
				event =>
					event.type === "plan_review_resolved" &&
					event.reviewId === review.reviewId &&
					event.choice === undefined,
			),
		).toBe(true);
		expect(await client.resolvePlanReview(initial.sessionId, review.reviewId, "save")).toBe(false);
		expect(await client.openPlanReview()).toBe(true);
		const reopened = await client.getPendingPlanReview();
		if (!reopened) throw new Error("Expected reopened review");
		expect(reopened.reviewId).not.toBe(review.reviewId);
		const entries = await client.getEntries();
		const anchor = entries.entries.find(entry => entry.type === "message");
		if (!anchor) throw new Error("Expected navigation anchor");
		await client.navigateTree(anchor.id);
		expect(await client.getPendingPlanReview()).toBeNull();
		expect(await client.resolvePlanReview(initial.sessionId, reopened.reviewId, "save")).toBe(false);
		expect((await client.getState()).planMode?.enabled).toBe(false);
		await client.setPlanMode(true);
		expect(await client.openPlanReview()).toBe(true);
		const finalReview = await client.getPendingPlanReview();
		if (!finalReview) throw new Error("Expected final review");
		const identityChanged = Promise.withResolvers<{ sessionId: string; sessionFile: string }>();
		const unlistenIdentity = client.onSessionIdentityChanged(identity => identityChanged.resolve(identity));
		expect(await client.resolvePlanReview(initial.sessionId, finalReview.reviewId, "save")).toBe(true);
		const identity = await identityChanged.promise;
		unlistenIdentity();
		expect(identity.sessionId).not.toBe(initial.sessionId);
		expect((await client.getState()).sessionId).toBe(identity.sessionId);
		expect(await Bun.file(identity.sessionFile).exists()).toBe(true);
		expect(client.getStderr()).not.toContain("Offline plan fixture refuses network");
	} finally {
		unsubscribe();
		await client.stop();
	}
});
