// デモ3枚で共有する「実行されたコード」ペイン。
//
// どのデモも見せたいことは同じ — 何を呼んだか、何が返ったか、副作用として何が出たか。
// no-op（reduce が null を返した / state が同一参照で再レンダリングされなかった）を
// 隠さず出すのが要点なので、そこだけ色を変えられるようにしてある。

export type TraceEntry = {
  /** 表示順を安定させるための単調増加の連番。 */
  id: number;
  /** 呼び出した式。 */
  call: string;
  /** 戻り値の要約。 */
  ret?: string;
  /** 併せて出た副作用・補足（1行ずつ）。 */
  effects?: string[];
  /** no-op だったか（色を変えるだけで、行は必ず出す）。 */
  noop?: boolean;
};

/** 直近 40 行だけ保持して先頭に積む。デモを長く触っても DOM が伸び続けないように。 */
export function pushEntry(entries: TraceEntry[], entry: Omit<TraceEntry, 'id'>): TraceEntry[] {
  const id = (entries[0]?.id ?? 0) + 1;
  return [{ ...entry, id }, ...entries].slice(0, 40);
}

export function TraceList({ entries, empty }: { entries: TraceEntry[]; empty: string }) {
  if (entries.length === 0) {
    return (
      <ul className="demo-trace">
        <li className="empty">{empty}</li>
      </ul>
    );
  }
  return (
    <ul className="demo-trace">
      {entries.map((entry) => (
        <li key={entry.id} data-noop={entry.noop ? '' : undefined}>
          <span className="call">{entry.call}</span>
          {entry.ret ? (
            <>
              <br />
              <span className="ret">→ {entry.ret}</span>
            </>
          ) : null}
          {/* 同じ effect 行が2本並ぶことがある。1要素にまとめて改行で並べれば、
              内容が重複しても一意な key を捻り出す必要がなくなる（CSS 側で pre-wrap）。 */}
          {entry.effects && entry.effects.length > 0 ? (
            <span className="eff">{entry.effects.join('\n')}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
