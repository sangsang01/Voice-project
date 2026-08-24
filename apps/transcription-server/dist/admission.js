export class AdmissionPool {
    capacity;
    active = 0;
    constructor(capacity) {
        this.capacity = capacity;
    }
    reserve() {
        if (this.active >= this.capacity)
            return undefined;
        this.active += 1;
        let released = false;
        return () => {
            if (!released) {
                released = true;
                this.active -= 1;
            }
        };
    }
}
