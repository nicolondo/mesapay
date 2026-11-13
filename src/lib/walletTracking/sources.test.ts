import {describe,expect,it,vi} from "vitest";
vi.mock("@/lib/db",()=>({db:{}}));
import {sourceReason,baseSourceKey,trackingSourcesQuery} from "./sources";
const row={source:"order" as const,sourceId:"p",occurredAt:new Date(),dateBasis:"payment" as const,amountCents:100,refundedCents:0,currency:"COP",trackingKey:"k",mode:"production",providerRef:"ref",uncertain:false};
describe("eligible local receipts",()=>{
 it("accepts confirmed matching currency and isolates its source key",()=>{expect(sourceReason(row,"COP")).toBeNull();expect(baseSourceKey("restaurant:r",row)).toBe("restaurant:r:order:p");});
 it.each([{amountCents:-1},{amountCents:0},{amountCents:1.5},{refundedCents:-1},{refundedCents:101},{refundedCents:0.1}])("rejects invalid money %j",change=>expect(sourceReason({...row,...change},"COP")).toBe("invalid_amount"));
 it.each([{providerRef:null},{providerRef:" "},{uncertain:true},{duplicateReference:true}])("requires an unambiguous confirmed collection %j",change=>expect(sourceReason({...row,...change},"COP")).toBe("source_not_confirmed"));
 it.each(["mock_p","MOCK:p","manual:actor:p"])("excludes simulated/manual provider proof %s",providerRef=>expect(sourceReason({...row,providerRef},"COP")).toBe("manual_or_mock"));
 it("does not derive currency from tenant defaults",()=>{expect(sourceReason({...row,currency:null},"COP")).toBe("currency_unknown");expect(sourceReason({...row,currency:"MXN"},"COP")).toBe("currency_mismatch");});
 it("parameterizes tenant scope rather than interpolating identifiers",()=>{const query=trackingSourcesQuery({kind:"merchant",restaurantId:"r' OR 1=1 --"});expect(query.text).not.toContain("r' OR");expect(query.values.filter(value=>value==="r' OR 1=1 --")).toHaveLength(3);expect(query.text).toContain("PARTITION BY");});
});
