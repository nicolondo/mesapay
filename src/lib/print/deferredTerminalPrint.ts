import { POST_APPROVAL_PRINT_SECONDS } from "@/lib/payments/terminalBusy";
import { printOnTerminal, type TerminalPrintClientResult } from "./terminalPrintClient";
import type { StaffPrintDoc } from "./staffPrint";

export type PrintPhase = "sending" | number | null;
type FinalResult = Exclude<TerminalPrintClientResult, { via: "post_approval" | "printing" }>;
type Dispatch = { kind: StaffPrintDoc["kind"]; documentId: string; deviceId?: string | null; printJobId?: string };

const MAX_WAIT_MS = POST_APPROVAL_PRINT_SECONDS * 1000 + 30_000;
const PRINTING_RECHECK_MS = 5000;

// One intent per mounted control. Only a refusal BEFORE dispatch is retryable.
// The server supplies both the selected device and the id to reuse for this job.
export class DeferredTerminalPrint {
  private intent: { request?: Dispatch } | null = null;
  private resume: (() => void) | null = null;
  constructor(private update: (phase: PrintPhase) => void, private send = printOnTerminal) {}

  get sending() { return this.intent !== null && this.resume === null; }

  cancel = () => {
    if (!this.intent) return;
    if (this.intent.request) console.warn("[terminal] print_cancelled_during_send", this.intent.request);
    this.intent = null;
    this.resume?.();
    this.update(null);
  };

  cancelWaiting = () => { if (this.resume) this.cancel(); };

  refresh = () => { this.resume?.(); };

  private waitUntil(deadline: number) {
    return new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      const tick = () => {
        clearTimeout(timer);
        const left = deadline - Date.now();
        if (!this.intent || left <= 0) {
          this.resume = null;
          resolve();
          return;
        }
        this.update(Math.ceil(left / 1000));
        timer = setTimeout(tick, Math.min(left, 1000));
      };
      this.resume = tick;
      tick();
    });
  }

  async run(doc: StaffPrintDoc, deviceId?: string | null, printJobId?: string): Promise<FinalResult | null> {
    if (this.intent) return null;
    const intent: { request?: Dispatch } = {};
    this.intent = intent;
    const stopAt = Date.now() + MAX_WAIT_MS;
    const documentId = doc.kind === "shift" ? doc.shiftId : doc.orderId;
    let deferred = false;
    try {
      while (this.intent === intent) {
        this.update("sending");
        intent.request = { kind: doc.kind, documentId, deviceId, printJobId };
        const result = await this.send(doc, { deviceId, printJobId });
        delete intent.request;
        if (this.intent !== intent) return null;

        let delay: number;
        let code: string;
        if (result.via === "post_approval") {
          deferred = true;
          deviceId = result.deviceId;
          printJobId = result.printJobId;
          delay = Math.max(1000, result.retryAfterMs);
          code = "terminal_post_approval";
        } else if (result.via === "printing") {
          code = "terminal_printing";
          if (!deferred) return { via: "error", code };
          delay = PRINTING_RECHECK_MS;
        } else {
          return result;
        }
        const retryAt = Date.now() + delay;
        if (retryAt >= stopAt) return { via: "error", code };
        await this.waitUntil(retryAt);
        if (this.intent !== intent) return null;
        if (Date.now() >= stopAt) return { via: "error", code };
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
