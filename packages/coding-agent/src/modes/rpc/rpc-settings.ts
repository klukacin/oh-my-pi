/**
 * Settings and model-role commands for RPC mode. Both read and write the same
 * schema and stores as the interactive `/settings` and `/model` panels, so a
 * host renders them generically instead of mirroring individual settings.
 */
import {
	getSettingDef,
	getSettingsForTab,
	numericOption,
	SETTING_TABS,
	type SettingDef,
	type SettingsHost,
	TAB_GROUPS,
	TAB_METADATA,
} from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { resolveModelRoleValue } from "../../config/model-resolver";
import { getKnownRoleIds, getRoleInfo, isKindRole, roleCandidatePool } from "../../config/model-roles";
import { cfgModelRoleStorage } from "../../config/model-settings";
import { createSettingsHost } from "../../config/settings-ui";
import type { AgentSession } from "../../session/agent-session";
import type {
	RpcModelRole,
	RpcModelRoleScope,
	RpcModelRolesState,
	RpcSettingEntry,
	RpcSettingsState,
} from "./rpc-types";

const settingsHosts = new WeakMap<AgentSession["settings"], SettingsHost>();

function host(session: AgentSession): SettingsHost {
	let settingsHost = settingsHosts.get(session.settings);
	if (!settingsHost) {
		settingsHost = createSettingsHost(session.settings);
		settingsHosts.set(session.settings, settingsHost);
	}
	return settingsHost;
}

function settingEntry(def: SettingDef, settings: SettingsHost): RpcSettingEntry {
	const secret = def.type === "text" && def.secret;
	const value = settings.get(def.path);
	const entry: RpcSettingEntry = {
		path: def.path,
		tab: def.tab,
		kind: def.type,
		valueType: def.schemaType,
		label: def.label,
		description: def.description,
		visible: def.condition ? def.condition() : true,
		isSet: value !== undefined && value !== null && value !== "",
	};
	if (def.group) entry.group = def.group;
	if (def.warning) entry.warning = def.warning;
	if (secret) entry.secret = true;
	// A credential is never echoed: the host only learns whether one is stored.
	else if (value !== undefined) entry.value = value;
	if (def.defaultValue !== undefined && !secret) entry.defaultValue = def.defaultValue;
	if (def.type === "enum") entry.options = def.values.map(option => ({ value: option, label: option }));
	if (def.type === "submenu" || def.type === "multiselect") {
		entry.options = def.options.map(option =>
			option.description
				? { value: option.value, label: option.label, description: option.description }
				: { value: option.value, label: option.label },
		);
	}
	if (def.type === "multiselect" && def.ordered) entry.ordered = true;
	return entry;
}

/** Every setting the interactive panel shows, in its tab and section order, with current values. */
export function rpcSettingsState(session: AgentSession): RpcSettingsState {
	const settings = host(session);
	return {
		tabs: SETTING_TABS.map(tab => ({ id: tab, label: TAB_METADATA[tab].label, groups: [...TAB_GROUPS[tab]] })),
		settings: SETTING_TABS.flatMap(tab =>
			getSettingsForTab(settings.entries, tab).map(def => settingEntry(def, settings)),
		),
	};
}

function coerceSettingValue(def: SettingDef, value: unknown, settings: SettingsHost): unknown {
	const invalid = (expected: string): never => {
		throw new Error(`${def.path} expects ${expected}`);
	};
	switch (def.type) {
		case "boolean":
			return typeof value === "boolean" ? value : invalid("a boolean");
		case "enum":
			return typeof value === "string" && def.values.includes(value)
				? value
				: invalid(`one of ${def.values.join(", ")}`);
		case "submenu": {
			if (def.schemaType === "number") {
				const numeric = typeof value === "number" ? value : numericOption(String(value));
				return numeric !== undefined && Number.isFinite(numeric) ? numeric : invalid("a number");
			}
			if (typeof value !== "string") return invalid("a string");
			// Runtime-populated choices (themes) reach the host as an empty list; accept any string for them.
			if (def.options.length > 0 && !def.options.some(option => option.value === value)) {
				return invalid(`one of ${def.options.map(option => option.value).join(", ")}`);
			}
			return value;
		}
		case "multiselect": {
			if (!Array.isArray(value)) return invalid("an array");
			const allowed = new Set(def.options.map(option => option.value));
			return value.every(item => typeof item === "string" && allowed.has(item))
				? value
				: invalid(`values from ${[...allowed].join(", ")}`);
		}
		case "providerLimits":
			return settings.validateProviderLimits(value);
		case "text":
			if (def.schemaType === "array") return Array.isArray(value) ? value : invalid("an array");
			if (def.schemaType === "record") {
				return value !== null && typeof value === "object" && !Array.isArray(value) ? value : invalid("an object");
			}
			return typeof value === "string" ? value : invalid("a string");
	}
}

/**
 * Write one setting to the global config, validated against its panel definition.
 * Writes are flushed before the response: a host may stop a short-lived process right after it.
 */
export async function rpcSetSetting(session: AgentSession, path: string, value: unknown): Promise<RpcSettingEntry> {
	const settings = host(session);
	const def = getSettingDef(settings.entries, path);
	if (!def) throw new Error(`Unknown setting: ${path}`);
	settings.set(path, coerceSettingValue(def, value, settings));
	await session.settings.flush();
	return settingEntry(def, settings);
}

/** Remove one setting from the global config so another layer or its default applies. */
export async function rpcUnsetSetting(session: AgentSession, path: string): Promise<RpcSettingEntry> {
	const settings = host(session);
	const def = getSettingDef(settings.entries, path);
	if (!def) throw new Error(`Unknown setting: ${path}`);
	settings.unset(path);
	await session.settings.flush();
	return settingEntry(def, settings);
}

function modelRole(session: AgentSession, role: string): RpcModelRole {
	const settings = session.settings;
	const info = getRoleInfo(role, settings);
	const entry: RpcModelRole = {
		role,
		name: info.name,
		section: isKindRole(role) ? "kind" : "chat",
		provenance: settings.getModelRoleProvenance(role),
		models: roleCandidatePool(role, settings, session.modelRegistry).map(model => `${model.provider}/${model.id}`),
	};
	if (info.tag) entry.tag = info.tag;
	const globalValue = settings.getGlobalModelRole(role);
	if (globalValue) entry.global = globalValue;
	const projectValue = settings.getProjectModelRole(role);
	if (projectValue) entry.project = projectValue;
	const effective = settings.getModelRole(role);
	if (effective) {
		entry.effective = effective;
		const resolved = resolveModelRoleValue(effective, session.getAvailableModels(), { settings }).model;
		if (resolved) entry.resolved = `${resolved.provider}/${resolved.id}`;
	}
	return entry;
}

/** Role assignments per settings layer, with the models each role accepts. */
export function rpcModelRolesState(session: AgentSession): RpcModelRolesState {
	const state: RpcModelRolesState = {
		storage: cfgModelRoleStorage.get(session.settings),
		roles: getKnownRoleIds(session.settings).map(role => modelRole(session, role)),
	};
	const active = session.model;
	if (active) state.active = `${active.provider}/${active.id}`;
	return state;
}

/**
 * Follow the effective default role after an edit: a write a higher layer still
 * shadows leaves the running model alone, exactly as the interactive hub does.
 */
async function applyEffectiveDefault(session: AgentSession): Promise<void> {
	const settings = session.settings;
	const resolved = resolveModelRoleValue(settings.getModelRole("default"), session.getAvailableModels(), {
		settings,
	});
	const target = resolved.model;
	const live = session.model;
	if (!target || (live && live.provider === target.provider && live.id === target.id)) return;
	const { switched } = await session.setModel(target, "default", { persist: false });
	if (switched && resolved.explicitThinkingLevel) session.setThinkingLevel(resolved.thinkingLevel);
}

/** Assign (`model`) or clear (`null`) a role in the global or project settings layer. */
export async function rpcSetModelRole(
	session: AgentSession,
	role: string,
	model: string | null,
	scope: RpcModelRoleScope | undefined,
): Promise<RpcModelRolesState> {
	const settings = session.settings;
	const storage = cfgModelRoleStorage.get(settings);
	if (scope === "project" && storage !== "project") {
		throw new Error("Project model roles need the modelRoleStorage setting set to project");
	}
	const target = storage === "project" ? (scope ?? "project") : "global";
	if (model === null) {
		if (target === "project") settings.clearProjectModelRole(role);
		else settings.setModelRole(role, undefined);
	} else {
		const selector = model.trim();
		const candidates = roleCandidatePool(role, settings, session.modelRegistry);
		if (!resolveModelRoleValue(selector, candidates, { settings }).model) {
			throw new Error(`Model not available for the ${role} role: ${selector}`);
		}
		if (target === "project") settings.setProjectModelRole(role, selector);
		else settings.setModelRole(role, selector);
	}
	if (role === "default") await applyEffectiveDefault(session);
	await settings.flush();
	return rpcModelRolesState(session);
}
