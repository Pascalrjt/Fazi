/** Shared building blocks for the Settings tab. */
import { createContext, useContext, useState } from "react";
import clsx from "clsx";
import { Minus, Plus, RotateCcw, X } from "lucide-react";
import { SETTINGS_DEFAULTS, useSettings, type SettingsValues } from "../../stores/settings";
import { isModified, type SettingKey } from "./sections";

/** Lowercased settings-search query; "" = no filtering. Rows filter
 *  themselves so labels/hints stay single-sourced in the section JSX. */
export const SettingsFilterContext = createContext("");

/** Whether a row with these words matches the current settings search. */
export function useMatchesFilter(words: string): boolean {
  const query = useContext(SettingsFilterContext);
  return query === "" || words.toLowerCase().includes(query);
}

function restoreDefaults(keys: SettingKey[]): void {
  const patch: Partial<SettingsValues> = {};
  for (const key of keys) Object.assign(patch, { [key]: SETTINGS_DEFAULTS[key] });
  useSettings.getState().patch(patch);
}

/** A titled group of rows on a card; hidden when search filters out every row. */
export function SettingGroup({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="settings-section mt-6 first:mt-0" aria-label={title}>
      {title && <h3 className="mb-1.5 ml-1 text-[11.5px] font-semibold text-secondary">{title}</h3>}
      <div className="settings-card rounded-[10px] bg-raised shadow-[inset_0_0_0_0.5px_var(--border)]">
        {children}
      </div>
    </section>
  );
}

/**
 * One setting: label and explanation on the left, the control on the right
 * (or below, for `block` editors). `setting` names the keys it edits, which
 * drives the changed dot and the restore button. `needs` dims the row while
 * a parent setting is off.
 */
export function SettingRow({
  label,
  hint,
  keywords = "",
  setting,
  needs,
  block,
  children,
}: {
  label: string;
  hint?: string;
  keywords?: string;
  setting?: SettingKey | SettingKey[];
  needs?: { label: string; on: boolean };
  block?: boolean;
  children: React.ReactNode;
}) {
  const keys = setting == null ? [] : Array.isArray(setting) ? setting : [setting];
  const modified = useSettings((s) => keys.some((k) => isModified(s, k)));
  if (!useMatchesFilter(`${label} ${hint ?? ""} ${keywords}`)) return null;
  const dimmed = needs != null && !needs.on;
  return (
    <div
      className={clsx(
        "settings-row group/row flex gap-x-4 gap-y-2.5 px-3.5 py-[var(--settings-row-pad)]",
        block ? "flex-col" : "items-center",
      )}
    >
      <div className={clsx("min-w-0 flex-1", dimmed && "opacity-55")}>
        <div className="flex items-center gap-1.5 text-[13px] text-primary">
          {label}
          {dimmed && (
            <span className="rounded bg-hov px-1.5 py-px text-[10.5px] font-medium text-tertiary">
              {needs.label} only
            </span>
          )}
          {modified && (
            <>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Changed from default" />
              <button
                className="hidden h-[18px] w-[18px] cursor-default items-center justify-center rounded text-tertiary hover:bg-hov hover:text-primary focus-visible:flex group-hover/row:flex"
                title="Restore default"
                aria-label={`Restore default for ${label}`}
                onClick={() => restoreDefaults(keys)}
              >
                <RotateCcw size={11} strokeWidth={1.75} />
              </button>
            </>
          )}
        </div>
        {hint && <div className="mt-0.5 max-w-[54ch] text-[11.5px] leading-snug text-tertiary">{hint}</div>}
      </div>
      <div className={clsx("min-w-0", !block && "shrink-0")}>{children}</div>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={clsx(
        "focusable relative h-[19px] w-8 shrink-0 cursor-default rounded-full transition-colors",
        checked ? "bg-accent" : "bg-[var(--switch-off)]",
        disabled && "opacity-40",
      )}
      onClick={() => onChange(!checked)}
    >
      <span
        className={clsx(
          "absolute left-0.5 top-0.5 h-[15px] w-[15px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-transform",
          checked && "translate-x-[13px]",
        )}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<[T, React.ReactNode]>;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-[7px] bg-hov p-0.5">
      {options.map(([v, text]) => (
        <button
          key={v}
          role="radio"
          aria-checked={value === v}
          className={clsx(
            "focusable h-[22px] cursor-default whitespace-nowrap rounded-[5px] px-2.5 text-[12px]",
            value === v
              ? "bg-[var(--seg-on)] font-medium text-primary shadow-[0_1px_2px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.06)]"
              : "text-secondary hover:text-primary",
          )}
          onClick={() => onChange(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** A number with − / + buttons; typing commits on blur or Return. */
export function Stepper({
  value,
  min,
  max,
  step,
  unit,
  label,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  label: string;
  onCommit: (v: number) => void;
}) {
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n)));
  const text = value.toLocaleString("en-US");
  return (
    <div className="inline-flex h-[26px] items-center rounded-[7px] bg-hov px-0.5">
      <button
        className="focusable flex h-[22px] w-[22px] cursor-default items-center justify-center rounded-[5px] text-secondary enabled:hover:bg-[var(--seg-on)] enabled:hover:text-primary disabled:opacity-40"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => onCommit(clamp(value - step))}
      >
        <Minus size={12} strokeWidth={1.75} />
      </button>
      <input
        key={value}
        aria-label={label}
        inputMode="numeric"
        className="tnum h-[22px] rounded-[5px] bg-[var(--seg-on)] px-1.5 text-right text-[12px] text-primary outline-none shadow-[0_0_0_0.5px_var(--border)] focus:shadow-[0_0_0_1.5px_var(--accent)]"
        style={{ width: `calc(${text.length}ch + 16px)` }}
        defaultValue={text}
        onBlur={(e) => {
          const n = Number(e.target.value.replace(/[^\d.]/g, ""));
          if (Number.isFinite(n) && e.target.value.trim() !== "") onCommit(clamp(n));
          else e.target.value = text;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
      />
      {unit && <span className="pl-1.5 pr-1 text-[11.5px] text-tertiary">{unit}</span>}
      <button
        className="focusable flex h-[22px] w-[22px] cursor-default items-center justify-center rounded-[5px] text-secondary enabled:hover:bg-[var(--seg-on)] enabled:hover:text-primary disabled:opacity-40"
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        onClick={() => onCommit(clamp(value + step))}
      >
        <Plus size={12} strokeWidth={1.75} />
      </button>
    </div>
  );
}

/** Editable list of short strings: Return adds, × or Backspace removes. */
export function Chips({
  values,
  placeholder,
  label,
  onChange,
}: {
  values: string[];
  placeholder: string;
  label: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-wrap gap-[5px] rounded-lg bg-pane p-1.5 shadow-[inset_0_0_0_0.5px_var(--border)] focus-within:shadow-[inset_0_0_0_1.5px_var(--accent)]">
      {values.map((v, i) => (
        <span
          key={v}
          className="inline-flex h-[22px] items-center gap-1 rounded-[5px] bg-raised pl-2 pr-1 font-mono text-[11.5px] text-primary shadow-[0_0_0_0.5px_var(--border-strong)]"
        >
          {v}
          <button
            className="flex h-4 w-4 cursor-default items-center justify-center rounded text-tertiary hover:bg-hov hover:text-primary"
            aria-label={`Remove ${v}`}
            onClick={() => onChange(values.filter((_, j) => j !== i))}
          >
            <X size={10} strokeWidth={2} />
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        className="h-[22px] min-w-[140px] flex-1 bg-transparent px-1 font-mono text-[11.5px] text-primary outline-none placeholder:text-tertiary"
        placeholder={placeholder}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          const v = draft.trim();
          if (e.key === "Enter" && v !== "") {
            if (!values.includes(v)) onChange([...values, v]);
            setDraft("");
          } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
      />
    </div>
  );
}

/** A single-line text setting that commits on blur or Return. */
export function TextField({
  value,
  placeholder,
  label,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  label: string;
  onCommit: (v: string) => void;
}) {
  return (
    <input
      key={value}
      aria-label={label}
      className="h-[26px] w-40 rounded-[7px] bg-hov px-2 text-[12.5px] text-primary outline-none placeholder:text-tertiary focus:shadow-[0_0_0_1.5px_var(--accent)]"
      defaultValue={value}
      placeholder={placeholder}
      spellCheck={false}
      onBlur={(e) => onCommit(e.target.value.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        e.stopPropagation();
      }}
    />
  );
}

/** Small text-or-icon button for list rows. */
export function MiniButton({
  label,
  title,
  disabled,
  onClick,
  children,
}: {
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className="focusable flex h-[22px] min-w-[22px] shrink-0 cursor-default items-center justify-center rounded-[5px] px-1 text-[11.5px] text-tertiary enabled:hover:bg-hov enabled:hover:text-primary disabled:opacity-40"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Accent-colored "+ Add…" link under a list. */
export function AddButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="focusable mt-2 inline-flex h-6 cursor-default items-center gap-1.5 rounded-md pl-1.5 pr-2.5 text-[12px] font-medium text-accent hover:bg-accent-faint"
      onClick={onClick}
    >
      <Plus size={12} strokeWidth={2} />
      {children}
    </button>
  );
}

/** Rounded list container for pinned folders, cleanup rules, kept items. */
export function ListBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="settings-list flex flex-col overflow-hidden rounded-lg bg-pane shadow-[inset_0_0_0_0.5px_var(--border)]">
      {children}
    </div>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg bg-pane px-3 py-2.5 text-[12px] text-tertiary">{children}</div>;
}

