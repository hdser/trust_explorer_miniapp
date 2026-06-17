# CLAUDE.md

The canonical project guide for any AI coding assistant lives in [AGENTS.md](AGENTS.md). It covers the stack, SDK rules, navigation pattern, styling conventions, common workflows, and the full list of gotchas. Read it before changing anything.

@AGENTS.md

## Claude Code workflow tips

Notes specific to working in this repo through Claude Code. The substantive project rules are in AGENTS.md above — these are about *how* to navigate the codebase efficiently.

### Look up SDK shapes from `node_modules`, not memory

Both Circles SDKs (`@aboutcircles/miniapp-sdk` and `@aboutcircles/sdk`) are young and absent from most training data. Before guessing an API:

```bash
# Surface-level exports
cat node_modules/@aboutcircles/miniapp-sdk/dist/index.d.ts
cat node_modules/@aboutcircles/sdk/dist/index.d.ts

# Deeper types (pnpm flattens these under .pnpm/)
find node_modules/.pnpm -path "*@aboutcircles+sdk-*/dist/**/*.d.ts"
```

The bundled `index.js` is minified but readable enough to confirm runtime behavior (search for the error string a user reports — that tells you which branch they hit).

### Probe the live RPC before writing UI

The Circles indexer is at `https://rpc.aboutcircles.com/`. For any new query, hit it directly first so you know the response shape:

```bash
curl -s -X POST https://rpc.aboutcircles.com/ -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"circles_getProfileView","params":["0x…"]}'
```

This catches case-sensitivity, optional fields, and "what does an unregistered address look like" surprises before they become bugs in the React component.

### Test SDK calls in Node before plumbing into React

When debugging a runtime issue, a one-off `.mjs` in the project root is faster than reloading the dev server:

```bash
cat > /tmp/probe.mjs <<'EOF'
import { Sdk } from '@aboutcircles/sdk';
const sdk = new Sdk();
console.log(await sdk.rpc.profile.getProfileView('0x…'));
EOF
# Run from the project root so node resolves the package
cp /tmp/probe.mjs ./probe.mjs && node probe.mjs && rm probe.mjs
```

### Useful subagents

- **Explore** — for codebase searches that span multiple files (e.g. "where is X used", "what does the SDK do on disconnect"). Faster than running `grep`/`find` directly when the answer requires reading several files.
- **Plan** — for non-trivial feature work. Have it produce the implementation plan before touching files.

### Verification checklist before declaring "done"

1. `pnpm lint` — clean
2. `pnpm build` — succeeds and all expected routes appear in the prerender list
3. `pnpm dev` then `curl -s -D - http://localhost:3000/` — verify the CSP `frame-ancestors` header is present and the home page renders the wallet badge
4. Kill the dev server before ending the task (`pkill -f "next dev"`) — orphan processes hold port 3000 across sessions

### What to add to memory vs. AGENTS.md

If you learn something **about this codebase** that future-you would want to know — a convention, a non-obvious file relationship, a gotcha — put it in **AGENTS.md** so every assistant working in this repo sees it.

Reserve **memory** for facts about the **user** (their role, preferences, what they've corrected) or **cross-project** patterns. A Circles-specific gotcha is project context, not user context.
