import {beforeEach,describe,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({merchant:vi.fn(),platform:vi.fn()}));
vi.mock("@/lib/db",()=>({db:{payout:{findMany:m.merchant},platformPayout:{findMany:m.platform}}}));
import {trackingOutgoing} from "./outgoing";
const start=new Date("2026-11-10T12:00:00Z");
const account={scopeKind:"merchant",restaurantId:"r",startedAt:start,walletAccountFingerprint:"ours",mode:"production" as const,currency:"COP",platformWalletAccountId:null};
const row={amountCents:1000,currency:"COP",status:"approved",walletAccountFingerprint:"ours",providerVerifiedAt:start,createdAt:start,sourceMode:"production"};
beforeEach(()=>vi.resetAllMocks());
describe("known wallet outflows",()=>{
 it("deducts only verified same-wallet approved transfers",async()=>{m.merchant.mockResolvedValue([row,{...row,status:"failed"},{...row,status:"declined"},{...row,walletAccountFingerprint:"another"},{...row,sourceMode:"sandbox"},{...row,currency:"MXN"},{...row,createdAt:new Date(start.getTime()-1)}]);expect(await trackingOutgoing(account)).toMatchObject({amountCents:BigInt(1000),ambiguous:0});expect(m.merchant.mock.calls[0][0].where.restaurantId).toBe("r");});
 it("stops for pending and unverifiable operations, even before activation",async()=>{m.merchant.mockResolvedValue([row,...["submitting","initialized","unknown"].map(status=>({...row,status,createdAt:new Date(start.getTime()-1)})),{...row,providerVerifiedAt:null},{...row,status:"failed",walletAccountFingerprint:null}]);expect(await trackingOutgoing(account)).toMatchObject({amountCents:BigInt(1000),ambiguous:5});});
 it("excludes old platform versions by immutable account when fingerprint is absent",async()=>{m.platform.mockResolvedValue([{...row,accountId:"p",account:{mode:"production"}},{...row,accountId:"other",account:{mode:"production"},walletAccountFingerprint:null,status:"unknown"}]);expect(await trackingOutgoing({...account,scopeKind:"platform",restaurantId:null,platformWalletAccountId:"p"})).toMatchObject({amountCents:BigInt(1000),ambiguous:0});});
});
