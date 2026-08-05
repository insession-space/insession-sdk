# @insession/space-state-react

The React binding for [`@insession/space-state`](https://www.npmjs.com/package/@insession/space-state)
— one hook, about ten lines, no logic of its own.

`@insession/space-state` is deliberately framework-agnostic: it depends on
neither React nor a WebSocket implementation. Its `getState` / `subscribe` pair
already satisfies the `useSyncExternalStore` contract (`getState()` returns the
same reference while nothing has changed), so all that is left is the wiring.
That wiring is this package, kept separate so the store itself stays free of a
React dependency.

## Install

```sh
npm install @insession/space-state-react @insession/space-state
```

Published as a built ESM package (`dist/index.js` + `dist/index.d.ts`). `react`
is a peer dependency (`^19.0.0`); `@insession/space-state` is a direct
dependency but you will be importing it yourself anyway.

## Usage

```tsx
import { createSpaceStore } from '@insession/space-state';
import { useSpaceState } from '@insession/space-state-react';

const store = createSpaceStore({
  selfName: 'alice',
  t: (key) => key,
  getPresence: () => 'active',
});

function SpaceView() {
  const state = useSpaceState(store);

  return (
    <>
      <p>{state.members.length} people here</p>
      <ul>
        {state.chatLines.map((line) => (
          <li key={line.key}>{line.text}</li>
        ))}
      </ul>
      <button type="button" onClick={() => store.chat.send('hello')}>
        Say hello
      </button>
    </>
  );
}
```

Reading state goes through the hook; sending goes straight to the store's local
actions (`store.chat.send`, `store.presence.change`, …). There is no provider
and no context — pass the store however you already pass values around.

## API

| Export | Meaning |
| --- | --- |
| `useSpaceState(store: SpaceStore): SpaceState` | Subscribes to the store and re-renders on change. Hands `store.subscribe` and `store.getState` to `useSyncExternalStore` unchanged. |

Two things worth knowing:

- **No extra memoization is needed.** The store guarantees a stable reference
  while state is unchanged, which is exactly what `useSyncExternalStore`
  requires to skip a re-render.
- **`getServerSnapshot` is not passed.** The store models a live connection, so
  there is no meaningful server-side snapshot to hand back. Rendering a
  component that calls this hook during SSR will throw — keep it client-side.

## Test

```sh
node --test
```

## License

MIT
