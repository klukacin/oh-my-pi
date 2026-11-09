import type { PlanReviewChoice, PlanReviewRequestedEvent } from "../extensibility/extensions/types";

export interface PlanReviewInput {
	feedback?: string;
	role?: string;
}

export function validatePlanReviewChoice(
	request: PlanReviewRequestedEvent,
	choice: PlanReviewChoice,
	input?: PlanReviewInput,
): boolean {
	const option = request.options.find(item => item.id === choice);
	if (!option || option.disabled) return false;
	if (choice === "refine" && !input?.feedback?.trim()) return false;
	if (input?.role !== undefined) {
		if (choice !== "execute" && choice !== "compact" && choice !== "keep") return false;
		if (!request.tiers?.some(tier => tier.role === input.role)) return false;
	}
	return true;
}
