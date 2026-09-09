import { connection } from "next/server";

/** Time sampled for this request, after opting out of prerendering. */
export async function requestTime() {
  await connection();
  return Date.now();
}
