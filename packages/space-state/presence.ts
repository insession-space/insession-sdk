// ログイン済みユーザー(uid あり)が複数デバイスから同一スペースに入室したときの
// 「同一人物は1人として扱う」ための純関数群(#1080)。
//
// サーバーは今までどおり全接続(デバイス)を members に載せて配信する(memberList は変更しない。
// UI が自分自身を `m.id === selfId` で判定しているため、サーバー側で dedupe すると2台目の
// デバイスから見た自分の行が消えて壊れる)。そのため重複排除・ログ抑制の判定はすべて
// クライアント側(ここ)で行う。
//
// uid=null(未ログイン・ゲスト)は従来どおり接続ごとに1エントリのまま扱う(挙動変更なし)。

type MemberLike = { id: number; uid?: string | null; presence?: 'active' | 'away' };

// members を uid ごとに1エントリへ畳む(表示用)。uid=null のエントリは畳まない(ゲストは
// 接続ごとに残す)。同一 uid が複数居る場合は id===selfId のエントリを優先し、無ければ
// 最初に出現した接続を残す。順序はその uid が最初に出現した位置を保つ(以降の重複出現は
// 詰めない=先頭のスロットのまま更新される)。
export function dedupeMembersByUid<T extends MemberLike>(members: T[], selfId: number | null): T[] {
  // 各 uid につき「採用すべきエントリ」を先に1周で決める: self があれば self、無ければ
  // 最初に出現したエントリ(以降 self が出現しても上書きしない=self最優先)。
  const chosenByUid = new Map<string, T>();
  for (const m of members) {
    if (!m.uid) continue;
    const current = chosenByUid.get(m.uid);
    if (!current) {
      chosenByUid.set(m.uid, m);
    } else if (current.id !== selfId && m.id === selfId) {
      chosenByUid.set(m.uid, m);
    }
  }
  // presence(#1352)は「どの接続を採用したか」と独立に決める: 同じ人の接続が1つでも
  // active なら、その人は active として見せる。採用エントリ(self優先)だけを見ると、
  // 「PC で作業しながらスマホを畳んでいる」人が away に見えてしまう。
  const activeUids = new Set<string>();
  for (const m of members) {
    if (m.uid && (m.presence ?? 'active') === 'active') activeUids.add(m.uid);
  }
  // 2周目: uid の最初の出現位置に採用エントリを置き、以降の重複出現は詰める(順序保持)。
  const result: T[] = [];
  const emittedUid = new Set<string>();
  for (const m of members) {
    if (!m.uid) {
      result.push(m);
      continue;
    }
    if (emittedUid.has(m.uid)) continue;
    emittedUid.add(m.uid);
    // biome-ignore lint/style/noNonNullAssertion: 1周目で同じ uid を必ず set 済み
    const chosen = chosenByUid.get(m.uid)!;
    const presence = activeUids.has(m.uid) ? 'active' : 'away';
    result.push((chosen.presence ?? 'active') === presence ? chosen : { ...chosen, presence });
  }
  return result;
}

// joined が「この uid の最初の接続」かどうか。uid が無ければ(ゲスト)常に true
// (=毎回アナウンスする。従来動作)。uid があり、joined 受信前の prevMembers に同 uid の
// 別接続(id違い)が既に居れば false(=2台目以降の入室)。
export function isFirstConnectionOfUid(prevMembers: MemberLike[], joined: MemberLike): boolean {
  if (!joined.uid) return true;
  return !prevMembers.some((m) => m.uid === joined.uid && m.id !== joined.id);
}
