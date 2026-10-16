import ServiceAdjustmentsReport from "../ServiceAdjustmentsReport";
import type { ServiceReportSearch } from "@/lib/reports/serviceAdjustments";

export const dynamic = "force-dynamic";

export default function NoCobradosPage({ searchParams }: { searchParams: Promise<ServiceReportSearch> }) {
  return <ServiceAdjustmentsReport report="uncollected" searchParams={searchParams} />;
}
