import { useEffect, useState } from "react";

import { SelectColumnsEditor } from "../SelectColumnsEditor";

import type { StepEditorProps } from "./QueryStepEditor";

export function ColumnsStepEditor(props: Pick<StepEditorProps, "step" | "index" | "commit" | "columns" | "project" | "loadUpstreamColumns">) {
  const { project, index: selectedStepIndex, step: selectedStep, columns, commit: replaceStepAt } = props;
  const [selectedColumns, setSelectedColumns] = useState<string[]>(selectedStep.type === "SelectColumns" ? selectedStep.payload.columns : []);
  const [upstream, setUpstream] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void props.loadUpstreamColumns().then(names => { if (!cancelled) setUpstream(names); }).catch(() => { });
    return () => { cancelled = true; };
  }, [project.workspace, project.connections, project.sources, project.root_path]);
  const columnChoices = upstream.length ? upstream : columns;
  return (<>
    {selectedStep.type === "SelectColumns" &&
      selectedStepIndex !== null && (
        <SelectColumnsEditor
          initialColumns={selectedColumns}
          choices={columnChoices}
          onApply={(columns) => {
            setSelectedColumns(columns);
            replaceStepAt(selectedStepIndex, {
              type: "SelectColumns",
              payload: { columns },
            });
          }}
        />
      )}
  </>);
}
