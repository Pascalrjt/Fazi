/** Shared building blocks for the settings panes. */
import clsx from "clsx";

export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 py-2.5">
      <div className="w-[210px] shrink-0 pt-0.5">
        <div className="text-[13px] text-primary">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-snug text-tertiary">{hint}</div>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={clsx(
        "h-5 w-9 cursor-default rounded-full p-0.5 transition-colors",
        checked ? "bg-accent" : "bg-raised border border-edge-strong",
        disabled && "opacity-40",
      )}
      onClick={() => onChange(!checked)}
    >
      <div
        className={clsx(
          "h-4 w-4 rounded-full bg-white transition-transform",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md bg-pane p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          className={clsx(
            "cursor-default rounded px-2 py-0.5 text-[12px]",
            value === v ? "bg-accent text-white" : "text-secondary hover:bg-hov",
          )}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function NumberField({
  value,
  min,
  max,
  step,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (v: number) => void;
}) {
  return (
    <input
      type="number"
      className="w-28 rounded-md border border-edge bg-pane px-2 py-1 text-[12px] text-primary outline-none focus:border-accent"
      defaultValue={value}
      min={min}
      max={max}
      step={step}
      onBlur={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onCommit(Math.max(min, Math.min(max, Math.round(n))));
        else e.target.value = String(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        e.stopPropagation();
      }}
    />
  );
}
