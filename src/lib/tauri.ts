import { invoke } from "@tauri-apps/api/core";
import type { PreviewResult, TransformationStep } from "../types/pipeline";

export function previewPipeline(
  steps: TransformationStep[],
): Promise<PreviewResult> {
  return invoke<PreviewResult>("preview_pipeline", { steps });
}
