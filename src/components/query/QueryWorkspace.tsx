import type { ComponentProps, ReactNode, RefObject } from "react";
import { GraphCanvas } from "../GraphCanvas";
import { PanelResizeHandle } from "../PanelResizeHandle";
import { QueryResultDock, type QueryResultDockProps } from "./QueryResultDock";
import { QueryInspector, type QueryInspectorProps } from "./QueryInspector";

interface QueryWorkspaceProps {
  active: boolean;
  /** Shell owns tool descriptors and mounted Mapping/Matching sessions. */
  shellTools: ReactNode;
  pipeline: ComponentProps<typeof GraphCanvas>;
  /** Narrow geometry port: shell menu's Focus Lens uses the same dimensions. */
  dock: {
    stackRef: RefObject<HTMLDivElement | null>;
    height: number;
    splitter: ComponentProps<typeof PanelResizeHandle>;
    result: QueryResultDockProps;
  };
  inspector: {
    available: boolean;
    hidden: boolean;
    resize: ReactNode;
    props: QueryInspectorProps;
  };
}

/** Query composition only. No duplicate project, execution or tool-session store. */
export function QueryWorkspace({ active, shellTools, pipeline, dock, inspector }: QueryWorkspaceProps) {
  return <>
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      {shellTools}
      {/* Keep Query/Lens mounted across tool navigation, as with Mapping/Matching. */}
      <div ref={dock.stackRef}
        className={active ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "hidden"}
        aria-hidden={!active}>
        <div className="min-h-0 flex-1 overflow-hidden px-3 pb-1 pt-2">
          <GraphCanvas {...pipeline} />
        </div>
        <PanelResizeHandle {...dock.splitter} />
        <div className="flex shrink-0 flex-col overflow-hidden border-t border-[var(--line)] bg-[#060d14]"
          style={{ height: dock.height }}>
          <QueryResultDock {...dock.result} />
        </div>
      </div>
    </section>
    <div className={inspector.available ? "contents" : "hidden"}>
      {inspector.resize}
      {/* Collapsing a side bar is presentation, not a draft/session reset. */}
      <div className={inspector.hidden ? "hidden" : "contents"}>
        <QueryInspector {...inspector.props} />
      </div>
    </div>
  </>;
}
