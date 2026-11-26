import { Segmented } from "./Segmented";

/** اختيار واحد: حتى 5 خيارات أزرار مجزّأة، وأكثر قائمة منسدلة (D-23) */
export function Pick<T extends string | number | null>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const idx = props.options.findIndex((o) => o.value === props.value);
  if (props.options.length <= 5) {
    return (
      <div className="pick">
        <span className="field-label">{props.label}</span>
        <Segmented<string>
          label={props.label}
          value={String(idx)}
          onChange={(v) => props.onChange(props.options[Number(v)].value)}
          options={props.options.map((o, i) => ({ value: String(i), label: o.label }))}
        />
      </div>
    );
  }
  return (
    <label className="pick">
      <span className="field-label">{props.label}</span>
      <select className="select" value={idx} onChange={(e) => props.onChange(props.options[Number(e.target.value)].value)}>
        {props.options.map((o, i) => (
          <option key={String(o.value)} value={i}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
