import { CLI_THINKING_LEVELS } from "@oh-my-pi/pi-tui/thinking";
import type { AgentSession } from "../session/agent-session";
import type { PlanModelState, PlanToolPresentation } from "./controller-operations";

const RESTORE_ENTRY = "plan-mode-restore";

export function persistPlanRestoreState(
	session: AgentSession,
	tools: PlanToolPresentation | undefined,
	model: PlanModelState | undefined,
): void {
	session.sessionManager.appendCustomEntry(RESTORE_ENTRY, {
		tools,
		model: model
			? { provider: model.model.provider, id: model.model.id, thinkingLevel: model.thinkingLevel }
			: undefined,
	});
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

/** Resolve model identity against today's catalog rather than trusting serialized credentials or endpoints. */
export function readPlanRestoreState(session: AgentSession): { tools?: PlanToolPresentation; model?: PlanModelState } {
	const entry = session.sessionManager
		.getBranch()
		.findLast(entry => entry.type === "custom" && entry.customType === RESTORE_ENTRY);
	if (!entry || entry.type !== "custom") return {};
	const data = record(entry.data);
	const tools = record(data?.tools);
	const enabled = strings(tools?.enabled),
		mounted = strings(tools?.mounted),
		registered = strings(tools?.registered);
	const savedModel = record(data?.model);
	const model =
		typeof savedModel?.provider === "string" && typeof savedModel.id === "string"
			? session.modelRegistry.find(savedModel.provider, savedModel.id)
			: undefined;
	const thinkingLevel = CLI_THINKING_LEVELS.find(level => level === savedModel?.thinkingLevel);
	return {
		...(enabled && mounted && registered ? { tools: { enabled, mounted, registered } } : {}),
		...(model ? { model: { model, thinkingLevel } } : {}),
	};
}

const PENDING_REVIEW_ENTRY = "plan-review-pending";

export function persistPendingPlanReview(
	session: AgentSession,
	review: { planFilePath: string; title: string } | undefined,
): void {
	session.sessionManager.appendCustomEntry(PENDING_REVIEW_ENTRY, review ?? null);
}

export function readPendingPlanReview(session: AgentSession): { planFilePath: string; title: string } | undefined {
	const entry = session.sessionManager
		.getBranch()
		.findLast(entry => entry.type === "custom" && entry.customType === PENDING_REVIEW_ENTRY);
	if (!entry || entry.type !== "custom") return undefined;
	const data = record(entry.data);
	return typeof data?.planFilePath === "string" && typeof data.title === "string"
		? { planFilePath: data.planFilePath, title: data.title }
		: undefined;
}
