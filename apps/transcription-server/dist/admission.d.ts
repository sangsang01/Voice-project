export declare class AdmissionPool {
    private readonly capacity;
    private active;
    constructor(capacity: number);
    reserve(): (() => void) | undefined;
}
