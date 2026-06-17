<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Miniapps Boilerplate — Agent Guide

This is a starter template for building [Circles](https://aboutcircles.com) miniapps. A miniapp is a web app that loads inside the Circles host (https://circles.gnosis.io/playground) via an iframe; the host injects a wallet and your app drives interactions through the SDK. The boilerplate ships with the minimum plumbing — wallet provider, sign-in demo, profile lookup, layout — so a developer can clone it and start writing business logic immediately.

## Stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Framework | **Next.js 16** App Router | Turbopack is the default bundler; routes live at top-level `app/`, not `src/app/` |
| Language | **TypeScript 5** | Strict mode on; path alias `@/*` → project root |
| Styling | **Tailwind v4** + **shadcn/ui** | shadcn uses Base UI under the hood (`@base-ui/react`), not Radix. There is no `tailwind.config.js` — theme tokens live in `app/globals.css` under `@theme inline { … }` |
| Package manager | **pnpm** | Lock at `pnpm-lock.yaml`; never mix with npm/yarn |
| Theme | Light only | The `.dark { … }` CSS block and `@custom-variant dark` directive were intentionally removed. Do not add `dark:` Tailwind variants unless the user explicitly asks for dark mode |
| Circles SDKs | `@aboutcircles/miniapp-sdk` + `@aboutcircles/sdk` | See "Working with the Circles SDKs" below |

## Project structure

```
app/
  layout.tsx                    Root: <WalletProvider><AppShell>{children}
  page.tsx                      Dashboard (ConnectionCard + BalancesCard + SignInDemo + NavCards)
  account/page.tsx              requestCreateAccount code sample
  profile/page.tsx              Avatar search + profile lookup
  trust/page.tsx                Trust graph (read) + trust-an-address (write)
  send/page.tsx                 Send Circles via pathfinding (write)
  activity/page.tsx             Enriched transaction history feed (read)
  globals.css                   Tailwind v4 + shadcn tokens (light only)
  icon.svg                      Favicon (Circles brand glyph)
components/
  brand/CirclesLogo.tsx         Inline-SVG brand mark
  layout/
    AppShell.tsx                Grid: header (col-span-full) + sidebar (md+) + main
    Header.tsx                  Logo, current-page crumb, MobileNav, WalletStatus
    Sidebar.tsx                 Desktop nav (md+), driven by lib/nav.ts
    MobileNav.tsx               Hamburger + Sheet drawer (below md)
    CurrentPage.tsx             "/ Dashboard" crumb in header
    NavCards.tsx                Dashboard's link-cards to the sub-pages
    PageNav.tsx                 Prev/next sibling navigation at bottom of sub-pages
  circles/
    TxResult.tsx                Shared write-result UI (pending → hash+explorer → error)
  wallet/
    WalletProvider.tsx          Client context, subscribes to onWalletChange
    WalletStatus.tsx            Badge with shortened address
    ConnectionCard.tsx          Full connection details card
    BalancesCard.tsx            Per-token holdings via getTokenBalances
    CreateAccountDemo.tsx       requestCreateAccount() demo
    SignInDemo.tsx              signMessage() demo
  profile/
    ProfileLookup.tsx           Profile lookup via getProfileView + getProfileByCid
    ProfileSearch.tsx           Directory search via searchProfiles
  trust/
    TrustDemo.tsx               getAggregatedTrustRelations (read) + hubV2.trust (write)
  send/
    SendDemo.tsx                findMaxFlow + TransferBuilder.constructAdvancedTransfer (write)
  activity/
    ActivityFeed.tsx            getTransactionHistoryEnriched with cursor pagination
  ui/                           shadcn primitives — DO NOT hand-edit; regenerate via the CLI
hooks/
  use-wallet.ts                 Re-export of useWallet
lib/
  utils.ts                      cn() + shortenAddress(addr, chars=4)
  circles.ts                    Write pattern: read-only Sdk + encode + submitViaHost + CRC helpers
  nav.ts                        NAV array — single source of truth for the sidebar/drawer/page-nav
next.config.ts                  CSP frame-ancestors header for the Circles playground iframe
```

## Working with the Circles SDKs

There are two packages, and they serve different purposes. Get this wrong and the app will silently misbehave.

### `@aboutcircles/miniapp-sdk` — host bridge

Used for everything that talks to the Circles host (the user's wallet and Safe).

```ts
import {
  onWalletChange,        // (cb: (address: string | null) => void) => unsubscribe
  isMiniappMode,         // () => boolean — true when running inside the host iframe
  requestCreateAccount,  // () => Promise<{ authenticated, address }> — open the host's passkey create/login flow
  sendTransactions,      // (txs: { to, data?, value? }[]) => Promise<string[]>
  signMessage,           // (msg, signatureType?) => Promise<{ signature, verified }>
  onAppData,             // host can pass extra app data via ?data=
} from '@aboutcircles/miniapp-sdk';
```

**Rules:**
- **There is no "Connect" button.** The host pushes the wallet via `onWalletChange`. If you find yourself adding a connect button, you are working around the wrong problem. Outside the host (standalone `pnpm dev`), the callback never fires — the "Not connected" state is *expected*, not a bug.
- **The SDK touches `window` and `parent`.** It must be dynamically imported inside a client component's `useEffect`. **Never** top-level import it from a server component or a top-level module — you will see `window is not defined` at build time. See `WalletProvider.tsx` for the canonical pattern (`import('@aboutcircles/miniapp-sdk').then(({ onWalletChange }) => …)`).
- **`onWalletChange` returns an unsubscribe function.** Capture it and call it in the effect's cleanup, or you will leak subscriptions on hot reload.
- **`requestCreateAccount` is the one proactive connect.** Every other primitive waits for the host to push a wallet; this asks the host to open its passkey create/login popup and resolves once the user has an account (immediately if already connected, rejects on cancel). Call it from a click handler — it needs the user gesture — and pre-load the SDK so the call isn't sitting behind an `await import(...)`. Requires `@aboutcircles/miniapp-sdk@^0.1.44`. See `CreateAccountDemo.tsx`.

### `@aboutcircles/sdk` — read/write Circles data

Used to query the Circles indexer and protocol state (avatars, profiles, balances, trust, transfers).

**For READ operations, use `sdk.rpc.profile.getProfileView(address)`. Do NOT use `sdk.getAvatar(address)`.**

```ts
// ✅ Correct — degrades gracefully for unregistered addresses
const sdk = new Sdk();
const view = await sdk.rpc.profile.getProfileView(address);
// → { avatarInfo?, profile?, trustStats, v2Balance?, v1Balance? }
if (view.avatarInfo) {
  // address is a Circles avatar — render
  if (view.avatarInfo.cidV0) {
    const full = await sdk.rpc.profile.getProfileByCid(view.avatarInfo.cidV0);
    // → richer Profile { name, description, imageUrl, previewImageUrl, location }
  }
} else {
  // not registered — show a friendly message, don't treat as an error
}

// ❌ Wrong — wraps everything in try/catch and throws "Avatar not found"
// even on valid avatars whose on-chain cidV0Digest is empty.
const avatar = await sdk.getAvatar(address);
const profile = await avatar.profile.get();
```

`sdk.getAvatar()` is the right call when you need a write-capable `Avatar` instance to call `trust.add`, `transfer.direct`, `personalToken.mint`, etc. Reserve it for those cases — never for read-only lookups. **In a keyless miniapp those `Avatar` write methods don't apply** (they execute with a signer the app doesn't have): encode the calldata and submit it through the host instead — see *Writing through the host* below.

**Balance formatting:** `view.v2Balance` is already a decimal CRC string (e.g. `"1219.71…"`), **not** atto-CRC. Don't divide it by `1e18`.

### Default RPC endpoint

`new Sdk()` defaults to Gnosis Chain mainnet via `https://rpc.aboutcircles.com/`. No configuration is required for the boilerplate.

### Writing through the host (the two-SDK pattern)

A miniapp holds **no keys** — the host's Safe signs. So the `Avatar` write methods that
*execute* with a contractRunner are not usable here. Instead **encode** calldata with
`@aboutcircles/sdk` and **submit** it through the host with `sendTransactions`:

```ts
import { getSdk, submitViaHost, INDEFINITE_TRUST_EXPIRY } from '@/lib/circles';

const sdk = await getSdk();                                       // read-only Sdk — no signer
const tx = sdk.core.hubV2.trust(addr, INDEFINITE_TRUST_EXPIRY);  // → { to, data, value }
const [hash] = await submitViaHost([tx]);                        // host signs + broadcasts
```

[`lib/circles.ts`](lib/circles.ts) is the home for this pattern:
- `getSdk()` — memoized read-only `new Sdk()`, used for **both** reads (`sdk.rpc.*`) and encoding (`sdk.core.hubV2.*`).
- `submitViaHost(txs)` — maps SDK `{ to, data, value }` to the host's `sendTransactions`.
- `HUB_V2` (Hub v2 address), `INDEFINITE_TRUST_EXPIRY` (max-uint96; `0n` *un*trusts), `toAtto`/`fromAtto`, `explorerTxUrl`.

`sdk.core.hubV2.*` returns each call as a `TransactionRequest` **without executing** (`trust`, `safeTransferFrom`, `personalMint`, …). For transfers routed across the trust graph, use `TransferBuilder.constructAdvancedTransfer(from, to, atto)` from `@aboutcircles/sdk-transfers` (a direct dep) — it runs the pathfinding and returns the `operateFlowMatrix` calldata. See [`TrustDemo.tsx`](components/trust/TrustDemo.tsx) (single call), [`SendDemo.tsx`](components/send/SendDemo.tsx) (pathfinding), and [`TxResult.tsx`](components/circles/TxResult.tsx) (shared result UI).

## Wallet context

[`components/wallet/WalletProvider.tsx`](components/wallet/WalletProvider.tsx) wraps `onWalletChange` in a React context. It is mounted once in [`app/layout.tsx`](app/layout.tsx). Anywhere downstream:

```tsx
'use client';
import { useWallet } from '@/hooks/use-wallet';

const { address, isConnected, isMiniappHost } = useWallet();
```

- `address: string | null` — checksummed or lowercased per the host; treat as opaque
- `isConnected: boolean` — `!!address`
- `isMiniappHost: boolean` — `true` only when running inside the Circles iframe; useful for showing "open in Circles" hints during standalone dev

`useWallet()` must be called from a `'use client'` component.

## Navigation

The sidebar, mobile drawer, current-page crumb, and prev/next page nav are all driven by a single source — [`lib/nav.ts`](lib/nav.ts). To add a route, edit `NAV` and create `app/<route>/page.tsx`. To reorder how prev/next links flow, reorder `NAV`.

```ts
// lib/nav.ts
export const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/account', label: 'Account' },
  { href: '/profile', label: 'Profile' },
  { href: '/trust', label: 'Trust' },
  { href: '/send', label: 'Send' },
  { href: '/activity', label: 'Activity' },
];
```

The dashboard (`/`) intentionally has no `<PageNav />` because [`NavCards`](components/layout/NavCards.tsx) above it serves the same purpose. Sub-pages include `<PageNav />` at the bottom for sequential navigation.

## Styling

- **Tailwind v4.** `app/globals.css` imports `tailwindcss` and `shadcn/tailwind.css` and defines tokens under `@theme inline { … }`. There is no `tailwind.config.js`.
- **shadcn primitives** in `components/ui/`. **Do not hand-edit** them — they are CLI-generated. To update a component, regenerate it with `pnpm dlx shadcn@latest add <name> --overwrite`.
- **shadcn uses Base UI** (`@base-ui/react`), not Radix. Trigger components accept a `render={<Button … />}` prop, not `asChild`. See `MobileNav.tsx` for an example.
- **Light mode only.** The `.dark { … }` CSS block was deleted from `globals.css` and the `@custom-variant dark` directive was removed. Do not write `dark:` variants. To re-enable dark mode, restore both, add `next-themes`, and ship a theme toggle.

## Common workflows

### Add a new route

1. Create `app/<route>/page.tsx`. Server component by default; only add `'use client'` if you use hooks/state/event handlers.
2. Add `{ href: '/<route>', label: '…' }` to `NAV` in `lib/nav.ts`.
3. Add `<PageNav />` at the bottom of the page (after main content). Skip on routes that already have a richer "where to go next" affordance.

### Add a shadcn component

```bash
pnpm dlx shadcn@latest add <name>          # e.g. dialog, tabs, dropdown-menu
```

Components land in `components/ui/`. They use Base UI primitives, not Radix.

### Add a Circles SDK call

1. Read the typed signature in `node_modules/@aboutcircles/sdk/dist/**/*.d.ts` — the bundled JS is minified but the `.d.ts` files are readable.
2. Dynamically import inside a client component's `useEffect`:
   ```ts
   const { Sdk } = await import('@aboutcircles/sdk');
   const sdk = new Sdk();
   const result = await sdk.rpc.<area>.<method>(…);
   ```
3. Handle the unregistered/empty case explicitly; most addresses are not Circles avatars and the SDK signals that with `undefined`, not exceptions (for `getProfileView`).
4. Probe new methods against the live RPC before wiring UI:
   ```bash
   curl -s -X POST https://rpc.aboutcircles.com/ -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"circles_<method>","params":[…]}'
   ```

## Commands

```bash
pnpm dev          # http://localhost:3000
pnpm build        # production build (Turbopack)
pnpm start        # run the built app
pnpm lint         # ESLint (the script is just `eslint`; `next lint` is removed in 16)
```

There is no test suite yet. If you add one, the conventional script name is `pnpm test`.

## Running inside the Circles playground

The host iframes any HTTPS URL pasted into https://circles.gnosis.io/playground. To test:

1. Deploy to Vercel (or any HTTPS host).
2. Open `https://circles.gnosis.io/playground?url=<your-deploy-url>`.
3. The host injects a Safe address. `onWalletChange` fires, the badge flips, `signMessage` and `sendTransactions` start working.

[`next.config.ts`](next.config.ts) ships a `Content-Security-Policy: frame-ancestors 'self' https://circles.gnosis.io https://*.vercel.app;` header so the iframe can load. If you deploy to a different domain, add it to the allowlist.

For permanent marketplace placement, open a PR against [`aboutcircles/CirclesMiniapps`](https://github.com/aboutcircles/CirclesMiniapps) adding an entry to `static/miniapps.json`.

## Gotchas — read before changing things

- **Do not add a "Connect wallet" button.** The host is the wallet UI.
- **Do not top-level import either Circles SDK** from a server component or page file. Always dynamically import inside a client `useEffect`.
- **Do not use `sdk.getAvatar()` for read flows** — use `sdk.rpc.profile.getProfileView()`. The former silently masks errors as "Avatar not found".
- **Do not divide `v2Balance` by `1e18`** — it is already a decimal string.
- **Do not hand-edit `components/ui/*`** — regenerate via the shadcn CLI.
- **Do not add `dark:` Tailwind variants** unless the user explicitly opts into dark mode.
- **Do not edit `next-env.d.ts`** — it is regenerated on every build.
- **Do not run `next lint`** — Next 16 removed that CLI; use the `pnpm lint` script which invokes `eslint` directly.
- **Do not run `pnpm dev` in the background without need.** Stop it when done; orphaned dev servers eat ports and confuse the next run. Use `pkill -f "next dev"` to clean up.
- **Do not commit `.env`** — only `.env.example` is tracked. The `.gitignore` rule `.env*.local` plus `.env` enforces this.
