import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function rejectionOf(request: Promise<unknown>): Promise<unknown> {
	return await request.then(
		() => new Error("expected the request to fail"),
		(error: unknown) => error,
	);
}

describe("RPC settings and model roles", () => {
	let client: RpcClient | undefined;
	let directory: string | undefined;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-settings-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "fork-rpc-agent.ts"), directory],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
		await client.start();
	});

	afterEach(async () => {
		const ownClient = client;
		const ownDirectory = directory;
		await ownClient?.stop();
		if (ownDirectory) await removeWithRetries(ownDirectory);
	});

	test("lists panel settings with values and writes them through their definition", async () => {
		const rpc = client!;
		const state = await rpc.getSettings();
		expect(state.tabs.map(tab => tab.id)).toContain("model");
		const storage = state.settings.find(setting => setting.path === "modelRoleStorage");
		expect(storage).toMatchObject({ tab: "model", kind: "submenu", value: "global", isSet: true });
		expect(storage?.options?.map(option => option.value)).toEqual(["global", "project"]);
		// The fixture session overrides this default, so the panel reports the stored value.
		expect(state.settings.find(setting => setting.path === "compaction.enabled")?.value).toBe(false);

		expect(await rpc.setSetting("modelRoleStorage", "project")).toMatchObject({ value: "project" });
		expect((await rpc.getModelRoles()).storage).toBe("project");
		expect(await rejectionOf(rpc.setSetting("modelRoleStorage", "elsewhere"))).toMatchObject({
			message: expect.stringContaining("modelRoleStorage expects one of global, project"),
		});
		expect(await rejectionOf(rpc.setSetting("no.such.setting", true))).toMatchObject({
			message: "Unknown setting: no.such.setting",
		});
		expect(await rpc.unsetSetting("modelRoleStorage")).toMatchObject({ value: "global" });
	}, 30_000);

	test("never returns a stored credential", async () => {
		const rpc = client!;
		const secret = (await rpc.getSettings()).settings.find(setting => setting.secret === true);
		expect(secret).toBeDefined();
		const written = await rpc.setSetting(secret!.path, "sk-test-credential");
		expect(written).toMatchObject({ secret: true, isSet: true });
		expect(written.value).toBeUndefined();
		expect(JSON.stringify(await rpc.getSettings())).not.toContain("sk-test-credential");
	}, 30_000);

	test("assigning the default role switches the running model; other roles only persist", async () => {
		const rpc = client!;
		const before = await rpc.getModelRoles();
		expect(before.active).toBe("anthropic/claude-sonnet-4-5");
		const task = before.roles.find(role => role.role === "task");
		const target = task?.models.find(model => model !== before.active);
		expect(target).toBeDefined();

		const afterTask = await rpc.setModelRole("task", target!);
		expect(afterTask.roles.find(role => role.role === "task")).toMatchObject({
			global: target,
			effective: target,
			resolved: target,
		});
		expect(afterTask.active).toBe(before.active);

		const afterDefault = await rpc.setModelRole("default", target!);
		expect(afterDefault.active).toBe(target);
		expect(afterDefault.roles.find(role => role.role === "default")?.global).toBe(target);

		expect(await rejectionOf(rpc.setModelRole("task", "nowhere/no-model"))).toMatchObject({
			message: "Model not available for the task role: nowhere/no-model",
		});
		expect(await rejectionOf(rpc.setModelRole("task", target!, "project"))).toMatchObject({
			message: expect.stringContaining("modelRoleStorage"),
		});
		const cleared = await rpc.setModelRole("task", null);
		expect(cleared.roles.find(role => role.role === "task")?.global).toBeUndefined();
	}, 30_000);
});
