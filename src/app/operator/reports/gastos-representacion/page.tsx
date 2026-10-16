import ServiceAdjustmentsReport from "../ServiceAdjustmentsReport";
import type { ServiceReportSearch } from "@/lib/reports/serviceAdjustments";

export const dynamic = "force-dynamic";

export default function RepresentationPage({ searchParams }: { searchParams: Promise<ServiceReportSearch> }) {
  return <ServiceAdjustmentsReport report="representation" searchParams={searchParams} />;
}
