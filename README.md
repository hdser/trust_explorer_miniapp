# Trust Explorer

A [Circles](https://aboutcircles.com) mini-app that turns the Circles trust graph into an interactive map.
Open it inside the Circles wallet and it centers on your avatar — explore your trust neighbourhood, the whole
network, or the invitation graph; send or convert tokens along trust paths; and color the map by avatar type
or group membership.

**Client-only — no backend, no indexer.** Every read is a keyless JSON-RPC call to the public Circles RPC
(`https://rpc.aboutcircles.com/`). The graph is rendered with `cosmos.gl` (GPU force-directed layout).

## Features

- **My Network** — your 1-hop trust neighbourhood; tap any avatar to grow the map outward (new avatars pop in).
- **Circles Network** — the whole global trust graph (opt-in; paged from the RPC, ~5k avatars).
- **Invitation Graph** — who invited whom across Circles.
- **Send or convert** — pay anyone along trust paths with selectable send/receive tokens, or convert your own
  token A → B. The route lights up on the map with max-flow amount + hop count; execution is signed by the host.
- **Activity & flow replay** — your transaction history, and a replay of how a past payment actually moved.
- **Color by type or group** — color avatars by human/org/group, or pick a few Circles groups and light up
  their members (everyone else dims).
- Loaded graphs **and** their settled layouts are cached per view, so switching is instant; a refresh re-pages.

## Tech

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind · `cosmos.gl` · `@aboutcircles/miniapp-sdk` ·
`@aboutcircles/sdk-transfers`. All data via the public RPC.

## Local development

```bash
pnpm install
pnpm dev
```

Outside the Circles host the wallet SDK can't connect (`onWalletChange` never fires), so pass a debug avatar to
exercise the map:

```
http://localhost:3000/?debugAddress=0xde374ece6fa50e781e81aac78e811b33d16912c7
```

This renders everything that is pure data + graph: the maps, expand, coloring, and the route/convert *previews*.
The real wallet connection and on-chain send/convert only run **embedded** (see below).

## Testing the wallet connection (embedded)

The app uses `@aboutcircles/miniapp-sdk` — `isMiniappMode()` to detect the host and `onWalletChange()` for the
connected avatar — so the real wallet and host-signed transactions only work when the app runs **inside a
Circles host**:

- Deploy to an HTTPS URL (below) and open it in the Circles playground / Metri mini-app tester.
- For local iteration against a real wallet, expose your dev server over HTTPS with a tunnel
  (`cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`) and load that URL in the host —
  `isMiniappMode()` becomes `true`, `onWalletChange` fires, and you can sign.

## Deploy

Push to GitHub and import the repo into Vercel (standard Next.js build). `next.config.ts` sets
`Content-Security-Policy: frame-ancestors 'self' https://*.gnosis.io https://*.vercel.app`, so the app embeds in
the Circles host and in Vercel preview deploys. Every push gets a `*.vercel.app` preview URL you can embed-test
before promoting to production.

## Register in the Garage

1. Create a builder profile: https://garage.aboutcircles.com/signup
2. Register the app: https://garage.aboutcircles.com/register — fields: **Name, Pitch, Live URL, Repo, README**.
3. See https://garage.aboutcircles.com/rules for the current requirements and the weekly (Sunday) deadline.

The source of truth for the SDK, primitives, and protocol is https://docs.aboutcircles.com.
