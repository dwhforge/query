import type { RefObject, ReactNode } from "react";
import type { JoinKeyPair } from "../../lib/joinKeys";
import type { Project, TransformationStep, JoinType, ColumnMetadata, KeyMapDef } from "../../types/pipeline";
import { TextStepEditor } from "./TextStepEditor";
import { ColumnsStepEditor } from "./ColumnsStepEditor";
import { DeriveStepEditor } from "./DeriveStepEditor";
import { JoinStepEditor } from "./JoinStepEditor";
import { RelationStepEditor } from "./RelationStepEditor";
import { MappingStepEditor } from "./MappingStepEditor";
import { LoadStepEditor } from "./LoadStepEditor";
export type ReferenceCatalogs = Record<string, { alias: string; queries: { id: string; name: string }[]; maps: { id: string; name: string }[] }>;
export type JoinDraftReader = { read(): { queryId: string; pairs: JoinKeyPair[]; type: JoinType } | null };
export interface StepEditorProps {
  schemaEnabled: boolean;
  diagnostics?: ReactNode;
  project: Project;
  queryId: string;
  index: number;
  step: TransformationStep;
  columns: string[];
  refCatalogs: ReferenceCatalogs;
  commit(index: number, step: TransformationStep): void;
  changeLoadFile(): Promise<void>;
  openMap(map: KeyMapDef, options?: { suggestedFrom: string[] }): void;
  openCheck(options: { mode: "create"; mapId: string; hostQueryId: string; joinStepIndex: number }): Promise<void>;
  loadJoinColumns(host: string, right: string, index: number | null): Promise<{ left: ColumnMetadata[]; right: ColumnMetadata[] }>;
  loadUpstreamColumns(): Promise<string[]>;
  joinDraftReader: RefObject<JoinDraftReader | null>;
}

/** Dispatch only: each concrete editor owns its own drafts and request lifetime. */
export function QueryStepEditor(props: StepEditorProps) {
  const base = { step: props.step, index: props.index, commit: props.commit };
  switch (props.step.type) {
    case "SqlModel":
    case "Filter":
    case "GroupBy":
    case "SortBy":
    case "Limit":
    case "RenameColumn":
    case "CustomSql":
      return <TextStepEditor {...base} />;
    case "SelectColumns":
      return <ColumnsStepEditor {...base} columns={props.columns} project={props.project} loadUpstreamColumns={props.loadUpstreamColumns} />;
    case "DeriveColumn":
      return <DeriveStepEditor {...base} project={props.project} columns={props.columns} />;
    case "Join":
      return <JoinStepEditor {...base} project={props.project} queryId={props.queryId} refCatalogs={props.refCatalogs} openCheck={props.openCheck} schemaEnabled={props.schemaEnabled} loadJoinColumns={props.loadJoinColumns} joinDraftReader={props.joinDraftReader} diagnostics={props.diagnostics} />;
    case "FromQuery":
    case "Append":
      return <RelationStepEditor {...base} project={props.project} queryId={props.queryId} refCatalogs={props.refCatalogs} />;
    case "NormalizeKey":
    case "ApplyKeyMap":
      return <MappingStepEditor {...base} project={props.project} refCatalogs={props.refCatalogs} openMap={props.openMap} />;
    case "LoadCsv":
    case "LoadPostgres":
    case "LoadParquet":
      return <LoadStepEditor {...base} project={props.project} changeLoadFile={props.changeLoadFile} />;
    default: return null;
  }
}
