import { useEffect, useState } from "react";
import {
  emptyS3Params,
  newConnectionId,
  type ConnectionDef,
  type ConnectionKind,
  type S3Params,
} from "../types/pipeline";

const inputClass =
  "w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-teal-700";

interface Props {
  open: boolean;
  initial?: ConnectionDef | null;
  defaultKind?: ConnectionKind;
  /** Existing connection ids — for stable slug uniqueness. */
  existingIds?: string[];
  onClose: () => void;
  onSave: (conn: ConnectionDef) => void;
}

export function ConnectionEditor({
  open,
  initial,
  defaultKind = "postgres",
  existingIds = [],
  onClose,
  onSave,
}: Props) {
  const [kind, setKind] = useState<ConnectionKind>(defaultKind);
  const [name, setName] = useState("");
  const [pgDsn, setPgDsn] = useState(
    "postgresql://user:pass@localhost:5432/db",
  );
  const [s3, setS3] = useState<S3Params>(emptyS3Params());

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setKind(initial.kind);
      setName(initial.name);
      setPgDsn(initial.postgres?.connection_string ?? "");
      setS3(initial.s3 ? { ...emptyS3Params(), ...initial.s3 } : emptyS3Params());
    } else {
      setKind(defaultKind);
      setName(defaultKind === "s3" ? "s3" : "postgres");
      setPgDsn("postgresql://user:pass@localhost:5432/db");
      setS3(emptyS3Params());
    }
  }, [open, initial, defaultKind]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function save() {
    const trimmed = name.trim() || (kind === "s3" ? "s3" : "postgres");
    const id = initial?.id ?? newConnectionId(trimmed, existingIds);
    if (kind === "postgres") {
      const dsn = pgDsn.trim();
      if (!dsn) return;
      onSave({
        id,
        name: trimmed,
        kind: "postgres",
        postgres: { connection_string: dsn },
      });
    } else {
      onSave({ id, name: trimmed, kind: "s3", s3: { ...s3 } });
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[min(780px,92vh)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[#0a121c] shadow-2xl">
        <div className="border-b border-[var(--line)] px-5 py-4">
          <h2 className="text-sm font-semibold text-teal-300">
            {initial ? "Edit connection" : "New connection"}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Credentials live on Connections. Sources and Queries only reference
            an id (ADR-0012).
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-5 py-4">
          <div className="flex gap-2">
            {(["postgres", "s3"] as ConnectionKind[]).map((k) => (
              <button
                key={k}
                type="button"
                disabled={!!initial}
                onClick={() => setKind(k)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wide disabled:opacity-50 ${
                  kind === k
                    ? "bg-teal-500/20 text-teal-200"
                    : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {k}
              </button>
            ))}
          </div>

          <Labeled label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </Labeled>

          {kind === "postgres" ? (
            <Labeled label="Connection string">
              <input
                value={pgDsn}
                onChange={(e) => setPgDsn(e.target.value)}
                spellCheck={false}
                className={`${inputClass} font-mono text-xs`}
              />
            </Labeled>
          ) : (
            <>
              <Labeled label="Auth provider">
                <select
                  value={s3.provider}
                  onChange={(e) =>
                    setS3((p) => ({ ...p, provider: e.target.value }))
                  }
                  className={inputClass}
                >
                  <option value="config">config (access key + secret)</option>
                  <option value="credential_chain">
                    credential_chain (env / profile / IMDS)
                  </option>
                </select>
              </Labeled>
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="Region">
                  <input
                    value={s3.region ?? ""}
                    onChange={(e) =>
                      setS3((p) => ({ ...p, region: e.target.value }))
                    }
                    className={`${inputClass} font-mono text-xs`}
                    placeholder="us-east-1"
                  />
                </Labeled>
                <Labeled label="URL style">
                  <select
                    value={s3.url_style ?? "path"}
                    onChange={(e) =>
                      setS3((p) => ({ ...p, url_style: e.target.value }))
                    }
                    className={inputClass}
                  >
                    <option value="path">path</option>
                    <option value="vhost">vhost</option>
                  </select>
                </Labeled>
              </div>
              <Labeled label="Endpoint (MinIO / custom)">
                <input
                  value={s3.endpoint ?? ""}
                  onChange={(e) =>
                    setS3((p) => ({ ...p, endpoint: e.target.value }))
                  }
                  className={`${inputClass} font-mono text-xs`}
                  placeholder="localhost:9000"
                />
              </Labeled>
              {s3.provider === "config" && (
                <>
                  <Labeled label="Access key id">
                    <input
                      value={s3.access_key_id ?? ""}
                      onChange={(e) =>
                        setS3((p) => ({ ...p, access_key_id: e.target.value }))
                      }
                      className={`${inputClass} font-mono text-xs`}
                      autoComplete="off"
                    />
                  </Labeled>
                  <Labeled label="Secret access key">
                    <input
                      type="password"
                      value={s3.secret_access_key ?? ""}
                      onChange={(e) =>
                        setS3((p) => ({
                          ...p,
                          secret_access_key: e.target.value,
                        }))
                      }
                      className={`${inputClass} font-mono text-xs`}
                      autoComplete="new-password"
                    />
                  </Labeled>
                  <Labeled label="Session token (optional)">
                    <input
                      value={s3.session_token ?? ""}
                      onChange={(e) =>
                        setS3((p) => ({ ...p, session_token: e.target.value }))
                      }
                      className={`${inputClass} font-mono text-xs`}
                    />
                  </Labeled>
                </>
              )}
              <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={s3.use_ssl}
                    onChange={(e) =>
                      setS3((p) => ({ ...p, use_ssl: e.target.checked }))
                    }
                  />
                  USE_SSL
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={s3.verify_ssl}
                    onChange={(e) =>
                      setS3((p) => ({ ...p, verify_ssl: e.target.checked }))
                    }
                  />
                  VERIFY_SSL (off = self-signed / lab)
                </label>
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded-lg bg-teal-500 px-3 py-1.5 text-xs font-semibold text-slate-950"
          >
            Save connection
          </button>
        </div>
      </div>
    </div>
  );
}

function Labeled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {label}
      </label>
      {children}
    </div>
  );
}
