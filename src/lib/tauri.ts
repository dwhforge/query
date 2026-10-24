import { invoke } from "@tauri-apps/api/core";
import type { PreviewResult, TransformationStep, Workspace } from "../types/pipeline";

export function previewWorkspace(workspace: Workspace): Promise<PreviewResult> {
  return invoke<PreviewResult>("preview_workspace", { workspace });
}

export function previewPipeline(
  steps: TransformationStep[],
): Promise<PreviewResult> {
  return invoke<PreviewResult>("preview_pipeline", { steps });
}

export function exportDbt(
  pipelineName: string,
  workspace: Workspace,
  outputDir: string,
): Promise<string> {
  return invoke<string>("export_dbt", {
    pipelineName,
    workspace,
    outputDir,
  });
}
