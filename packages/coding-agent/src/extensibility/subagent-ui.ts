import type { ExtensionUIContext } from "./extensions/types";

export interface SubagentUIIdentity {
	agentId: string;
	parentAgentId?: string;
	sessionId: string;
}

/** Raw UI transport: compose the supplied lifetime signal with each dialog's handler signal. */
export type SubagentUIFactory = (identity: SubagentUIIdentity, signal: AbortSignal) => ExtensionUIContext;

/** One root session generation; closing it revokes existing and future child dialogs. */
export class SubagentUIBridge {
	#controller = new AbortController();
	constructor(readonly factory: SubagentUIFactory) {}
	get signal(): AbortSignal {
		return this.#controller.signal;
	}
	close(): void {
		this.#controller.abort();
	}
	createScope(identity: SubagentUIIdentity): SubagentUIScope {
		return new SubagentUIScope(this, identity);
	}
}

export class SubagentUIScope {
	#controller = new AbortController();
	#closed = false;
	readonly ui: ExtensionUIContext;
	constructor(bridge: SubagentUIBridge, identity: SubagentUIIdentity) {
		let controller = this.#controller;
		let context = bridge.factory(identity, AbortSignal.any([bridge.signal, controller.signal]));
		const current = () => {
			if (controller !== this.#controller) {
				controller = this.#controller;
				context = bridge.factory(identity, AbortSignal.any([bridge.signal, controller.signal]));
			}
			return context;
		};
		this.ui = new Proxy({} as ExtensionUIContext, {
			get: (_target, key) => {
				const value = Reflect.get(current(), key);
				return typeof value === "function"
					? (...args: unknown[]) => {
							const ui = current();
							return Reflect.apply(Reflect.get(ui, key), ui, args);
						}
					: value;
			},
		});
	}
	cancel(): void {
		this.#controller.abort();
		if (!this.#closed) this.#controller = new AbortController();
	}
	close(): void {
		this.#closed = true;
		this.cancel();
	}
}
