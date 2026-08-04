// スペース受信メッセージの純粋 reducer（#1713）。use-space.ts の handleCoreMessage（446〜845行）を
// transport/React 非依存の形へ忠実に移植したもの。**この switch の挙動は1つも変えていない** —
// 各 case のコメントは元コードの意図（#番号付きの根拠）を保ったまま移した。
//
// 移植にあたって、元コードが useRef で持っていた「直前値」（screenShareSharer /
// endedAgentRuns / typingTimers 等）は reducer が前 state を引数で受け取れる
// ため state 側へ引き上げた（state.ts 参照）。副作用（音・通知・送信・タイマー）は一切実行せず、
// SpaceEffect の記述子として返す（実行は消費者の責務）。
//
// ⚠ join-rejected の authDegraded/authRejected 判定と、member-updated の認証昇格判定は
//   接続ライフサイクルの都合であり reducer には持ち込まない（消費者に残す）。
//
// #1720 step6: 個々のスペースアプリ固有の知識(操作ログ・フェーズ切替判定・効果音/通知)は
// ここから各 plugin パッケージの client.ts へ剥がした。core が知るのは「app-state を
// apps[appId] へ格納する」ことだけで、plugin ごとの畳み込みは plugin.ts の PluginClient
// 経由で注入される(ctx.plugins)。
import { clearTyping as clearTypingAction } from './actions.ts';
import { pushChatLine } from './chat-lines.ts';
import type { SpaceEffect } from './effects.ts';
// ReduceCtx は plugin.ts 側で定義している(PluginClient.onAppState が ReduceCtx を要求するため、
// reduce.ts 側に定義すると reduce.ts ⇄ plugin.ts の循環 import になる)。ここで import した上で
// re-export し、既存の import 元(store.ts / 各テスト)の `from './reduce.ts'` を変えずに済むようにする。
import type { ReduceCtx } from './plugin.ts';

export type { ReduceCtx } from './plugin.ts';

import { isFirstConnectionOfUid } from './presence.ts';
import { toReactionsView } from './reactions.ts';
import type { SpaceState } from './state.ts';
import { AGENT_ENDED_RUNS_MAX } from './state.ts';

// ⚠ スペース全体設定の既定値はここでは持たない（protocol 依存を切る独立化タスク）。
// 'msg.settings' が無いときのフォールバックは ctx.defaultSettings（消費者が
// createSpaceStore の initialSettings で注入した値。plugin.ts の ReduceCtx 参照）を使う。

// ログイン済みユーザー(uid あり)の2台目以降の入室かどうかを判定する(#1080)。
// 同一人物のマルチデバイス入室を1人として扱うための純関数群は ./presence.ts（旧
// packages/space-core/presence.ts。#1713 で space-state 側の単一ソースへ移設した）。

export function reduceSpace(
  state: SpaceState,
  msg: any,
  ctx: ReduceCtx,
): { state: SpaceState; effects: SpaceEffect[] } {
  const effects: SpaceEffect[] = [];

  switch (msg.type) {
    case 'space-state': {
      const next: SpaceState = {
        ...state,
        connected: true, // 全状態を受信＝接続確立。初回ローディングを閉じる
        selfId: typeof msg.selfId === 'number' ? msg.selfId : null,
        members: msg.members,
        title: msg.title || null,
        pinnedMessage: msg.pinnedMessage || null,
        owner: msg.owner || null,
        kind: msg.kind === 'my_space' ? 'my_space' : 'ephemeral',
        community: msg.community || null,
        settings: msg.settings || ctx.defaultSettings,
        communityId: msg.communityId || null,
        features: msg.features || { durationLimit: false },
        apps: msg.apps || {},
        screenShareSharer: msg.screenShareSharer || null,
        // plugin ごとの初期ローカルスライス(#1720 step6)。initLocal は「直前値を記録するだけ」
        // に徹する契約(plugin.ts 参照)なので、ここで effect が出ることは無い。
        pluginLocal: (ctx.plugins ?? []).reduce<Record<string, any>>((acc, p) => {
          if (p.initLocal) acc[p.id] = p.initLocal(msg.apps?.[p.id]);
          return acc;
        }, {}),
      };
      effects.push({ type: 'history-title', title: msg.title });
      // サーバーは新しい接続を必ず active から始める(#1352)。join した時点で既に away
      // （隠れたタブで開いた／別ウィンドウで作業中に再接続した）なら、ここで申告し直さないと
      // 実際は離席中なのに active のまま残る。再接続のたびに space-state が来るので
      // 「張り直しで active に巻き戻る」もここで塞がる。
      if (ctx.presence !== 'active') {
        effects.push({
          type: 'send',
          message: { type: 'presence-change', presence: ctx.presence },
        });
      }
      return { state: next, effects };
    }

    case 'member-joined': {
      // サーバーは入室者本人を除外して配信するので、これは常に「他人」の入室。
      // ログイン済み(uid あり)ユーザーの2台目以降のデバイス入室は「同一人物」なので、
      // ログ/効果音/OS通知は出さない(#1080)。判定は現在の members(=このイベント受信前の
      // スナップショット)を基準にするため members の置換の前に評価する。members そのものの
      // 反映は常に行う(サーバーの正データを状態として持つことは変えない)。
      const isFirstConnection = isFirstConnectionOfUid(state.members, msg.member);
      let next: SpaceState = { ...state, members: msg.members };
      // #1265: サーバー再起動由来の再接続(resumed)も、同一人物の別デバイス(#1080)と同じく
      // 抑制対象。どちらか一方でも該当すれば出さない(OR)。presence の反映(members置換)は
      // どちらの場合も上で常に行っている。
      if (isFirstConnection && !msg.resumed) {
        next = pushChatLine(next, {
          kind: 'log',
          icon: 'group',
          by: msg.member.name,
          text: ctx.t('log.joined'),
          greeting: true,
        });
        effects.push({ type: 'sound', sound: 'join' });
        effects.push({ type: 'notify-join', name: msg.member.name });
      }
      return { state: next, effects };
    }

    case 'space-owner-updated': {
      // 在室したままオーナーが確定したとき（匿名で入った作成者が昇格した。#1224）。
      // owner は space-state でしか来ないため、これが無いと次の入室までオーナー限定 UI が出ない。
      return { state: { ...state, owner: msg.owner || null }, effects };
    }

    case 'join-rejected': {
      // ログイン中なのに匿名で join してしまった接続（#1224）が拒否された場合の回復判定は
      // 接続ライフサイクル(authDegraded/authRejected)に依存するため、reducer には持ち込まない。
      // state は変えず、effects も出さない（消費者側が判定してから振る舞いを決める）。
      return { state, effects };
    }

    case 'member-updated': {
      // 🧩スイッチャーでの表示中カード切替。members 内の該当メンバーだけ差し替える
      // (join/leave と違い members 配列そのものはサーバーから来ないため手元で更新する)。
      // ⚠ 匿名 join からの昇格判定(authDegraded の解除)は接続ライフサイクルの都合なので
      //   ここでは扱わない(消費者に残す)。
      const updated = msg.member;
      const before = state.members.find((m: any) => m.id === updated.id);
      let next = state;
      // ホワイトボードへの切替のみログ化(他ステージ間の切替は対象外)。自分自身の操作は出さない
      if (
        before &&
        updated.currentStage === 'whiteboard' &&
        before.currentStage !== 'whiteboard' &&
        updated.id !== state.selfId
      ) {
        next = pushChatLine(next, {
          kind: 'log',
          icon: 'edit',
          by: updated.name,
          text: ctx.t('log.whiteboardSwitch'),
          appId: 'whiteboard',
        });
      }
      next = {
        ...next,
        members: next.members.map((m: any) => (m.id === updated.id ? { ...m, ...updated } : m)),
      };
      return { state: next, effects };
    }

    case 'screen-share-state': {
      // 誰も共有していない→共有者ありへの遷移でのみログ化(停止・閲覧開始/終了は対象外)。
      // 自分自身が開始した場合はログ化しない
      const prevSharer = state.screenShareSharer;
      const nextSharer = msg.sharer || null;
      const startsLog = !prevSharer && msg.sharer && msg.sharer.id !== state.selfId;
      // ⚠ 共有者が実質変わっておらず、ログ行も出さないなら **state を同一参照のまま返す**。
      //   旧実装ではこの値は ref（screenShareSharerRef）で、代入しても再レンダリングを
      //   起こさなかった。state へ引き上げた以上、無変化の遷移（閲覧開始/終了・停止の再送）で
      //   再レンダリングを増やさないよう自分で潰す（#1713）。
      //   同一判定は id だけでなく name まで見る（表示名は変わりうるので、id だけで畳むと
      //   共有者バッジの名前が古いまま残る）。
      const sameSharer =
        (prevSharer?.id ?? null) === (nextSharer?.id ?? null) &&
        (prevSharer?.name ?? null) === (nextSharer?.name ?? null);
      if (!startsLog && sameSharer) return { state, effects };
      let next: SpaceState = { ...state, screenShareSharer: nextSharer };
      if (startsLog) {
        next = pushChatLine(next, {
          kind: 'log',
          icon: 'screen_share',
          by: msg.sharer.name,
          text: ctx.t('log.screenShareStart'),
          screenShare: true,
        });
      }
      return { state: next, effects };
    }

    case 'member-left': {
      // 退室時はチャットログ・効果音を出さない(#1378。presence ノイズ削減のため廃止)。
      // members の反映と app-relay の掃除は presence の正しさに必要なので残す。
      // app-relay エントリの掃除は「名前スイープ」方式(#1080)。退室のたびに「今の在室者名
      // (msg.members)に居ない送信者(by)」を全 appId 横断で drop する(残存端末と同名なら残る=
      // 本人在室中は消えない・表示名違いのゴーストも掃除される・同名ゲストの誤削除にもならない)。
      // これをしないと退室者の最終 payload(ホワイトボードの描きかけ kind:'draw' 等)が残り、
      // 他クライアントにゴーストが残留する(ホワイトボードの盤面リレーにも有益)。
      const presentNames = new Set(msg.members.map((m: any) => m.name));
      const appRelay: Record<string, any> = {};
      for (const [appId, bySender] of Object.entries(state.appRelay)) {
        const rest: Record<string, any> = {};
        for (const [by, payload] of Object.entries(bySender as Record<string, any>)) {
          if (presentNames.has(by)) rest[by] = payload;
        }
        appRelay[appId] = rest;
      }
      return { state: { ...state, members: msg.members, appRelay }, effects };
    }

    case 'favorite-queued-video': {
      const self = state.members.find((m: any) => m.id === state.selfId);
      if (self?.uid !== msg.targetUid) return { state, effects };
      const next = pushChatLine(state, {
        kind: 'log',
        icon: 'star',
        by: msg.by,
        text: ctx.t('log.favoriteQueuedVideo'),
      });
      return { state: next, effects };
    }

    case 'chat': {
      // 自分のチャットは sendChat でローカル追加され here を通らないので、これは他者の受信
      let next = pushChatLine(state, {
        kind: 'chat',
        name: msg.name,
        self: false,
        text: msg.text,
        id: msg.id ?? null,
        uid: msg.uid ?? null,
        // #1246: サーバーが送信時点で解決した avatar。members からの逆引きに依存しない
        // (退室済み・chat-history 復元でも解決できるようにするため。chat-panel.tsx 参照)。
        avatar: msg.avatar ?? null,
        reactions: {},
        replyTo: msg.replyTo,
        imageUrl: msg.kind === 'sticker' ? msg.imageUrl : undefined,
        // AI Agent の発言(#30)。バッジ表示のためだけの印。kind='agent' はサーバーしか
        // 付けられない(chat ハンドラが kind を決めるので、クライアントは騙れない)。
        isAgent: msg.kind === 'agent',
        // どの Agent の発言か(#1589)。アバターの解決に使う。choices と同じく DB 非保存なので
        // chat-history 復元側には無く、そちらは表示名から引き直す。
        agentId: msg.agentId ?? null,
        // #1534: Agent がキュー枯渇時に添える選択肢。DB に保存されないので chat-history
        // 復元側（下の case 'chat-history'）には意図的に無い（古い提案を蘇らせない）。
        choices: msg.choices,
        createdAt: msg.createdAt ?? ctx.now,
      });
      // 送信されたので入力中表示は即座に消す(3秒待たない)。表示の除去(state)と、残っている
      // 3秒の自動クリアタイマー自体の解除(effect)はセットで行う — タイマー解除を落とすと
      // 消費者側に不要なタイマーが残る(#1713)。
      next = clearTypingAction(next, msg.name);
      effects.push({ type: 'typing-timer-clear', name: msg.name });
      effects.push({ type: 'sound', sound: 'chat' });
      // 自分宛メンション(#1536)は通常のチャット通知と文面を分ける判定を消費者側(mention.ts)に
      // 委ねるため、reducer は生の name/text をそのまま渡す。
      effects.push({ type: 'notify-chat', name: msg.name, text: msg.text });
      return { state: next, effects };
    }

    case 'chat-history': {
      let next = state;
      for (const m of msg.messages) {
        next = pushChatLine(next, {
          kind: 'chat',
          name: m.name,
          // Agent 発言は「自分の発言」にならない(表示名が偶然一致しても)。
          self: m.kind !== 'agent' && m.name === ctx.selfName,
          text: m.text,
          history: true,
          id: m.id ?? null,
          uid: m.uid ?? null,
          // #1246: chat と同じくメッセージ自身の avatar を使う(過去ログの発言者は現在の
          // members に居ないことが多く、逆引きでは解決できないため)。
          avatar: m.avatar ?? null,
          reactions: toReactionsView(m.reactions, ctx.selfName),
          replyTo: m.replyTo,
          imageUrl: m.kind === 'sticker' ? m.imageUrl : undefined,
          isAgent: m.kind === 'agent',
          createdAt: m.createdAt,
        });
      }
      return { state: next, effects };
    }

    case 'chat-ack': {
      // clientMsgId で対応するローカルエコー行を見つけ、サーバー採番idを反映する(#236)。
      // #887: 併せて送信時刻もサーバー権威値へ揃える(自分の時計がずれていても他の参加者と
      // 同じ時刻が出る)。旧サーバーは createdAt を返さないのでその場合はローカル値のまま。
      const chatLines = state.chatLines.map((line: any) =>
        line.clientMsgId === msg.clientMsgId
          ? { ...line, id: msg.id ?? null, ...(msg.createdAt ? { createdAt: msg.createdAt } : {}) }
          : line,
      );
      return { state: { ...state, chatLines }, effects };
    }

    case 'chat-reaction-update': {
      const chatLines = state.chatLines.map((line: any) =>
        line.id === msg.messageId
          ? { ...line, reactions: toReactionsView(msg.reactions, ctx.selfName) }
          : line,
      );
      return { state: { ...state, chatLines }, effects };
    }

    case 'space-renamed': {
      const logText = msg.title ? ctx.t('log.renamed', msg.title) : ctx.t('log.renameReset');
      let next: SpaceState = { ...state, title: msg.title || null };
      effects.push({ type: 'history-title', title: msg.title });
      next = pushChatLine(next, { kind: 'log', icon: 'edit', by: msg.by, text: logText });
      return { state: next, effects };
    }

    case 'message-pinned': {
      let next: SpaceState = { ...state, pinnedMessage: msg.pinned || null };
      next = pushChatLine(next, {
        kind: 'log',
        icon: 'push_pin',
        by: msg.by,
        text: msg.pinned ? ctx.t('log.messagePinned') : ctx.t('log.messageUnpinned'),
      });
      return { state: next, effects };
    }

    case 'space-settings-updated': {
      let next: SpaceState = { ...state, settings: msg.settings || ctx.defaultSettings };
      next = pushChatLine(next, {
        kind: 'log',
        icon: 'settings',
        by: msg.by,
        text: ctx.t('log.settingsUpdated'),
      });
      return { state: next, effects };
    }

    case 'app-state': {
      // アプリ状態は送信者含む全員に配信される(ローカルエコー不要)。
      // apps[appId] への格納(最新値で置換)は plugin の有無に関わらず core が常に行う
      // (#1720 step6。plugin 記述子が無い appId でも、状態の反映自体は既定動作として続く)。
      let next: SpaceState = { ...state, apps: { ...state.apps, [msg.appId]: msg.state } };
      const plugin = (ctx.plugins ?? []).find((p) => p.id === msg.appId);
      const result = plugin?.onAppState?.({ local: state.pluginLocal[msg.appId], msg, ctx });
      if (result) {
        if ('local' in result) {
          next = { ...next, pluginLocal: { ...next.pluginLocal, [msg.appId]: result.local } };
        }
        // ログ行は順序どおりに積む(pushChatLine は末尾追加なので配列の順=表示順)。
        for (const line of result.lines ?? []) {
          next = pushChatLine(next, line);
        }
        for (const effect of result.effects ?? []) {
          effects.push(effect);
        }
      }
      return { state: next, effects };
    }

    case 'typing': {
      const typingName = msg.name;
      effects.push({ type: 'typing-timer', name: typingName });
      // ⚠ 既に入力中として出 している相手なら **state を同一参照のまま返す**。typing は入力の
      //   たびに1秒周期で届くので、ここで毎回新しい state 木を作ると、旧実装が
      //   setTypingUsers(prev => prev.includes(n) ? prev : …) の bail out で抑えていた
      //   「入力中ずっと1秒ごとに space ツリー全体が再レンダリング」が復活する（#1713）。
      //   タイマーの張り直し(effect)は state と無関係に毎回必要なので、上で先に積む。
      if (state.typingUsers.includes(typingName)) return { state, effects };
      return { state: { ...state, typingUsers: [...state.typingUsers, typingName] }, effects };
    }

    case 'app-relay': {
      // 高頻度リレー(相手盤面等)。チャットログには一切流さず、送信者別に最新だけ保持する。
      // 退室後に遅れて届く相手のリレー(member-left の後に来る末尾フレーム)は在室者ガードで捨てる。
      // これがないと退室者の描きかけ/盤面がゴーストとして残留しうる。
      if (!state.members.some((m: any) => m.name === msg.by)) return { state, effects };
      const appRelay = {
        ...state.appRelay,
        [msg.appId]: { ...(state.appRelay[msg.appId] || {}), [msg.by]: msg.payload },
      };
      return { state: { ...state, appRelay }, effects };
    }

    case 'agent-status': {
      // AI Agent の実行状態(#1589)。app-relay と同じ揮発データで、チャットログにもDBにも残さない。
      const { agentId, requestId, phase } = msg;
      // 終了済みの実行から遅れて届いた非 idle フレームは捨てる（実況が復活してしまう）。
      if (phase !== 'idle' && state.endedAgentRuns.includes(requestId)) return { state, effects };
      if (phase === 'idle') {
        effects.push({ type: 'agent-timer-clear', requestId });
        // FIFO で上限を保つ（挿入順を保ち、上限を超えたら古い方から捨てる）。
        let endedAgentRuns = state.endedAgentRuns;
        if (!endedAgentRuns.includes(requestId)) {
          endedAgentRuns = [...endedAgentRuns, requestId];
          if (endedAgentRuns.length > AGENT_ENDED_RUNS_MAX) {
            endedAgentRuns = endedAgentRuns.slice(endedAgentRuns.length - AGENT_ENDED_RUNS_MAX);
          }
        }
        // ⚠ **この agent の「今の実行」でなければ無視する。** 実行A→実行B と続いたとき、
        //   遅れて届いた A の idle が B の実況を消してしまうのを防ぐ(#1589 の requestId の本題)。
        let agentStatuses = state.agentStatuses;
        if (state.agentStatuses[agentId]?.requestId === requestId) {
          agentStatuses = { ...state.agentStatuses };
          delete agentStatuses[agentId];
        }
        return { state: { ...state, endedAgentRuns, agentStatuses }, effects };
      }
      // 取りこぼし保険。サーバー側の締め切り(RUN_TIMEOUT_MS=20秒)より必ず後に発火させる。
      // これを短くすると、正常に動いている実行の実況を先に消してしまう。
      effects.push({ type: 'agent-timer-clear', requestId });
      effects.push({ type: 'agent-timer', agentId, requestId });
      const agentStatuses = {
        ...state.agentStatuses,
        [agentId]: { requestId, phase, tool: msg.tool },
      };
      return { state: { ...state, agentStatuses }, effects };
    }

    default:
      // 未知の type は state をそのまま返す(同一参照。無駄な再レンダリングを避ける)。
      return { state, effects };
  }
}
