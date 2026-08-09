---
'@insession/space-state': patch
---

`message-pinned` を受け取ったとき、チャットにログ行を積まなくなった。ピン留めは固定表示そのものが結果を示しているため、ログ行は同じことを繰り返しながら会話を押し上げるだけだった。`pinnedMessage` の更新はこれまでどおり行う。

これに伴い、core が `log.messagePinned` / `log.messageUnpinned` の2キーを `t` に問い合わせなくなった。消費側で用意していた訳文は削除してよい。
