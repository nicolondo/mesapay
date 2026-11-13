import { createTrackingHandler } from "@/lib/walletTrackingApi";
export const GET = createTrackingHandler("platform", "history");
export const POST = createTrackingHandler("platform", "incorporate");
