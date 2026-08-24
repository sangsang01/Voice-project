import type { SessionRequest } from "@voice/transcription-contracts";
import type { StreamingRuntime, StreamingRuntimeSession } from "./runtime.js";
export declare class FakeRuntime implements StreamingRuntime {
    loadCount: number;
    openCount: number;
    readonly modelName = "tiny";
    readonly backend: "cpu";
    readyGate: Promise<void> | undefined;
    private loaded;
    ready(): Promise<void>;
    open(_request: SessionRequest): Promise<StreamingRuntimeSession>;
}
