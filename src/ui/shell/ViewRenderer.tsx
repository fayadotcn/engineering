"use client";
import { BarChart3 } from "lucide-react";
import type { WorkspaceView } from "@shared/types";
import { EmptyState } from "../primitives";
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
    // 服务端推来前端还不认识的新成果类型时给一句交代，别留一块空白
    default: return <EmptyState icon={<BarChart3 size={22} />} title="这类成果暂不能展示" hint="让助手按当前口径重新生成一份，或刷新页面后重试。" />;
  }
}
