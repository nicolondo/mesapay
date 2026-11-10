import { createTrackingHandler } from "@/lib/walletTrackingApi";
export const GET = createTrackingHandler("merchant", "history");
export const POST = createTrackingHandler("merchant", "incorporate");
