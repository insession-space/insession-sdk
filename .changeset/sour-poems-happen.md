---
'@insession/space-state': patch
---

Drop the separate `@insession/space-state-react` package and document the React
binding here instead.

`getState` / `subscribe` already satisfy the `useSyncExternalStore` contract, so
the binding was one line with no logic of its own — and no version of it ever
carried a change of its own, it only tracked this package's numbering. The README
now has a **Binding it to React** section with that line, including why no
`getServerSnapshot` default is shipped.

Nothing in this package's runtime changed. Consumers of
`@insession/space-state-react` can keep using the published `0.2.1` or copy the
hook into their own codebase.
