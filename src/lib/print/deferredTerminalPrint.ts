import { printOnTerminal, type TerminalPrintClientResult } from "./terminalPrintClient";
import type { StaffPrintDoc } from "./staffPrint";

export type PrintPhase = "sending" | number | null;
type FinalResult = Exclude<TerminalPrintClientResult, { via: "post_approval" }>;

// One intent per mounted control. Only a refusal BEFORE dispatch is retryable.
// The server supplies both the selected device and the id to reuse for this job.
export class DeferredTerminalPrint {
  private intent: object | null = null;
  private resume: (() => void) | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private update: (phase: PrintPhase) => void, private send = printOnTerminal) {}

  get sending() { return this.intent !== null && this.resume === null; }

  cancel = () => {
    if (!this.intent) return;
    this.intent = null;
    this.resume?.();
    this.update(null);
  };

  cancelWaiting = () => { if (this.resume) this.cancel(); };

  refresh = () => { this.resume?.(); };

  async run(doc: StaffPrintDoc, deviceId?: string | null, printJobId?: string): Promise<FinalResult | null> {
    if (this.intent) return null;
    const intent = {};
    this.intent = intent;
    try {
      while (this.intent === intent) {
        this.update("sending");
        const result = await this.send(doc, { deviceId, printJobId });
        if (this.intent !== intent) return null;
        if (result.via !== "post_approval") return result;
        deviceId = result.deviceId;
        printJobId = result.printJobId;
        // A freshly approved charge can extend the hold. Avoid rapid requests
        // even when the server reports only milliseconds remaining.
        const deadline = Date.now() + Math.max(1000, result.retryAfterMs);
        await new Promise<void>(resolve => {
          const tick = () => {
            clearTimeout(this.timer);
            const left = deadline - Date.now();
            if (this.intent !== intent || left <= 0) {
              this.resume = null;
              resolve();
              return;
            }
            this.update(Math.ceil(left / 1000));
            this.timer = setTimeout(tick, Math.min(left, 1000));
          };
          this.resume = tick;
          tick();
        });
      }
      return null;
    } finally {
      if (this.intent === intent) {
        this.intent = null;
        this.update(null);
      }
    }
  }
}
