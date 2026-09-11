import { secureApi } from "@/lib/secureApi";
import { countMutation } from "../../mutation";

export const dynamic = "force-dynamic";
export const POST = secureApi(countMutation("review"));
