import { useEffect, useRef, useState } from "react";

export interface ModelStat {
  label: string;
  value: string;
}

export interface ModelOption {
  id: string;
  title: string;
  /** Compact label for the collapsed trigger on small screens. */
  shortTitle?: string;
  model: string;
  description: string;
  disabled?: boolean;
  stats?: ModelStat[];
  packageUrl?: string;
}

interface ModelSelectProps {
  options: ModelOption[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}

export function ModelSelect({ options, value, onChange, label }: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.id === value) ?? options[0];
  /** Menu order = declared order; only live models are listed. */
  const menuOptions = options.filter((o) => !o.disabled);
  const statSummary = (selected.stats ?? [])
    .slice(0, 2)
    .map((stat) => stat.value)
    .join(" \u00b7 ");

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = Array.from(
        rootRef.current?.querySelectorAll<HTMLButtonElement>(".pg-model-opt:not([disabled])") ?? [],
      );
      if (!items.length) return;
      e.preventDefault();
      const idx = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        e.key === "ArrowDown" ? items[(idx + 1 + items.length) % items.length] : items[(idx - 1 + items.length) % items.length];
      next.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="pg-model" ref={rootRef}>
      <button
        type="button"
        className={open ? "pg-model-btn pg-model-open" : "pg-model-btn"}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={selected.title}
      >
        <span className="pg-model-btn-text">
          <span className="pg-model-btn-title">
            <span className="pg-model-title-short">{selected.shortTitle ?? selected.title}</span>
            <span className="pg-model-title-full">{selected.title}</span>
          </span>
          <span className="pg-model-btn-model">
            {selected.model}
            {statSummary && <span className="pg-model-btn-stat"> · {statSummary}</span>}
          </span>
        </span>
        <span className={open ? "pg-model-caret pg-model-caret-up" : "pg-model-caret"} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="pg-model-menu" role="listbox" aria-label={label}>
          {menuOptions.map((o) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={o.id === value}
              className={o.id === value ? "pg-model-opt pg-model-opt-on" : "pg-model-opt"}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
              }}
            >
              <span className="pg-model-opt-head">
                <span className="pg-model-opt-title">{o.title}</span>
                <span className="pg-model-beta">beta</span>
              </span>
              <span className="pg-model-opt-modelrow">
                <span className="pg-model-opt-model">{o.model}</span>
                {(o.stats ?? []).map((stat) => (
                  <span key={stat.label} className="pg-model-stat" title={stat.label}>
                    {stat.value}
                  </span>
                ))}
              </span>
              <span className="pg-model-opt-desc">{o.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
