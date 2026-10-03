"use client";
import type { WorkspaceView } from "@shared/types";
import { useStore } from "../store";
import { AnomalyTable, BoqTable, Breakdown, CostCompositionView, DiffView, DocumentView, ExportResult, FeeSummaryView, FileCompareView, FileList, MeasureFeeView, QuotaResult, QuotationMatch, ReceiptsView, SpecResultView } from "../views";
import { ColumnMappingView } from "../views/ColumnMappingView";
import { PriceLibraryView } from "../views/PriceLibraryView";
import { PricingSettings } from "../PricingSettings";
import { CostOverview } from "../CostOverview";

export function ViewRenderer({ view, onUpload }: { view: WorkspaceView; onUpload: () => void }) {
  const focusVersion = useStore((s) => s.boqFocusVersion);
  switch (view.kind) {
    case "boqTable": return <BoqTable key={`${view.id}:${focusVersion}`} view={view} />;
    case "overview": return <CostOverview onUpload={onUpload} />;
    case "receipts": return <ReceiptsView />;
    case "anomalyTable": return <AnomalyTable view={view} />;
    case "quotationMatch": return <QuotationMatch view={view} />;
    case "breakdown": return <Breakdown view={view} />;
    case "quotaResult": return <QuotaResult view={view} />;
    case "feeSummary": return <FeeSummaryView view={view} />;
    case "measureFee": return <MeasureFeeView view={view} />;
    case "costComposition": return <CostCompositionView view={view} />;
    case "fileCompare": return <FileCompareView view={view} />;
    case "document": return <DocumentView view={view} />;
    case "specResult": return <SpecResultView view={view} />;
    case "diff": return <DiffView view={view} />;
    case "factList": return <PricingSettings />;
    case "exportResult": return <ExportResult view={view} />;
    case "fileList": return <FileList />;
    case "priceLibrary": return <PriceLibraryView />;
    case "columnMapping": return <ColumnMappingView view={view} />;
  }
}
