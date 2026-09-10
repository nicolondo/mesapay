import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrintJobPayload } from "@/lib/escpos";

const h = vi.hoisted(() => {
  type Item = { id: string; nameSnapshot: string; qty: number; station: string; barSubStation: string | null; kitchenStatus: string; cancelledAt: Date | null; servedAt: Date | null; orderId: string; roundId: string; menuItemId: string; modifierSelections: null; notes: null; guestName: string };
  const state = {
    items: [] as Item[],
    roundStatus: "placed",
    orderStatus: "placed",
    owner: "merchant",
    jobs: [] as Array<{ dedupeKey: string; payload: unknown }>,
  };
  const order = () => ({ id: "order", restaurantId: state.owner, status: state.orderStatus, shortCode: "FIXTURE", tableId: null, table: { number: 1 }, restaurant: { name: "Fixture", printPaperWidthMm: 80 }, orderType: "dineIn", servingMode: "together", notes: null, pickupName: null });
  const item = (id: string) => ({ ...state.items.find(i => i.id === id)!, order: order() });
  const db = {
    $queryRaw: vi.fn(async () => []),
    orderItem: {
      findUnique: vi.fn(async ({where}: {where:{id:string}}) => item(where.id)),
      findUniqueOrThrow: vi.fn(async ({where}: {where:{id:string}}) => item(where.id)),
      update: vi.fn(async ({where,data}: {where:{id:string};data:object}) => Object.assign(state.items.find(i => i.id === where.id)!, data)),
      findMany: vi.fn(async () => state.items.filter(i => !i.cancelledAt)),
      count: vi.fn(async () => state.items.filter(i => !i.cancelledAt).length),
    },
    round: {
      findUnique: vi.fn(async (args: {include?:{items:{where:{station:string;cancelledAt?:null;barSubStation?:string}}}}) => {
        const where = args.include?.items.where;
        return { id: "round", status: state.roundStatus, seq: 4, placedAt: new Date("2026-09-10T16:59:21Z"), order: order(), items: state.items.filter(i => !where || (i.station === where.station && (where.cancelledAt !== null || !i.cancelledAt) && (!where.barSubStation || i.barSubStation === where.barSubStation))) };
      }),
      update: vi.fn(async ({data}: {data:{status:string}}) => { state.roundStatus=data.status; }),
    },
    restaurant: { findUnique: vi.fn(async () => ({ kitchenPrintEnabled: true, barPrintEnabled: true })) },
    printer: { findMany: vi.fn(async ({where}: {where:{station:string}}) => [{ id: "printer", kind: "comanda", station: where.station, barSubStation: null, paperWidthMm: 80 }]) },
    printJob: { createMany: vi.fn(async ({data}: {data:typeof state.jobs}) => {
      let count=0;
      for(const row of data) if(!state.jobs.some(j=>j.dedupeKey===row.dedupeKey)){state.jobs.push(row);count++;}
      return {count};
    }) },
  };
  return {state, db, event:vi.fn()};
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({db:{...h.db,$transaction:async(fn:(tx:typeof h.db)=>unknown)=>fn(h.db)}}));
vi.mock("@/lib/events", () => ({publishOrderEvent:h.event}));
vi.mock("@/lib/secureApi", () => ({secureApi:(fn:unknown)=>fn}));
vi.mock("@/auth", () => ({auth:async()=>({user:{role:"kitchen",email:"fixture@example.test"}})}));
vi.mock("@/lib/activeRestaurant", () => ({getActiveRestaurantId:async()=>"merchant"}));
vi.mock("@/lib/orders", () => ({requireMutableOrderInTx:vi.fn(),recomputeOrderLinesInTx:vi.fn()}));
vi.mock("@/lib/auditLog", () => ({recordAuditEvent:vi.fn()}));
vi.mock("@/lib/push", () => ({sendPushToMeserosForTable:vi.fn()}));
vi.mock("next-intl/server", () => ({getLocale:async()=>"es",getTranslations:async()=> (key:string)=>key}));
import { PATCH } from "@/app/api/operator/order-items/[id]/route";
import { loadRoundTicket } from "./ticketData";
import { notifyAcceptedRoundTicketSafe } from "./enqueue";
import { renderPrintJobPayload } from "@/lib/escpos";
const args = {restaurantId:"merchant",orderId:"order",roundId:"round",station:"kitchen" as const,barSubStation:null};
const patch = (id:string, body:object) => PATCH(new Request("https://fixture.test",{method:"PATCH",body:JSON.stringify(body)}),{params:Promise.resolve({id})});
const ticket = () => (h.state.jobs[0].payload as PrintJobPayload).ticket;
beforeEach(()=>{
  vi.clearAllMocks();
  h.state.owner="merchant";h.state.roundStatus="placed";h.state.orderStatus="placed";h.state.jobs=[];
  h.state.items=["Carpaccio de Res 1.0","Chorizo Antioqueño","Patacones"].map((nameSnapshot,n)=>({id:String(n),nameSnapshot,qty:n===1?2:1,station:"kitchen",barSubStation:null,kitchenStatus:"placed",cancelledAt:null,servedAt:null,orderId:"order",roundId:"round",menuItemId:"menu",modifierSelections:null,notes:null,guestName:"Mesero"}));
});
describe("accepted kitchen tickets",()=>{
  it("reproduces accepting two dishes then rejecting patacones through the real API",async()=>{
    expect((await patch("0",{kitchenStatus:"in_kitchen"})).status).toBe(200);
    expect((await patch("1",{kitchenStatus:"in_kitchen"})).status).toBe(200);
    expect(h.state.jobs).toHaveLength(0);
    expect(h.event.mock.calls.filter(c=>c[1].type==="ticket.printable")).toHaveLength(0);
    expect((await patch("2",{cancel:{reason:"Agotado",kind:"cancel"}})).status).toBe(200);
    expect(h.state.jobs).toHaveLength(1);
    expect(ticket().items.map(i=>[i.qty,i.name])).toEqual([[1,"Carpaccio de Res 1.0"],[2,"Chorizo Antioqueño"]]);
    const bytes=renderPrintJobPayload(h.state.jobs[0].payload)!;
    expect(bytes.includes(Buffer.from("Patacones"))).toBe(false);
    expect(bytes.includes(Buffer.from("Carpaccio"))).toBe(true);
    const browser=await loadRoundTicket(args);
    expect(browser.ok && browser.ticket.items.map(i=>i.name)).toEqual(ticket().items.map(i=>i.name));
    expect(h.event.mock.calls.filter(c=>c[1].type==="ticket.printable")).toHaveLength(1);
    await patch("2",{cancel:{reason:"Agotado",kind:"cancel"}});
    expect(h.state.jobs).toHaveLength(1);
    expect(h.event.mock.calls.filter(c=>c[1].type==="ticket.printable")).toHaveLength(1);
  });
  it("also excludes a dish rejected before the others are accepted",async()=>{
    await patch("2",{cancel:{reason:"Agotado"}});
    await patch("0",{kitchenStatus:"in_kitchen"});
    expect(h.state.jobs).toHaveLength(0);
    await patch("1",{kitchenStatus:"in_kitchen"});
    expect(ticket().items.map(i=>i.name)).not.toContain("Patacones");
  });
  it("prints a fully accepted round once across repeated notifications",async()=>{
    for(const id of ["0","1","2"])await patch(id,{kitchenStatus:"in_kitchen"});
    await notifyAcceptedRoundTicketSafe(args);
    expect(h.state.jobs).toHaveLength(1);
    expect(ticket().items).toHaveLength(3);
  });
  it("does not print when every dish is rejected",async()=>{
    for(const id of ["0","1","2"])await patch(id,{cancel:{reason:"Agotado"}});
    expect(h.state.jobs).toHaveLength(0);
    expect((await loadRoundTicket(args)).ok).toBe(false);
  });
  it("does not wait for a different preparation station",async()=>{
    h.state.items[2].station="bar";
    await patch("0",{kitchenStatus:"in_kitchen"});await patch("1",{kitchenStatus:"in_kitchen"});
    expect(ticket().items).toHaveLength(2);
  });
  it("isolates bar sub-stations",async()=>{
    h.state.items.forEach((i,n)=>{i.station="bar";i.barSubStation=n===2?"coffee":"drinks";i.kitchenStatus=n===2?"placed":"in_kitchen";});
    const loaded=await loadRoundTicket({...args,station:"bar",barSubStation:"drinks"});
    expect(loaded.ok && loaded.ticket.items.length).toBe(2);
  });
  it.each(["order","round"])("never prints a cancelled %s",async(target)=>{
    h.state.items.forEach(i=>i.kitchenStatus="in_kitchen");
    if(target==="order")h.state.orderStatus="cancelled";else h.state.roundStatus="cancelled";
    await notifyAcceptedRoundTicketSafe(args);expect(h.state.jobs).toHaveLength(0);
  });
  it("rejects a round from another merchant",async()=>{
    h.state.owner="other";h.state.items.forEach(i=>i.kitchenStatus="in_kitchen");
    expect(await loadRoundTicket(args)).toEqual({ok:false,reason:"not_found"});
  });
});
