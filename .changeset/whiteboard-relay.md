---
'@insession/extension-whiteboard': minor
---

Add a `relay` action for live drawing frames

Confirmed strokes go through `reduce`, get stored and broadcast, and come back for late joiners. The line **being drawn right now** is a different thing: a frame per pointer move, worth forwarding to whoever is watching and worth nothing a second later. Storing those would flood the host's database and the wire.

Until now this package had nothing to say about them, so a host had to build its own fan-out path beside the extension — which meant **any registered extension could relay anything through it**, whether or not it had any use for relay.

```ts
board.reduce(state, 'relay', { payload: frame });
// -> { effects: [{ type: 'relay', payload: frame }] }   ← no `state`
```

Returning effects with no `state` (`@insession/space@0.2.0`) is what makes this work: nothing is stored, no board update is broadcast, and — the part that matters — **the relay phase timer is not re-armed**. People draw *during* the draw phase, so re-arming on every frame would keep a countdown that is supposed to run out from ever running out.

`payload` is **opaque on purpose**. What a frame contains — a partial stroke, a whole board at reduced fidelity, a cursor position — is a contract between your drawing client and your renderer, and it changes whenever that UI grows a feature. Teaching this package the shape would drag UI churn into a package that is supposed to be stable. What it *does* decide is that the whiteboard accepts relay at all: an extension that never returns a `relay` effect simply cannot be relayed through.

`WhiteboardReduceResult` is now a union (`{ state, effects } | { effects }`). Callers that read `.state` off it should narrow with `'state' in result` first.
