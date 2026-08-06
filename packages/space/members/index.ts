/**
 * Who is in the space — the half of it that is not any extension's business,
 * and that knows nothing about extensions in return.
 *
 * `types` holds the shape; `list` maintains the connection list; `identity`
 * answers "new person, or the same person's second device?"; `presence`
 * handles active/away and the per-person view.
 */
export * from './identity.ts';
export * from './list.ts';
export * from './presence.ts';
export * from './types.ts';
