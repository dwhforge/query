import { useEffect, useMemo, useState } from "react";
import {
  FALLBACK_LAB_CATALOG,
  REQUIRES_LABELS,
  TRACK_LABELS,
  TRACK_ORDER,
  type HelpLabCard,
  type HelpLabTrack,
} from "../help/labCatalog";
import { listHelpLabs } from "../lib/bridge";
import type { DemoId } from "./EmptyHero";

interface HelpLabProps {
  onOpenLab: (id: DemoId | string) => void;
}

function RequiresBadge({ requires }: { requires: string }) {
  const label = REQUIRES_LABELS[requires] ?? requires;
  const tone =
    requires === "postgres"
      ? "border-amber-800/70 text-amber-200/90"
      : requires === "local_cache"
        ? "border-sky-800/70 text-sky-200/90"
        : "border-slate-700 text-slate-400";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}
    >
      {label}
    </span>
  );
}

function LabCard({
  card,
  featured,
  onOpen,
}: {
  card: HelpLabCard;
  featured?: boolean;
  onOpen: () => void;
}) {
  return (
    <article
      className={
        featured
          ? "anim-rise relative overflow-hidden rounded-2xl border border-teal-700/50 bg-gradient-to-br from-[#0c1f24] via-[#0a1520] to-[#060d14] p-5 shadow-[0_0_48px_rgba(45,212,191,0.12)]"
          : "anim-rise-delay-1 rounded-xl border border-slate-800/90 bg-[#080f16]/90 p-4"
      }
    >
      {featured && (
        <div
          aria-hidden
          className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 rounded-full bg-teal-400/10 blur-3xl"
        />
      )}
      <div className="relative flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {featured && (
              <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-teal-400/90">
                Featured
              </span>
            )}
            <RequiresBadge requires={card.requires} />
          </div>
          <h3
            className={
              featured
                ? "mt-2 text-2xl font-semibold tracking-tight text-slate-50"
                : "mt-1.5 text-sm font-semibold text-slate-100"
            }
          >
            {card.title}
          </h3>
          <p
            className={
              featured
                ? "mt-2 max-w-2xl text-sm leading-relaxed text-slate-400"
                : "mt-1 text-xs leading-relaxed text-slate-500"
            }
          >
            {card.tagline}
          </p>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className={
            featured
              ? "shrink-0 rounded-lg bg-teal-400 px-4 py-2.5 text-sm font-semibold text-slate-950 shadow-[0_0_28px_rgba(45,212,191,0.35)] hover:bg-teal-300"
              : "shrink-0 rounded-lg border border-teal-700/50 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/10"
          }
        >
          Open lab
        </button>
      </div>

      <div
        className={
          featured
            ? "relative mt-5 grid gap-4 sm:grid-cols-2"
            : "mt-3 grid gap-3 sm:grid-cols-2"
        }
      >
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            What it shows
          </p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed text-slate-300">
            {card.teaches.map((t) => (
              <li key={t.slice(0, 48)}>{t}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-teal-500/80">
            After this you keep
          </p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed text-teal-100/80">
            {card.youKeep.map((t) => (
              <li key={t.slice(0, 48)}>{t}</li>
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
}

export function HelpLab({ onOpenLab }: HelpLabProps) {
  const [cards, setCards] = useState<HelpLabCard[]>(FALLBACK_LAB_CATALOG);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listHelpLabs()
      .then((list) => {
        if (cancelled) return;
        if (Array.isArray(list) && list.length > 0) {
          setCards(list);
          setLoadError(null);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(typeof e === "string" ? e : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const featured = useMemo(
    () => cards.filter((c) => c.featured),
    [cards],
  );
  const byTrack = useMemo(() => {
    const map = new Map<string, HelpLabCard[]>();
    for (const c of cards) {
      if (c.featured) continue;
      const t = c.track || "advanced";
      const arr = map.get(t) ?? [];
      arr.push(c);
      map.set(t, arr);
    }
    return map;
  }, [cards]);

  const tracks = useMemo(() => {
    const known = TRACK_ORDER.filter((t) => (byTrack.get(t)?.length ?? 0) > 0);
    const extra = [...byTrack.keys()].filter(
      (t) => !TRACK_ORDER.includes(t as HelpLabTrack),
    );
    return [...known, ...extra];
  }, [byTrack]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-[#050b12]">
      <div className="mx-auto w-full max-w-4xl px-6 pb-12 pt-8">
        <header className="anim-rise mb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-teal-500/80">
            Help Lab
          </p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-50 sm:text-4xl">
            Learn by finishing a job
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-400">
            Each lab is a real workspace on fixtures. Read what it shows, open
            it, and keep the map and queries as SQL/dbt when you export.
          </p>
          {loadError && (
            <p className="mt-2 text-xs text-amber-300/90">
              Catalog from host unavailable — showing built-in cards. ({loadError})
            </p>
          )}
        </header>

        {featured.length > 0 && (
          <section className="mb-10 space-y-4">
            {featured.map((card) => (
              <LabCard
                key={card.id}
                card={card}
                featured
                onOpen={() => onOpenLab(card.id)}
              />
            ))}
          </section>
        )}

        {tracks.map((track) => {
          const list = byTrack.get(track) ?? [];
          if (list.length === 0) return null;
          const label =
            TRACK_LABELS[track as HelpLabTrack] ??
            track.replace(/_/g, " ");
          return (
            <section key={track} className="mb-8">
              <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                {label}
              </h3>
              <div className="space-y-3">
                {list.map((card) => (
                  <LabCard
                    key={card.id}
                    card={card}
                    onOpen={() => onOpenLab(card.id)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
