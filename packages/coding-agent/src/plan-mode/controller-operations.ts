import { persistPlanRestoreState, readPlanRestoreState } from "./restore-state";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import {
	replaceTabs,
	shortenEmbeddedPaths,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { CompactOptions } from "../extensibility/extensions/types";
import { copyLocalArtifacts } from "../internal-urls";
import type { AgentSession, ResolvedRoleModel } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import type { CompactMode } from "../session/compact-modes";
import { isMCPToolName } from "../tools/builtin-names";
import { humanizePlanTitle } from "./approved-plan";
import { autosaveApprovedPlan } from "./plan-autosave";
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../prompts/system/plan-mode-compact-instructions.md" with { type: "text" };

export interface PlanToolPresentation {
	enabled: string[];
	mounted: string[];
	registered: string[];
}
export interface PlanModelState {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}
export interface NativePlanHost {
	assertActive?(): void;
	dispatchPlanPrompt?(text: string): Promise<void>;
	session: AgentSession;
	sessionManager: SessionManager;
	planModeEnabled: boolean;
	planModePaused: boolean;
	planModePlanFilePath: string | undefined;
	planModeHasEntered: boolean;
	planModePreviousToolPresentation: PlanToolPresentation | undefined;
	planModePreviousModelState: PlanModelState | undefined;
	goalModeEnabled: boolean;
	goalModePaused: boolean;
	vibeModeEnabled: boolean;
	lastAssistantUsage: unknown;
	getPlanFilePath(): Promise<string>;
	applyPlanModeModel(): Promise<void>;
	restorePlanPreviousModel(state: PlanModelState): Promise<void>;
	clearPendingPlanModelSwitch(): void;
	updatePlanModeStatus(): void;
	showStatus(message: string): void;
	showWarning(message: string): void;
	exitPlanMode(options?: { silent?: boolean; paused?: boolean; deferModelRestore?: boolean }): Promise<void>;
	resolveLocalRoot(): string;
	resolvePlanFilePath(path: string): string;
	handleClearCommand(): Promise<void>;
	handleCompactCommand(
		customInstructions?: string,
		mode?: CompactMode,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		options?: Pick<CompactOptions, "internalGuidance" | "readerModel">,
	): Promise<CompactionOutcome>;
	applyDeferredPlanModelTransition(
		outcome: CompactionOutcome | undefined,
		executionModel: ResolvedRoleModel | undefined,
	): Promise<void>;
	applyPlanExecutionModel(entry: ResolvedRoleModel | undefined): Promise<void>;
	hidePlanReview(owner?: object): void;
	ui: { requestRender(): void };
}

export async function enterNativePlanMode(
	host: NativePlanHost,
	options?: {
		planFilePath?: string;
		workflow?: "parallel" | "iterative";
		preserveRestoredModel?: boolean;
	},
): Promise<void> {
	if (host.planModeEnabled) {
		return;
	}
	if (host.goalModeEnabled || host.goalModePaused) {
		host.showWarning("Exit goal mode first.");
		return;
	}
	if (host.vibeModeEnabled) {
		host.showWarning("Exit vibe mode first.");
		return;
	}

	host.planModePaused = false;

	const planFilePath = options?.planFilePath ?? (await host.getPlanFilePath());
	const previousTools = host.session.getEnabledToolNames();
	const previousMountedTools = host.session.getMountedXdevToolNames();
	// `plan-mode-active.md` instructs the agent to draft the plan file with
	// `write` and refine it with `edit`, and plan approval itself is a `write`
	// to `xd://propose`. Both must be in the active set or the agent falls
	// back to `edit` on a non-existent file and stalls — and cannot submit the plan.
	// `edit` is an essential built-in and always ships top-level; re-activate
	// `write` here only when the current registry entry is the built-in write
	// tool (issue #3165). A shadowing extension tool named `write` must stay
	// inactive because plan mode's read-only guarantee relies on the built-in
	// write/edit guard. The standing handler below consumes plan-approval
	// dispatches.
	const planAugmentations: string[] = [];
	// A shadowing extension tool named `write` has no `xd://` transport, so plan
	// approval would never dispatch and the turn would loop on propose writes
	// forever (issue #14030). Drop it from the active set rather than carrying it
	// over: keeping it active breaks both the read-only guarantee and approval.
	if (host.session.hasBuiltInTool("write")) {
		planAugmentations.push("write");
	} else if (previousTools.includes("write")) {
		host.showWarning(
			"Plan mode: the `write` tool is provided by an extension and cannot submit plans. Disable it to use plan mode.",
		);
	}
	const uniquePlanTools = [...new Set([...previousTools.filter(name => name !== "write"), ...planAugmentations])];

	host.planModePreviousToolPresentation = {
		enabled: previousTools.filter(name => !isMCPToolName(name)),
		mounted: previousMountedTools.filter(name => !isMCPToolName(name)),
		registered: host.session.getAllToolNames(),
	};
	host.planModePlanFilePath = planFilePath;
	host.planModeEnabled = true;
	// Suppress cache-miss marker on the next turn: plan mode changes the system
	// prompt, which predictably invalidates the cache.
	host.lastAssistantUsage = undefined;

	// Plan mode state must land before the tool partition: it keeps `write`
	// active as the staging transport, and plan approval is a top-level
	// `write` to `xd://propose`.
	const previousPlanModeState = host.session.getPlanModeState();
	host.session.setPlanModeState({
		enabled: true,
		planFilePath,
		workflow: options?.workflow ?? "parallel",
		reentry: host.planModeHasEntered,
	});
	try {
		await host.session.setActiveToolsByName(uniquePlanTools);
	} catch (error) {
		host.session.setPlanModeState(previousPlanModeState);
		host.planModeEnabled = false;
		throw error;
	}
	host.session.setPlanProposalHandler?.(title => host.session.preparePlanForReview(title));
	if (host.session.isStreaming) {
		await host.session.sendPlanModeContext({ deliverAs: "steer" });
	}
	host.planModeHasEntered = true;
	// Session loading already restored the model recorded in the journal.
	// Reapplying today's plan role here would replace a CLI/session-specific
	// selection with current config during --resume or an in-process switch.
	if (!options?.preserveRestoredModel) {
		await host.applyPlanModeModel();
		persistPlanRestoreState(host.session, host.planModePreviousToolPresentation, host.planModePreviousModelState);
	} else {
		const restored = readPlanRestoreState(host.session);
		if (restored.tools) host.planModePreviousToolPresentation = restored.tools;
		if (restored.model) host.planModePreviousModelState = restored.model;
	}
	host.updatePlanModeStatus();
	host.sessionManager.appendModeChange("plan", { planFilePath });
	host.showStatus(`Plan mode enabled. Plan file: ${planFilePath}`);
}

export async function tearDownNativePlanMode(
	host: NativePlanHost,
	options?: {
		silent?: boolean;
		paused?: boolean;
		deferModelRestore?: boolean;
	},
): Promise<void> {
	const planModeState = host.session.getPlanModeState();
	const planModeTools = host.session.getEnabledToolNames();
	const planModeMountedTools = host.session.getMountedXdevToolNames();
	const planModeModelState = host.session.model
		? {
				model: host.session.model,
				thinkingLevel: host.session.configuredThinkingLevel(),
			}
		: undefined;
	host.session.setPlanModeState(undefined);
	try {
		const previousPresentation = host.planModePreviousToolPresentation;
		if (previousPresentation) {
			await host.session.restoreNonMCPToolPresentation(
				previousPresentation.enabled,
				previousPresentation.mounted,
				previousPresentation.registered,
			);
		}
		if (host.planModePreviousModelState && !options?.deferModelRestore) {
			await host.restorePlanPreviousModel(host.planModePreviousModelState);
		}
		// If #applyPlanModeModel queued a deferred switch to the plan-role model
		// (because the session was streaming on entry), drop it now: we are
		// leaving plan mode, so flushing it on the next agent_end would land the
		// session on the plan-role model after the user has exited plan mode
		// (issue #816). This runs even when deferModelRestore is set
		// (compact-approval path): otherwise the stale plan switch survives and
		// flushPendingModelSwitch() later clobbers the restored/execution model.
		if (host.planModePreviousModelState) host.clearPendingPlanModelSwitch();
	} catch (error) {
		host.session.setPlanModeState(planModeState);
		if (
			planModeModelState &&
			(!modelsAreEqual(host.session.model, planModeModelState.model) ||
				host.session.configuredThinkingLevel() !== planModeModelState.thinkingLevel)
		) {
			try {
				await host.restorePlanPreviousModel(planModeModelState);
			} catch (rollbackError) {
				logger.warn("Failed to restore plan model after plan exit failure", {
					error: String(rollbackError),
				});
			}
		}
		const enabledTools = host.session.getEnabledToolNames();
		const mountedTools = host.session.getMountedXdevToolNames();
		if (
			enabledTools.length !== planModeTools.length ||
			enabledTools.some((name, index) => name !== planModeTools[index]) ||
			mountedTools.length !== planModeMountedTools.length ||
			mountedTools.some((name, index) => name !== planModeMountedTools[index])
		) {
			try {
				await host.session.setActiveToolPresentation(planModeTools, planModeMountedTools);
			} catch (rollbackError) {
				logger.warn("Failed to restore plan tools after plan exit failure", {
					error: String(rollbackError),
				});
			}
		}
		throw error;
	}
	host.session.setPlanProposalHandler?.(null);
	host.planModeEnabled = false;
	// Suppress cache-miss marker on the next turn: plan exit changes the system
	// prompt, which predictably invalidates the cache.
	host.lastAssistantUsage = undefined;
	host.planModePaused = options?.paused ?? false;
	host.planModePlanFilePath = undefined;
	host.planModePreviousToolPresentation = undefined;
	if (!options?.deferModelRestore) host.planModePreviousModelState = undefined;
	host.updatePlanModeStatus();
	const paused = options?.paused ?? false;
	host.sessionManager.appendModeChange(paused ? "plan_paused" : "none");
	if (!options?.silent) {
		host.showStatus(paused ? "Plan mode paused." : "Plan mode disabled.");
	}
}

export async function approveNativePlan(
	host: NativePlanHost,
	planContent: string,
	options: {
		planFilePath: string;
		title: string;
		preserveContext?: boolean;
		compactBeforeExecute?: boolean;
		executionModel?: ResolvedRoleModel;
		reviewOwner: object;
	},
): Promise<boolean> {
	host.assertActive?.();
	const previousPresentation = host.planModePreviousToolPresentation ?? {
		enabled: host.session.getEnabledToolNames().filter(name => !isMCPToolName(name)),
		mounted: host.session.getMountedXdevToolNames().filter(name => !isMCPToolName(name)),
		registered: host.session.getAllToolNames(),
	};

	// Mark the pending abort caused by the plan-mode → compaction transition as
	// silent BEFORE #exitPlanMode raises it. The `finally` below clears the
	// flag on every terminal compaction outcome (ok / cancelled / failed /
	// throw) so a leaked flag cannot silence a later unrelated abort.
	// Branchless mark+clear when !compactBeforeExecute: mark is gated; clear
	// is unconditional and idempotent.
	if (options.compactBeforeExecute) {
		host.session.markPlanInternalAbortPending();
	}
	let compactOutcome: CompactionOutcome | undefined;
	try {
		await host.exitPlanMode({
			silent: true,
			paused: false,
			deferModelRestore: options.compactBeforeExecute === true,
		});

		host.assertActive?.();
		if (!options.preserveContext) {
			const oldLocalRoot = host.resolveLocalRoot();
			await host.handleClearCommand();
			host.assertActive?.();
			const newLocalRoot = host.resolveLocalRoot();
			await copyLocalArtifacts(oldLocalRoot, newLocalRoot);
			const newLocalPath = host.resolvePlanFilePath(options.planFilePath);
			await fs.mkdir(path.dirname(newLocalPath), { recursive: true });
			await fs.writeFile(newLocalPath, planContent);
		} else if (options.compactBeforeExecute) {
			// Distill the plan-mode transcript before the execution turn is queued so
			// the plan-approved synthetic prompt lands as a fresh cache anchor.
			// Outcome is consumed after tool-restoration and plan-reference-path
			// bookkeeping below; `markPlanReferenceSent` is intentionally deferred
			// past the cancel guard — see the comment at the cancel branch.
			// Cancellation skips the synthetic-prompt dispatch (operator's explicit
			// abort is honored); failure proceeds best-effort — approval intent stands.
			const compactionPrompt = prompt.render(planModeCompactInstructionsPrompt, {
				planFilePath: options.planFilePath,
			});
			// Pin the plan reference path BEFORE compaction so any user messages
			// queued during the compaction await (which `handleCompactCommand`
			// flushes via `flushCompactionQueue` before returning) see the
			// approved plan in `#buildPlanReferenceMessage`. Reassignment after
			// the try/finally is idempotent and kept for the !compactBeforeExecute
			// branch.
			host.session.setPlanReferencePath(options.planFilePath);
			// Ride the plan-mode distillation prompt through as `internalGuidance`
			// so it reaches native summarization without leaking into the public
			// `customInstructions` channel on `session_before_compact` — extensions
			// there treat that field as user focus and would query-bias the
			// summary toward the plan boilerplate (issue #4359). The model the
			// transition below restores reads the summary.
			const readerModel =
				options.executionModel?.model ?? host.planModePreviousModelState?.model ?? host.session.model;
			compactOutcome = await host.handleCompactCommand(
				undefined,
				undefined,
				outcome => host.applyDeferredPlanModelTransition(outcome, options.executionModel),
				{ internalGuidance: compactionPrompt, readerModel },
			);
		}
	} finally {
		// Unconditional clear. Idempotent: a no-op when the flag was never set
		// (i.e., the !compactBeforeExecute branch), and a no-op when the flag
		// was already consumed by AgentSession.#handleAgentEvent's aborted
		// message_end stamping. Guarantees the flag is dead at every exit.
		host.session.clearPlanInternalAbortPending();
	}

	host.assertActive?.();
	// Restore the execution tool set, but force-enable `read` so the durable
	// local:// plan remains available if the inline copy becomes unrecoverable.
	const executionTools = previousPresentation.enabled.includes("read")
		? previousPresentation.enabled
		: [...previousPresentation.enabled, "read"];
	await host.session.restoreNonMCPToolPresentation(
		executionTools,
		previousPresentation.mounted,
		previousPresentation.registered,
	);
	host.assertActive?.();
	host.session.setPlanReferencePath(options.planFilePath);
	try {
		const autosaved = await autosaveApprovedPlan({
			settings: host.session.settings,
			cwd: host.sessionManager.getCwd(),
			title: options.title,
			planContent,
		});
		if (autosaved) {
			const displayPath = truncateToWidth(replaceTabs(shortenPath(autosaved)), TRUNCATE_LENGTHS.CONTENT);
			host.showStatus(`Saved plan to ${displayPath}.`);
		}
	} catch (error) {
		const detail = truncateToWidth(
			shortenEmbeddedPaths(
				replaceTabs(error instanceof Error ? error.message : String(error))
					.replace(/[\r\n]+/g, " ")
					.trim(),
			),
			TRUNCATE_LENGTHS.CONTENT,
		);
		host.showWarning(`Failed to autosave plan: ${detail}`);
	}

	host.assertActive?.();
	// Resolve the deferred plan-approval model transition. On the compact path
	// the before-flush hook passed to handleCompactCommand already ran this (so
	// any input queued during compaction executed on the post-compaction
	// model); the re-run here is idempotent and covers the short-circuit where
	// compaction never executed. It runs for "cancelled" too — the operator
	// aborted only the compaction, not the approval — so the next turn no longer
	// lands on the plan model. "failed" stays on the plan model (context
	// intact) and dispatches best-effort.
	if (options.compactBeforeExecute) {
		await host.applyDeferredPlanModelTransition(compactOutcome, options.executionModel);
	} else {
		await host.applyPlanExecutionModel(options.executionModel);
	}

	host.assertActive?.();
	if (compactOutcome === "cancelled") {
		// Explicit abort: honor it. `executeCompaction` already surfaced
		// `showError("Compaction cancelled")`; we add the deferred-dispatch
		// warning and exit without dispatching the synthetic plan-approved
		// prompt. `markPlanReferenceSent` stays unset so
		// `AgentSession.#buildPlanReferenceMessage` injects the plan reference
		// on the operator's next `prompt()` call.
		host.showWarning(
			"Plan approved, but compaction was cancelled — execution not dispatched. Submit a turn to continue.",
		);
		return false;
	}

	// Approved plans land in a fresh (or compacted) session whose first user-visible
	// turn is the synthetic plan-approved prompt — that path bypasses the
	// input-controller's title generation. Seed an auto-name from the plan title
	// so the session is not left unnamed. `setSessionName("auto")` is a no-op
	// when the user has already chosen a name (preserveContext paths).
	const seededName = humanizePlanTitle(options.title);
	if (seededName && !host.sessionManager.getSessionName()) {
		await host.sessionManager.setSessionName(seededName, "auto");
	}

	host.assertActive?.();
	// markPlanReferenceSent fires only on the dispatch path so the synthetic
	// plan-approved prompt is the source of the reference injection.
	host.session.markPlanReferenceSent();
	const planModePrompt = prompt.render(planModeApprovedPrompt, {
		planFilePath: options.planFilePath,
		planContent,
		contextPreserved: options.preserveContext === true,
	});
	// Close the review overlay only now — after the async title write and plan
	// prompt are prepared, immediately before the execution turn is queued. The
	// synthetic prompt below blocks in `session.prompt` for the whole run, so
	// hiding here (rather than after #approvePlan returns) keeps the operator off
	// the stale plan-review screen (issue #5688) while #5319's stale-buffer guard
	// stays intact. Deferring the hide past the awaited `setSessionName` also
	// prevents restored editor focus from letting operator keystrokes submit a
	// normal turn ahead of the approved execution turn (PR #5689 review).
	// The ownership-bound hide is idempotent, so the caller's trailing
	// `closePlanReview()` — and a stale continuation after a replacement review
	// opened — stay safe no-ops.
	host.hidePlanReview(options.reviewOwner);
	host.ui.requestRender();
	// A user turn queued during compaction was already fired by
	// `flushCompactionQueue` before we returned from `handleCompactCommand`; the
	// old abort-then-prompt path would have discarded that operator turn AND
	// still surfaced `AgentBusyError` when the queued turn kicked off in the
	// synchronous gap. Preserve the in-flight work and queue the hidden
	// execution directive behind it as a synthetic follow-up. If `isStreaming`
	// flips true between the check and dispatch (the same fire-and-forget race
	// noted below), catch `AgentBusyError` and fall back to the same queue.
	host.assertActive?.();
	if (host.dispatchPlanPrompt) {
		await host.dispatchPlanPrompt(planModePrompt);
		return true;
	}
	if (host.session.isStreaming) {
		await host.session.followUp(planModePrompt, undefined, {
			synthetic: true,
		});
	} else {
		try {
			await host.session.prompt(planModePrompt, { synthetic: true });
		} catch (error) {
			if (!(error instanceof AgentBusyError)) throw error;
			await host.session.followUp(planModePrompt, undefined, {
				synthetic: true,
			});
		}
	}
	return true;
}
