This directory is adapted from the local reference project:
`opencode-bun-native-example/src`.

Copied modules: `identity.ts`, `request.ts`, `sse.ts`, `types.ts`.
`request.ts` clones messages before appending the environment block to avoid modifying callers.
The relay retains the reference project's native Bun fetch headers and request normalization.
It does not read files or execute tool calls; the `read` definition is only passed upstream as metadata.
