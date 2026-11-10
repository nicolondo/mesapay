import { beforeEach, describe, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({resolve:vi.fn(),account:vi.fn(),entry:vi.fn(),operation:vi.fn(),create:vi.fn(),raw:vi.fn(),changes:vi.fn(),observe:vi.fn(),sync:vi.fn()}));
vi.mock("./context",()=>({resolveTrackingContext:m.resolve,scopeKey:(s:{kind:string;restaurantId?:string})=>s.kind==="platform"?"platform":`restaurant:${s.restaurantId}`}));
vi.mock("./history",()=>({historicalSourceChanges:m.changes,recordHistoricalObservations:m.observe}));
vi.mock("./store",()=>({trackingLock:vi.fn()}));
vi.mock("./service",()=>({syncWalletTracking:m.sync,getWalletTracking:m.sync}));
vi.mock("@/lib/db",()=>{const tx={walletTrackingEntry:{findUnique:m.entry,create:m.create},walletTrackingAccount:{findUniqueOrThrow:m.account,update:vi.fn()},auditEvent:{create:vi.fn()},$queryRaw:m.raw};return{db:{walletTrackingAccount:{findUnique:m.account},walletTrackingEntry:{findUnique:m.operation},$transaction:(fn:(tx:unknown)=>unknown)=>fn(tx)}};});
import { adjustWalletTracking,findWalletTrackingOperation,trackingAdjustmentSchema } from "./actions";
const scope={kind:"merchant" as const,restaurantId:"r"};
const account={id:"a",trackingKey:"current",scopeKey:"restaurant:r",restaurantId:"r",active:true,leaseUntil:null,currency:"COP",startedAt:new Date("2026-11-10T00:00:00Z")};
const input={trackingId:"a",idempotencyKey:"4378f0fe-976b-4db7-9cef-34b7062ba299",kind:"correction" as const,amountCents:100,reason:"Ajuste revisado"};
const token="a".repeat(64);
beforeEach(()=>{vi.resetAllMocks();m.resolve.mockResolvedValue({trackingKey:"current"});m.account.mockResolvedValue(account);m.entry.mockResolvedValue(null);m.changes.mockResolvedValue({count:1,token});m.sync.mockResolvedValue({status:"active"});});
describe("audited tracking adjustments",()=>{
  it("rejects a settings rotation after initial account lookup before recording money",async()=>{m.resolve.mockResolvedValueOnce({trackingKey:"current"}).mockResolvedValueOnce({trackingKey:"rotated"});await expect(adjustWalletTracking(scope,input,{email:"admin"})).rejects.toThrow("tracking_account_changed");expect(m.raw).toHaveBeenCalledTimes(2);expect(m.create).not.toHaveBeenCalled();});
  it("requires explicit current evidence to acknowledge old changes",async()=>{await expect(adjustWalletTracking(scope,{...input,acknowledgeHistoricalChanges:true,historicalChangeToken:"b".repeat(64)},{email:"admin"})).rejects.toThrow("tracking_history_changed");expect(m.observe).not.toHaveBeenCalled();expect(m.create).not.toHaveBeenCalled();});
  it("permits zero only for an explicit reviewed correction and replays it without acknowledging newer changes",async()=>{const value={...input,amountCents:0,acknowledgeHistoricalChanges:true,historicalChangeToken:token};expect(trackingAdjustmentSchema.safeParse({...value,acknowledgeHistoricalChanges:false}).success).toBe(false);await adjustWalletTracking(scope,value,{email:"admin"});expect(m.observe).toHaveBeenCalledTimes(1);const recorded=m.create.mock.calls[0][0].data;m.entry.mockResolvedValue(recorded);m.changes.mockResolvedValue({count:1,token:"b".repeat(64)});await adjustWalletTracking(scope,value,{email:"admin"});expect(m.observe).toHaveBeenCalledTimes(1);expect(m.create).toHaveBeenCalledTimes(1);});
  it("recovers an operation from a previous version only within the same authorized owner",async()=>{m.operation.mockResolvedValue({account:{scopeKey:"restaurant:r"}});expect(await findWalletTrackingOperation(scope,input.idempotencyKey)).toBe(true);m.operation.mockResolvedValue({account:{scopeKey:"restaurant:other"}});expect(await findWalletTrackingOperation(scope,input.idempotencyKey)).toBe(false);expect(m.resolve).not.toHaveBeenCalled();});
});
