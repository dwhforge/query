import { useCallback, useEffect, useRef, useState } from "react";
import { JoinKeyEditor } from "../JoinKeyEditor";

import { emptyJoinKeyPair, pairsFromOn, pairsToOn, joinPairsComplete, type JoinKeyPair } from "../../lib/joinKeys";
import { parseTargetKey } from "../../lib/projectRefs";
import { findJoinHostsForMap } from "../../app/mappingChecks";
import { targetKey, externalTarget, type JoinType, type ColumnMetadata, type ObjectTarget } from "../../types/pipeline";

import type { JoinDraftReader, StepEditorProps } from "./QueryStepEditor";

export function JoinStepEditor(props: Pick<StepEditorProps, "step" | "index" | "commit" | "project" | "queryId" | "refCatalogs" | "openCheck" | "loadJoinColumns" | "joinDraftReader" | "diagnostics" | "schemaEnabled">) {
  const { project, queryId: activeQueryId, index: selectedStepIndex, step: selectedStep, refCatalogs, commit: replaceStepAt, openCheck: openMappingCheckSetup } = props;
  const queries = project.workspace.queries;
  const otherQueries = queries.filter(q => q.id !== activeQueryId);
  function objectTargetFromPicker(value: string): ObjectTarget { return parseTargetKey(value) ?? value; }
  const [joinRightId, setJoinRightId] = useState(selectedStep.type === "Join" ? targetKey(selectedStep.payload.right_query_id) : "");
  const [joinKeyPairs, setJoinKeyPairs] = useState<JoinKeyPair[]>(selectedStep.type === "Join" ? pairsFromOn(selectedStep.payload.left_on, selectedStep.payload.right_on) : [emptyJoinKeyPair()]);
  const joinKeyDraftRef = useRef<JoinKeyPair[]>(joinKeyPairs);
  const [joinType, setJoinType] = useState<JoinType>(selectedStep.type === "Join" ? selectedStep.payload.join_type : "inner");
  const [joinLeftColumns, setJoinLeftColumns] = useState<ColumnMetadata[]>([]);
  const [joinRightColumns, setJoinRightColumns] = useState<ColumnMetadata[]>([]);
  const [joinColsLoading, setJoinColsLoading] = useState(false);
  const current = useRef(props); current.current = props;
  useEffect(() => {
    if (selectedStep.type !== "Join" || !props.schemaEnabled || !joinRightId) {
      setJoinColsLoading(false);
      return;
    }
    let cancelled = false;
    setJoinColsLoading(true);
    setJoinLeftColumns([]); setJoinRightColumns([]);
    const timer = setTimeout(() => {
      void current.current.loadJoinColumns(activeQueryId, joinRightId, selectedStepIndex)
        .then(cols => { if (!cancelled) { setJoinLeftColumns(cols.left); setJoinRightColumns(cols.right); } })
        .catch(() => { })
        .finally(() => { if (!cancelled) setJoinColsLoading(false); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activeQueryId, selectedStepIndex, selectedStep.type, joinRightId, project.workspace, project.connections, project.sources, project.root_path, props.schemaEnabled]);
  useEffect(() => {
    const reader: JoinDraftReader = { read: () => selectedStep.type === "Join" ? { queryId: activeQueryId, pairs: joinKeyDraftRef.current, type: joinType } : null };
    props.joinDraftReader.current = reader;
    return () => { if (props.joinDraftReader.current === reader) props.joinDraftReader.current = null; };
  }, [props.joinDraftReader, activeQueryId, selectedStep.type, joinType]);
  const setJoinKeyPairsBoth = useCallback((pairs: JoinKeyPair[]) => {
    joinKeyDraftRef.current = pairs;
    setJoinKeyPairs(pairs);
  }, []);
  return (<>
    {selectedStep.type === "Join" && (
      <>
        <p className="text-[10px] text-slate-500">
          Join another query into this one (canvas drag or
          edit here).
        </p>
        <label className="block text-[10px] uppercase tracking-wide text-slate-500">
          Right query
        </label>
        <select
          value={joinRightId}
          onChange={(e) => setJoinRightId(e.target.value)}
          disabled={
            otherQueries.length === 0 &&
            Object.values(refCatalogs).every(
              (c) => c.queries.length === 0,
            )
          }
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-teal-700"
        >
          <option value="">right query…</option>
          <optgroup label="This project">
            {otherQueries.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </optgroup>
          {Object.entries(refCatalogs).map(([rid, cat]) =>
            cat.queries.length > 0 ? (
              <optgroup key={rid} label={`Ref · ${cat.alias}`}>
                {cat.queries.map((q) => (
                  <option
                    value={targetKey(
                      externalTarget(rid, "query", q.id),
                    )}
                  >
                    {cat.alias}.{q.name}
                  </option>
                ))}
              </optgroup>
            ) : null,
          )}
        </select>
        {otherQueries.length === 0 &&
          Object.values(refCatalogs).every(
            (c) => c.queries.length === 0,
          ) && (
            <p className="text-[11px] text-amber-500/90">
              Need another query (local or referenced) to join.
            </p>
          )}
        <label className="block text-[10px] uppercase tracking-wide text-slate-500">
          Type
        </label>
        <select
          value={joinType}
          onChange={(e) =>
            setJoinType(e.target.value as JoinType)
          }
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100"
        >
          <option value="inner">inner</option>
          <option value="left">left</option>
          <option value="right">right</option>
          <option value="full">full</option>
        </select>
        <JoinKeyEditor
          initialPairs={joinKeyPairs}
          onDraftChange={(p) => {
            joinKeyDraftRef.current = p;
          }}
          leftColumns={joinLeftColumns}
          rightColumns={joinRightColumns}
          leftLoading={joinColsLoading}
          rightLoading={joinColsLoading}
        />
        <button
          type="button"
          disabled={!joinRightId}
          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25 disabled:opacity-40"
          onClick={() => {
            if (selectedStepIndex === null) return;
            const draft = joinKeyDraftRef.current;
            if (!joinPairsComplete(draft)) return;
            const { left_on, right_on } = pairsToOn(draft);
            setJoinKeyPairsBoth(draft);
            replaceStepAt(selectedStepIndex, {
              type: "Join",
              payload: {
                right_query_id:
                  objectTargetFromPicker(joinRightId),
                join_type: joinType,
                left_on,
                right_on,
              },
            });
          }}
        >
          Apply
        </button>
        {activeQueryId &&
          selectedStepIndex != null &&
          (() => {
            const hosts = (
              project.workspace.key_maps ?? []
            ).flatMap((m) =>
              findJoinHostsForMap(queries, m.id)
                .filter(
                  (h) =>
                    h.host.id === activeQueryId &&
                    h.joinStepIndex === selectedStepIndex,
                )
                .map((h) => ({ map: m, host: h })),
            );
            const hit = hosts[0];
            if (!hit) return null;
            return (
              <button
                type="button"
                className="w-full rounded-lg border border-teal-800/40 bg-teal-950/40 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/15"
                onClick={() =>
                  void openMappingCheckSetup({
                    mode: "create",
                    mapId: hit.map.id,
                    hostQueryId: activeQueryId,
                    joinStepIndex: selectedStepIndex,
                  })
                }
              >
                Mapping check… ({hit.map.name})
              </button>
            );
          })()}
        {props.diagnostics}
      </>
    )}
  </>);
}
