const SILENT_VAD = { speechStarted: false, speechEnded: false, maxDuration: false };
class FakeRuntimeSession {
    push(_frame) {
        return SILENT_VAD;
    }
    decode() {
        return Promise.resolve({
            text: "",
            language: "und",
            languageProbability: 0,
            startMs: 0,
            endMs: 0,
        });
    }
    close() {
        return Promise.resolve();
    }
}
export class FakeRuntime {
    loadCount = 0;
    openCount = 0;
    modelName = "tiny";
    backend = "cpu";
    readyGate;
    loaded = false;
    async ready() {
        if (this.readyGate)
            await this.readyGate;
        if (this.loaded)
            return;
        this.loaded = true;
        this.loadCount += 1;
    }
    open(_request) {
        this.openCount += 1;
        return Promise.resolve(new FakeRuntimeSession());
    }
}
