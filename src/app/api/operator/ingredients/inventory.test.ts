import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ context: vi.fn(), find: vi.fn(), create: vi.fn(), update: vi.fn(), level: vi.fn(), lock: vi.fn(), movementCount: vi.fn(), movementCreate: vi.fn(), levelUpdate: vi.fn() }));
vi.mock('@/lib/secureApi', () => ({ secureApi: (handler: unknown) => handler }));
vi.mock('@/lib/erp/access', () => ({ getErpContext: m.context, isDenied: (ctx: {error?: string}) => !!ctx.error }));
vi.mock('@/lib/orderLock', () => ({ lockStock: m.lock }));
vi.mock('@/lib/db', () => { const tx = { ingredient: { findUnique: m.find, create: m.create, update: m.update }, stockLevel: { findUnique: m.level, update: m.levelUpdate }, stockMovement: { count: m.movementCount, create: m.movementCreate } }; return { db: { ...tx, $transaction: (fn: (db: unknown) => unknown) => fn(tx) } }; });
import { POST } from './route';
import { PATCH } from './[id]/route';
const req = (body: unknown) => new Request('http://localhost/api/operator/ingredients', { method: 'POST', body: JSON.stringify(body) });
const params = { params: Promise.resolve({ id: 'ing' }) };
beforeEach(() => { vi.resetAllMocks(); m.context.mockResolvedValue({ restaurantId: 'r', userId: 'u' }); m.movementCount.mockResolvedValue(2); m.find.mockResolvedValue({ id: 'ing', restaurantId: 'r', trackInventory: true, measureKind: 'mass', updatedAt: new Date('2026-09-30T11:00:00.000Z'), _count: { supplierItems: 0 } }); m.create.mockResolvedValue({ id: 'new' }); m.update.mockResolvedValue({ id: 'ing' }); m.level.mockResolvedValue(null); });
it('creates an explicitly untracked ingredient', async () => { m.find.mockResolvedValue(null); expect((await POST(req({ name:'Agua',measureKind:'volume',trackInventory:false }))).status).toBe(201); expect(m.create).toHaveBeenCalledWith({data: expect.objectContaining({trackInventory:false,restaurantId:'r'})}); });
it('defaults new ingredients to tracked', async () => { m.find.mockResolvedValue(null); await POST(req({name:'Arroz',measureKind:'mass'})); expect(m.create).toHaveBeenCalledWith({data:expect.objectContaining({trackInventory:true})}); });
it.each([{qtyBase:1,totalValueCents:0},{qtyBase:-1,totalValueCents:0},{qtyBase:0,totalValueCents:20}])('preserves balances when disabling %j', async (level) => { m.level.mockResolvedValue({...level, restaurantId:'r',updatedAt:new Date('2026-09-30T12:00:00.000Z')}); const r=await PATCH(req({trackInventory:false}),params); expect(r.status).toBe(409); expect(await r.json()).toMatchObject({error:'inventory_balance_remaining',stockReset:{...level,ingredientUpdatedAt:'2026-09-30T11:00:00.000Z'}}); expect(m.update).not.toHaveBeenCalled(); expect(m.lock).toHaveBeenCalled(); });
it('disables zero balance and clears reorder settings',async()=>{ m.level.mockResolvedValue({qtyBase:0,totalValueCents:0,restaurantId:'r',updatedAt:new Date('2026-09-30T12:00:00.000Z')}); expect((await PATCH(req({trackInventory:false,reorderPointBase:10}),params)).status).toBe(200); expect(m.update).toHaveBeenCalledWith(expect.objectContaining({where:{id:'ing',restaurantId:'r'},data:expect.objectContaining({trackInventory:false,reorderPointBase:null,reorderQtyBase:null})})); });
it('allows enabling inventory',async()=>{expect((await PATCH(req({trackInventory:true}),params)).status).toBe(200);expect(m.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({trackInventory:true})}));});
it('rejects foreign ingredients without mutation',async()=>{m.find.mockResolvedValue({restaurantId:'other'});expect((await PATCH(req({trackInventory:false}),params)).status).toBe(404);expect(m.update).not.toHaveBeenCalled();});
it('requires a boolean',async()=>{expect((await PATCH(req({trackInventory:'false'}),params)).status).toBe(400);expect(m.update).not.toHaveBeenCalled();});

const resetStock = { qtyBase: 2500, totalValueCents: 120000, updatedAt: "2026-09-30T12:00:00.000Z", ingredientUpdatedAt: "2026-09-30T11:00:00.000Z", movementCount: 2, measureKind: "mass" };
it("confirms the reviewed balance and records its actor", async () => {
 m.level.mockResolvedValue({ ...resetStock, updatedAt: new Date(resetStock.updatedAt), restaurantId: "r" });
 expect((await PATCH(req({ trackInventory: false, resetStock }), params)).status).toBe(200);
 expect(m.movementCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ qtyBase: -2500, valueCents: -120000, createdById: "u", note: "inventory_tracking_disabled" }) });
});
it.each([{ resetStock }, { trackInventory: true, resetStock }, { trackInventory: false, resetStock: true }, { trackInventory: false, resetStock: { ...resetStock, qtyBase: "2500" } }, { trackInventory: false, resetStock: { ...resetStock, movementCount: -1 } }, { trackInventory: false, resetStock: { ...resetStock, updatedAt: "bad" } }])("rejects invalid confirmation shape %j", async (body) => {
 expect((await PATCH(req(body), params)).status).toBe(400);
 expect(m.movementCreate).not.toHaveBeenCalled();
 expect(m.update).not.toHaveBeenCalled();
});
it("returns fresh balances on stale confirmation without writes", async () => {
 m.level.mockResolvedValue({ qtyBase: 3500, totalValueCents: 160000, updatedAt: new Date(resetStock.updatedAt), restaurantId: "r" });
 const response = await PATCH(req({ trackInventory: false, resetStock }), params);
 expect(response.status).toBe(409);
 expect(await response.json()).toMatchObject({ error: "stock_reset_conflict", stockReset: { qtyBase: 3500, totalValueCents: 160000 } });
 expect(m.update).not.toHaveBeenCalled(); expect(m.movementCreate).not.toHaveBeenCalled();
});
it("requires the ERP authorization before loading or mutating an ingredient", async () => {
 m.context.mockResolvedValue({ error: "module_disabled", status: 403 });
 expect((await PATCH(req({ trackInventory: false, resetStock }), params)).status).toBe(403);
 expect(m.find).not.toHaveBeenCalled(); expect(m.movementCreate).not.toHaveBeenCalled();
});

it("does not reinterpret existing movements by changing dimension while disabling", async () => {
 const response = await PATCH(req({ trackInventory: false, measureKind: "volume" }), params);
 expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "measure_locked" });
 expect(m.update).not.toHaveBeenCalled(); expect(m.movementCreate).not.toHaveBeenCalled();
});
it("locks dimension even for a zero balance when a reset confirmation is supplied", async () => {
 m.movementCount.mockResolvedValue(0);
 const response = await PATCH(req({ trackInventory: false, resetStock, measureKind: "volume" }), params);
 expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "measure_locked" });
 expect(m.update).not.toHaveBeenCalled();
});
