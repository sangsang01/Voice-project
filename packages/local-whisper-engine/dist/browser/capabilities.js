function defaultEnvironment() {
    const browserNavigator = typeof navigator === "undefined" ? undefined : navigator;
    return {
        gpu: browserNavigator?.gpu,
        wasm: typeof WebAssembly === "undefined" ? undefined : WebAssembly,
        storage: browserNavigator?.storage,
    };
}
export async function inspectLocalCapabilities(environment = defaultEnvironment()) {
    const estimate = await environment.storage?.estimate();
    const quota = estimate?.quota;
    const usage = estimate?.usage;
    return {
        device: environment.gpu ? "webgpu" : environment.wasm ? "wasm" : "unavailable",
        storage: {
            quota,
            usage,
            available: typeof quota === "number" && typeof usage === "number"
                ? Math.max(0, quota - usage)
                : undefined,
        },
    };
}
