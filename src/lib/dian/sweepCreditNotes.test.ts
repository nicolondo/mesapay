import {beforeEach,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({find:vi.fn(),emit:vi.fn()}));
vi.mock("@/lib/db",()=>({db:{dianDocument:{findMany:m.find}}}));
vi.mock("./emitCreditNote",()=>({emitDianCreditNote:m.emit}));
import {sweepCreditNotes} from "./sweepCreditNotes";
beforeEach(()=>{vi.resetAllMocks();m.find.mockResolvedValue([{creditNoteId:"n1",restaurantId:"r1"},{creditNoteId:"n2",restaurantId:"r2"}]);m.emit.mockResolvedValue({outcome:"pending"});});
it("recovers each note in its own restaurant without invoice emission",async()=>{expect(await sweepCreditNotes()).toMatchObject({scanned:2,pending:2});expect(m.emit.mock.calls.map(c=>c[0])).toEqual([{creditNoteId:"n1",restaurantId:"r1"},{creditNoteId:"n2",restaurantId:"r2"}]);const where=m.find.mock.calls[0][0].where;expect(where.kind).toBe("credit_note");expect(where.creditNote).toEqual({is:{abandonedAt:null}});expect(JSON.stringify(where)).not.toContain("rejected");});
it("continues after an individual failure",async()=>{m.emit.mockRejectedValueOnce(new Error("offline"));expect(await sweepCreditNotes()).toMatchObject({scanned:2,error:1,pending:1});});
it("respects a depleted time budget without contacting DIAN",async()=>{expect(await sweepCreditNotes({budgetMs:0})).toMatchObject({scanned:0,truncated:true});expect(m.emit).not.toHaveBeenCalled();});
it("keeps reconciling exhausted uncertain sends without retransmitting",async()=>{m.find.mockResolvedValue([{creditNoteId:"n1",restaurantId:"r1",attempts:8}]);await sweepCreditNotes();expect(m.emit).toHaveBeenCalledWith({creditNoteId:"n1",restaurantId:"r1",mode:"status"});});
it('excludes numbering conflicts and notes not received by DIAN even when nextAttemptAt is null, while including ordinary null errors', async () => {
 await sweepCreditNotes();
 expect(m.find.mock.calls[0][0].where.AND).toContainEqual({ OR: [{ lastError: null }, { lastError: { notIn: ['dian_numbering_conflict', 'dian_not_received'] } }] });
});
// Evaluador mínimo de filtros Prisma (AND/OR, igualdad, in/notIn/lt/lte/not).
// Igual que SQL, `notIn` no incluye NULL: por eso el filtro lo agrega aparte.
type Where = Record<string, unknown>;
function matches(where: Where, row: Record<string, unknown>): boolean {
 return Object.entries(where).every(([key, condition]) => {
   if (key === 'AND') return (condition as Where[]).every(clause => matches(clause, row));
   if (key === 'OR') return (condition as Where[]).some(clause => matches(clause, row));
   if (!(key in row)) return true; // relaciones (creditNote) fuera del alcance de este test
   const value = row[key];
   if (condition === null || typeof condition !== 'object' || condition instanceof Date) return value === condition;
   const c = condition as { in?: unknown[]; notIn?: unknown[]; lt?: number; lte?: Date; not?: unknown };
   if ('not' in c) return value !== c.not;
   if (c.in) return c.in.includes(value);
   if (c.notIn) return value !== null && !c.notIn.includes(value);
   if (c.lt !== undefined) return (value as number) < c.lt;
   if (c.lte) return value !== null && (value as Date) <= c.lte;
   return false;
 });
}
it('el barrido deja de consultar las notas «No recibida por la DIAN»', async () => {
 await sweepCreditNotes({ now: new Date('2026-10-31T15:00:00Z') });
 const where = m.find.mock.calls[0][0].where;
 const nc1 = { kind: 'credit_note', state: 'error', attempts: 8, xmlZip: Buffer.from('signed'), nextAttemptAt: null, leaseExpiresAt: null };
 expect(matches(where, { ...nc1, lastError: 'dian_not_received' })).toBe(false);
 expect(matches(where, { ...nc1, lastError: 'dian_numbering_conflict' })).toBe(false);
 // Un envío incierto se sigue consultando.
 expect(matches(where, { ...nc1, lastError: 'transport_error' })).toBe(true);
 expect(matches(where, { ...nc1, state: 'pending', lastError: null })).toBe(true);
});
