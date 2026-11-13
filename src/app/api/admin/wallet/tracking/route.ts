import { createTrackingHandler } from "@/lib/walletTrackingApi";
export const GET = createTrackingHandler("platform", "get");
export const POST = createTrackingHandler("platform", "sync");
