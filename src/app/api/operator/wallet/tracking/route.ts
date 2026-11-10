import { createTrackingHandler } from "@/lib/walletTrackingApi";
export const GET = createTrackingHandler("merchant", "get");
export const POST = createTrackingHandler("merchant", "sync");
