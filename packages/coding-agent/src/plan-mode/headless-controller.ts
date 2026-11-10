import { persistPendingPlanReview, readPendingPlanReview } from "./restore-state";
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { CompactionCancelledError, type CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { cfgCycleOrder, cfgModelRoles } from "../config/model-settings";
import type {
	CompactOptions,
	PlanReviewChoice,
	PlanReviewRequestedEvent,
	PlanReviewResolvedEvent,
} from "../extensibility/extensions/types";
import { resolveLocalRoot } from "../internal-urls";
import type { AgentSession, ResolvedRoleModel } from "../session/agent-session";
import type { CompactMode } from "../session/compact-modes";
import { type PlanApprovalDetails, resolvePlanTitle } from "./approved-plan";
import {
	approveNativePlan,
	enterNativePlanMode,
	tearDownNativePlanMode,
	type NativePlanHost,
	type PlanModelState,
	type PlanToolPresentation,
} from "./controller-operations";
import { resolvePlanModelTransition } from "./model-transition";
import { listPlanFiles, readPlanFile, resolvePlanFilePath } from "./plan-files";
import { planSaveFileName } from "./plan-autosave";
import { type PlanReviewInput, validatePlanReviewChoice } from "./review-choice";
import { cfgPlanEnabled } from "./settings";
import { planApprovalDispatchDetails } from "../tools/resolve";
import { shouldEnterPlanModeOnStartup } from "./startup";

export interface HeadlessPlanOptions {
	onEvent?: (event: PlanReviewRequestedEvent | PlanReviewResolvedEvent) => void;
	onError?: (error: Error) => void;
	onSettled?: () => void;
	onSessionChanged?: (identity: { sessionId: string; sessionFile: string }) => void;
	runPrompt?: (text: string, options: { synthetic?: boolean }) => Promise<void>;
}
const ownedSessions = new WeakSet<AgentSession>();

interface PendingReview {
	request: PlanReviewRequestedEvent;
	cycle: ResolvedRoleModel[];
	selectedIndex: number;
	generation: number;
}

/** One controller owns the plan lifecycle of one AgentSession; transports never own an answer. */
export class HeadlessPlanController implements NativePlanHost {
	planModeEnabled = false;
	planModePaused = false;
	planModePlanFilePath: string | undefined;
	planModeHasEntered = false;
	planModePreviousToolPresentation: PlanToolPresentation | undefined;
	planModePreviousModelState: PlanModelState | undefined;
	lastAssistantUsage: unknown;
	readonly ui = { requestRender() {} };
	#pending: PendingReview | undefined;
	#sessionId: string;
	#generation = 0;
	#disposed = false;
	#deferredModel: PlanModelState | undefined;
	#deferredIsPlan = false;
	#unsubscribe: () => void;
	#unlisten: () => void;
	#work = new Set<Promise<void>>();
	#eventDelivery: Promise<void> = Promise.resolve();
	#opening = false;
	#transitioning = false;
	#sessionChangeScope = new AsyncLocalStorage<{ active: boolean }>();
	#settling: { generation: number } | undefined;
	#modelChanges = 0;

	constructor(
		readonly session: AgentSession,
		readonly options: HeadlessPlanOptions = {},
	) {
		if (ownedSessions.has(session)) throw new Error("A plan controller already owns this session");
		ownedSessions.add(session);
		this.#sessionId = session.sessionManager.getSessionId();
		this.#unsubscribe = session.subscribe(event => {
			if (event.type === "agent_end") this.#background(this.#flushModel());
			if (event.type !== "tool_execution_end" || event.isError || !this.planModeEnabled) return;
			const details = planApprovalDispatchDetails(event.toolName, event.result);
			if (details) this.#background(this.handleApproval(details));
		});
		this.#unlisten = cfgModelRoles.listen(session.settings, () => {
			if (this.planModeEnabled) this.#background(this.#applyPlanModel());
		});
	}
	get sessionManager() {
		return this.session.sessionManager;
	}
	get goalModeEnabled() {
		return this.session.getGoalModeState()?.enabled === true;
	}
	get goalModePaused() {
		return this.session.getGoalModeState()?.goal.status === "paused";
	}
	get vibeModeEnabled() {
		return this.sessionManager.buildSessionContext().mode === "vibe";
	}
	#assertOwner(generation = this.#generation): void {
		if (this.#disposed || generation !== this.#generation || this.#sessionId !== this.sessionManager.getSessionId())
			throw new Error("Plan review no longer owns this session");
	}
	assertActive(): void {
		this.#assertOwner(this.#settling?.generation ?? this.#generation);
	}
	#background(work: Promise<void>): void {
		const tracked = work
			.catch(error => this.options.onError?.(error instanceof Error ? error : new Error(String(error))))
			.finally(() => {
				this.#work.delete(tracked);
				this.options.onSettled?.();
			});
		this.#work.add(tracked);
	}
	get transitionPending(): boolean {
		return this.#settling !== undefined || this.#opening || this.#transitioning || this.#modelChanges > 0;
	}
	async withSessionChange<T>(change: () => Promise<T>): Promise<T> {
		if (this.#sessionChangeScope.getStore()?.active) return await change();
		if (this.transitionPending) throw new Error("Plan transition is still running");
		this.#transitioning = true;
		this.cancel({ preservePending: true });
		const owner = { active: true };
		try {
			return await this.#sessionChangeScope.run(owner, change);
		} finally {
			owner.active = false;
			this.#transitioning = false;
			await this.restore();
		}
	}
	get isWorking(): boolean {
		return this.#work.size > 0 || this.#opening || this.#transitioning || this.#settling !== undefined;
	}
	async waitForIdle(): Promise<void> {
		while (this.#work.size) await Promise.all(this.#work);
	}
	getState() {
		return { enabled: this.planModeEnabled, paused: this.planModePaused, planFilePath: this.planModePlanFilePath };
	}
	getPending(): PlanReviewRequestedEvent | undefined {
		if (this.#sessionId !== this.sessionManager.getSessionId()) {
			if (this.#pending) this.cancel({ preservePending: true });
			return undefined;
		}
		return this.#pending ? structuredClone(this.#pending.request) : undefined;
	}
	async restore(options?: { preserveSessionPlan?: boolean }): Promise<void> {
		if (this.transitionPending) throw new Error("Plan transition is still running");
		this.#transitioning = true;
		try {
			await this.#restore(options?.preserveSessionPlan);
		} finally {
			this.#transitioning = false;
		}
		if (this.#pending) this.#emit(this.#pending.request);
	}
	async #restore(preserveSessionPlan = false): Promise<void> {
		if (this.#settling !== undefined) throw new Error("Plan transition is still running");
		const activePlan = preserveSessionPlan ? this.session.getPlanModeState() : undefined;
		this.cancel({ preservePending: true });
		this.#sessionId = this.sessionManager.getSessionId();
		this.planModeEnabled = false;
		this.planModePaused = false;
		this.planModePreviousModelState = undefined;
		this.planModePreviousToolPresentation = undefined;
		this.planModeHasEntered = false;
		this.#deferredModel = undefined;
		this.session.setPlanModeState(undefined);
		this.session.setPlanProposalHandler(null);
		const context = this.sessionManager.buildSessionContext();
		if (!cfgPlanEnabled.get(this.session.settings)) return;
		if (context.mode === "plan" || activePlan?.enabled) {
			const planFilePath =
				typeof context.modeData?.planFilePath === "string"
					? context.modeData.planFilePath
					: activePlan?.planFilePath;
			await enterNativePlanMode(this, { planFilePath, workflow: activePlan?.workflow, preserveRestoredModel: true });
			const pending = readPendingPlanReview(this.session);
			if (pending) await this.#openReview({ ...pending, planExists: true }, false, true);
		} else if (context.mode === "plan_paused") {
			this.planModePaused = true;
			this.planModeHasEntered = true;
		} else if (shouldEnterPlanModeOnStartup(this.sessionManager, this.session.settings)) {
			await enterNativePlanMode(this);
		}
	}
	async enter(options?: { planFilePath?: string; workflow?: "parallel" | "iterative" }): Promise<void> {
		this.#assertOwner();
		if (!cfgPlanEnabled.get(this.session.settings)) throw new Error("Plan mode is disabled in settings");
		if (this.goalModeEnabled || this.goalModePaused || this.vibeModeEnabled)
			throw new Error("Exit the active mode first");
		if (this.#settling !== undefined || this.#transitioning || this.#opening)
			throw new Error("Plan transition is still running");
		this.#transitioning = true;
		try {
			await enterNativePlanMode(this, options);
		} finally {
			this.#transitioning = false;
			this.options.onSettled?.();
		}
	}
	async exit(): Promise<void> {
		if (this.transitionPending) throw new Error("Plan transition is still running");
		this.#transitioning = true;
		try {
			this.#assertOwner();
			this.cancel();
			if (this.session.isStreaming) {
				await this.session.runModeExitTeardown(async () => {
					await this.session.abort();
					await this.exitPlanMode();
				});
			} else await this.exitPlanMode();
			if (this.planModePaused) {
				this.planModePaused = false;
				this.planModeHasEntered = false;
				this.sessionManager.appendModeChange("none");
			}
		} finally {
			this.#transitioning = false;
		}
	}
	async open(): Promise<boolean> {
		this.#assertOwner();
		if (this.#pending) return true;
		if (this.#settling !== undefined || this.#transitioning) return false;
		if (!this.planModeEnabled || this.session.isStreaming || this.session.isCompacting || this.#opening) return false;
		this.#opening = true;
		const generation = this.#generation;
		try {
			const [planFilePath] = await listPlanFiles(this.#fileOptions());
			if (!planFilePath) return false;
			const content = await readPlanFile(planFilePath, this.#fileOptions());
			this.#assertOwner(generation);
			if (!content?.trim()) return false;
			await this.#openReview(
				{ planFilePath, title: resolvePlanTitle({ planContent: content, planFilePath }).title, planExists: true },
				false,
			);
			return this.#pending !== undefined;
		} finally {
			this.#opening = false;
		}
	}
	async handleApproval(details: PlanApprovalDetails): Promise<void> {
		await this.#openReview(details, true);
	}
	async #openReview(details: PlanApprovalDetails, abortTurn: boolean, restoring = false): Promise<void> {
		this.#assertOwner();
		if (!this.planModeEnabled || this.#pending || this.#settling !== undefined || (!restoring && this.#transitioning))
			return;
		const generation = this.#generation;
		if (abortTurn) {
			this.session.markPlanInternalAbortPending();
			try {
				await this.session.abort();
			} finally {
				this.session.clearPlanInternalAbortPending();
			}
		}
		const content = await readPlanFile(details.planFilePath, this.#fileOptions());
		this.#assertOwner(generation);
		if (
			!this.planModeEnabled ||
			this.#pending ||
			(!abortTurn && (this.session.isStreaming || this.session.isCompacting))
		)
			return;
		if (!content?.trim()) throw new Error(`Plan file not found at ${details.planFilePath}`);
		await this.sessionManager.ensureOnDisk();
		this.#assertOwner(generation);
		if (
			!this.planModeEnabled ||
			this.#pending ||
			this.#settling !== undefined ||
			(!abortTurn && (this.session.isStreaming || this.session.isCompacting))
		)
			return;
		const state = this.session.getPlanModeState();
		this.planModePlanFilePath = details.planFilePath;
		if (state?.enabled && state.planFilePath !== details.planFilePath) {
			this.session.setPlanModeState({ ...state, planFilePath: details.planFilePath });
			this.sessionManager.appendModeChange("plan", { planFilePath: details.planFilePath });
		}
		const cycle = this.session.getRoleModelCycle(cfgCycleOrder.get(this.session.settings));
		const tiers = cycle && cycle.models.length > 1 ? cycle.models : [];
		const executionModel = this.planModePreviousModelState?.model ?? this.session.model;
		const usage = this.session.getContextUsage(
			typeof executionModel?.contextWindow === "number"
				? { contextWindow: executionModel.contextWindow }
				: undefined,
		);
		const request: PlanReviewRequestedEvent = {
			type: "plan_review_requested",
			reviewId: crypto.randomUUID(),
			sessionId: this.#sessionId,
			title: details.title,
			planFilePath: details.planFilePath,
			planContent: content,
			options: [
				{ id: "execute", label: "Approve and execute", disabled: false },
				{ id: "compact", label: "Approve and compact context", disabled: false },
				{ id: "keep", label: "Approve and keep context", disabled: usage !== undefined && usage.percent > 95 },
				{ id: "refine", label: "Refine plan", disabled: false },
				{ id: "save", label: "Save plan and quit", disabled: false },
			],
			...(tiers.length
				? {
						tiers: tiers.map(entry => ({
							role: entry.role,
							provider: entry.model.provider,
							model: entry.model.id,
							...(entry.explicitThinkingLevel && entry.thinkingLevel
								? { thinkingLevel: entry.thinkingLevel }
								: {}),
						})),
					}
				: {}),
		};
		const defaultIndex = tiers.findIndex(entry => entry.role === "default");
		this.#pending = {
			request,
			cycle: tiers,
			selectedIndex: defaultIndex >= 0 ? defaultIndex : (cycle?.currentIndex ?? 0),
			generation,
		};
		persistPendingPlanReview(this.session, request);
		if (!restoring) this.#emit(request);
	}
	resolve(reviewId: string, choice: PlanReviewChoice, input?: PlanReviewInput): boolean {
		const pending = this.#pending;
		if (
			this.#disposed ||
			this.#transitioning ||
			this.#settling !== undefined ||
			!pending ||
			pending.request.reviewId !== reviewId ||
			pending.request.sessionId !== this.sessionManager.getSessionId() ||
			!validatePlanReviewChoice(pending.request, choice, input)
		)
			return false;
		this.#pending = undefined;
		persistPendingPlanReview(this.session, undefined);
		if (input?.role) pending.selectedIndex = pending.cycle.findIndex(entry => entry.role === input.role);
		const settling = { generation: pending.generation };
		this.#settling = settling;
		this.#emit({
			type: "plan_review_resolved",
			reviewId,
			sessionId: pending.request.sessionId,
			choice,
			by: "extension",
		});
		this.#background(
			this.#settle(pending, choice, input).finally(() => {
				if (this.#settling === settling) this.#settling = undefined;
			}),
		);
		return true;
	}
	async #settle(pending: PendingReview, choice: PlanReviewChoice, input?: PlanReviewInput): Promise<void> {
		this.#assertOwner(pending.generation);
		if (choice === "refine") {
			this.#settling = undefined;
			await this.#runPrompt(input!.feedback!, {});
			return;
		}
		const { planFilePath, title } = pending.request;
		const content = await readPlanFile(planFilePath, this.#fileOptions());
		this.#assertOwner(pending.generation);
		if (!content?.trim()) throw new Error(`Plan file not found at ${planFilePath}`);
		if (choice === "save") {
			await Bun.write(path.resolve(this.sessionManager.getCwd(), planSaveFileName(title)), content);
			this.#assertOwner(pending.generation);
			await this.exitPlanMode({ silent: true });
			await this.handleClearCommand();
			return;
		}
		const restored = this.planModePreviousModelState;
		const selected = pending.cycle[pending.selectedIndex];
		const executionModel =
			selected &&
			(!restored ||
				!modelsAreEqual(selected.model, restored.model) ||
				(selected.explicitThinkingLevel && selected.thinkingLevel !== restored.thinkingLevel))
				? selected
				: undefined;
		await approveNativePlan(this, content, {
			planFilePath,
			title,
			preserveContext: choice !== "execute",
			compactBeforeExecute: choice === "compact",
			executionModel,
			reviewOwner: pending,
		});
	}
	#emit(event: PlanReviewRequestedEvent | PlanReviewResolvedEvent): void {
		const runner = this.session.extensionRunner;
		if (runner) {
			const copy = structuredClone(event);
			this.#eventDelivery = this.#eventDelivery
				.then(async () => {
					await runner.emit(copy);
				})
				.catch(error => this.options.onError?.(error instanceof Error ? error : new Error(String(error))));
		}
		this.options.onEvent?.(structuredClone(event));
	}

	cancel(options?: { preservePending?: boolean }): void {
		this.#generation++;
		const pending = this.#pending;
		this.#pending = undefined;
		if (pending && !options?.preservePending && pending.request.sessionId === this.sessionManager.getSessionId())
			persistPendingPlanReview(this.session, undefined);
		if (pending)
			this.#emit({
				type: "plan_review_resolved",
				reviewId: pending.request.reviewId,
				sessionId: pending.request.sessionId,
				choice: undefined,
				by: "local",
			});
		this.options.onSettled?.();
	}
	dispose(): void {
		if (this.#disposed) return;
		this.cancel({ preservePending: true });
		this.#disposed = true;
		ownedSessions.delete(this.session);
		this.#unsubscribe();
		this.#unlisten();
		this.session.setPlanProposalHandler(null);
	}
	#fileOptions() {
		return {
			cwd: this.sessionManager.getCwd(),
			localProtocolOptions: {
				getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
				getSessionId: () => this.sessionManager.getSessionId(),
			},
		};
	}
	async getPlanFilePath(): Promise<string> {
		return this.session.getPlanReferencePath() || "local://PLAN.md";
	}
	resolvePlanFilePath(planPath: string): string {
		return resolvePlanFilePath(planPath, this.#fileOptions());
	}
	resolveLocalRoot(): string {
		return path.resolve(resolveLocalRoot(this.#fileOptions().localProtocolOptions));
	}
	showStatus(_message: string): void {}
	showWarning(message: string): void {
		this.options.onError?.(new Error(message));
	}
	updatePlanModeStatus(): void {}
	hidePlanReview(_owner?: object): void {}
	async applyPlanModeModel(): Promise<void> {
		const resolved = this.session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) return;
		this.planModePreviousModelState = this.session.model
			? { model: this.session.model, thinkingLevel: this.session.configuredThinkingLevel() }
			: undefined;
		await this.#applyPlanModel();
	}
	async #applyPlanModel(): Promise<void> {
		this.#modelChanges++;
		try {
			this.#assertOwner();
			const transition = resolvePlanModelTransition(
				this.session.model,
				this.session.resolveRoleModelWithThinking("plan"),
				this.session.isStreaming,
			);
			this.clearPendingPlanModelSwitch();
			if (transition.kind === "thinking") this.session.setThinkingLevel(transition.thinkingLevel);
			if (transition.kind === "apply") {
				if (transition.deferred) {
					this.#deferredModel = transition;
					this.#deferredIsPlan = true;
				} else {
					try {
						await this.session.setModelTemporary(transition.model, transition.thinkingLevel);
					} catch (error) {
						this.showWarning(
							`Failed to switch to plan model: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
			}
		} finally {
			this.#modelChanges--;
		}
	}
	async restorePlanPreviousModel(state: PlanModelState): Promise<void> {
		if (modelsAreEqual(this.session.model, state.model)) this.session.setThinkingLevel(state.thinkingLevel);
		else if (this.session.isStreaming) {
			this.#deferredModel = state;
			this.#deferredIsPlan = false;
		} else await this.session.setModelTemporary(state.model, state.thinkingLevel);
	}
	clearPendingPlanModelSwitch(): void {
		if (this.#deferredIsPlan) this.#deferredModel = undefined;
		this.#deferredIsPlan = false;
	}
	async #flushModel(): Promise<void> {
		this.#modelChanges++;
		try {
			const deferred = this.#deferredModel;
			this.#deferredModel = undefined;
			this.#deferredIsPlan = false;
			if (deferred) {
				this.#assertOwner();
				await this.session.setModelTemporary(deferred.model, deferred.thinkingLevel);
			}
		} finally {
			this.#modelChanges--;
		}
	}
	async exitPlanMode(options?: { silent?: boolean; paused?: boolean; deferModelRestore?: boolean }): Promise<void> {
		if (this.planModeEnabled) await tearDownNativePlanMode(this, options);
	}
	async applyPlanExecutionModel(entry: ResolvedRoleModel | undefined): Promise<void> {
		if (entry) {
			try {
				await this.session.applyRoleModel(entry);
			} catch (error) {
				this.showWarning(
					`Could not switch to the ${entry.role} model: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
	async applyDeferredPlanModelTransition(
		outcome: CompactionOutcome | undefined,
		executionModel: ResolvedRoleModel | undefined,
	): Promise<void> {
		const previous = this.planModePreviousModelState;
		if (!previous || outcome === "failed") return;
		this.planModePreviousModelState = undefined;
		if (executionModel) await this.applyPlanExecutionModel(executionModel);
		else await this.restorePlanPreviousModel(previous);
	}
	async handleClearCommand(): Promise<void> {
		this.assertActive();
		const generation = this.#generation;
		if (!(await this.session.newSession())) throw new Error("Session reset cancelled");
		if (generation !== this.#generation) throw new Error("Plan review cancelled during session reset");
		this.#sessionId = this.sessionManager.getSessionId();
		await this.sessionManager.ensureOnDisk();
		this.assertActive();
		const sessionFile = this.sessionManager.getSessionFile();
		if (sessionFile) this.options.onSessionChanged?.({ sessionId: this.#sessionId, sessionFile });
	}
	async handleCompactCommand(
		instructions?: string,
		_mode?: CompactMode,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		options?: Pick<CompactOptions, "internalGuidance" | "readerModel">,
	): Promise<CompactionOutcome> {
		let outcome: CompactionOutcome = "ok";
		if (this.sessionManager.getEntries().filter(entry => entry.type === "message").length < 2) return outcome;
		try {
			await this.session.compact(instructions, { ...options, suppressContinuation: true });
		} catch (error) {
			outcome = error instanceof CompactionCancelledError ? "cancelled" : "failed";
			this.showWarning(String(error));
		}
		this.#assertOwner();
		await beforeFlush?.(outcome);
		return outcome;
	}
	async dispatchPlanPrompt(text: string): Promise<void> {
		this.assertActive();
		this.#settling = undefined;
		await this.#runPrompt(text, { synthetic: true });
	}
	async #runPrompt(text: string, options: { synthetic?: boolean }): Promise<void> {
		if (this.options.runPrompt) {
			await this.options.runPrompt(text, options);
			return;
		}
		if (this.session.isStreaming) {
			await this.session.followUp(text, undefined, options);
			return;
		}
		try {
			await this.session.prompt(text, options);
		} catch (error) {
			if (!(error instanceof AgentBusyError)) throw error;
			await this.session.followUp(text, undefined, options);
		}
	}
}
