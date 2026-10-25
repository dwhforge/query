import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionDef,
  PreviewResult,
  TransformationStep,
  Workspace,
} from "../types/pipeline";

export type DbtTarget = "v1" | "v2";

export function previewWorkspace(
  workspace: Workspace,
  connections: ConnectionDef[] = [],
): Promise<PreviewResult> {
  return invoke<PreviewResult>("preview_workspace", { workspace, connections });
}

export function previewPipeline(
  steps: TransformationStep[],
  connections: ConnectionDef[] = [],
): Promise<PreviewResult> {
  return invoke<PreviewResult>("preview_pipeline", { steps, connections });
}

export function exportDbt(
  pipelineName: string,
  workspace: Workspace,
  outputDir: string,
  dbtTarget: DbtTarget = "v1",
): Promise<string> {
  return invoke<string>("export_dbt", {
    pipelineName,
    workspace,
    outputDir,
    dbtTarget,
  });
}

export function loadSampleWorkspace(): Promise<Workspace> {
  return invoke<Workspace>("load_sample_workspace");
}

export interface PostgresObject {
  schema: string;
  name: string;
  kind: string;
}

export function listPostgresObjects(
  connectionString: string,
): Promise<PostgresObject[]> {
  return invoke<PostgresObject[]>("list_postgres_objects", {
    connectionString,
  });
}

export function testPostgresConnection(
  connectionString: string,
): Promise<void> {
  return invoke<void>("test_postgres_connection", { connectionString });
}
