import type { Settings } from "../config/settings";
import type { SessionManager } from "../session/session-manager";
import { cfgPlanDefaultOnStartup, cfgPlanEnabled } from "./settings";

export function shouldEnterPlanModeOnStartup(
	sessionManager: Pick<SessionManager, "buildSessionContext" | "getEntries">,
	settings: Settings,
): boolean {
	return (
		sessionManager.buildSessionContext().messages.length === 0 &&
		!sessionManager.getEntries().some(entry => entry.type === "mode_change") &&
		cfgPlanDefaultOnStartup.get(settings) &&
		cfgPlanEnabled.get(settings)
	);
}
