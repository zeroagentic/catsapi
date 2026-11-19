# CatsApi — Agent ID Gated NFT & AI API Pass on BNB Smart Chain

CatsApi is an ERC-721 collection on **BNB Smart Chain** where minting is gated by
**Agent ID** (the on-chain identity of a Binance Agentic Wallet, issued via SPACE ID)
and each NFT works as an **AI API access pass**: holding a cat unlocks a monthly LLM
API token quota that scales with the NFT's rarity tier.

**Live contract (BNB Chain mainnet):**
[`0x39666Ccf900f0213cEF6FaE28537532c9B0E75C9`](https://bscscan.com/address/0x39666Ccf900f0213cEF6FaE28537532c9B0E75C9)
— source code verified on BscScan.

**Website / mint page:** GitHub Pages site in this repo (`index.html`).

Built for the **Binance Wallet Agent ID Hackathon** (2026).

## How Agent ID is used (core, not an add-on)

Agent ID registry (BNB Chain): `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`
("SPACE ID Agent ID", symbol `AI`, ERC-721, non-transferable).

1. **Mint gate (on-chain).** `AgentGatedNFT.mint()` calls `hasAgentId(msg.sender)`,
   which reads `registry.balanceOf(sender) > 0`. While `requireAgentId` is on,
   an address without an Agent ID cannot mint — the transaction reverts with
   `"Agent ID required"`.
2. **Free-mint entitlement (on-chain).** `quote(wallet, qty)` grants a free slot
   only to Agent ID holders: **1 free mint per wallet**, from a global free pool
   of 1,500 (of 2,500 total supply). Extra mints cost 0.001 BNB each, max 5 per wallet.
   The mint price is always read from `quote()` — the frontend never hardcodes it,
   and `mint()` requires `msg.value` to equal the quote exactly.
3. **Utility gate (gateway).** Each NFT carries a `Tier` trait and an
   `API Quota / Month` trait. The API gateway verifies `balanceOf(holder)` for
   CatsApi on BSC before issuing or refreshing an API key, and meters usage
   against the summed quota of the NFTs held.

Don't have an Agent ID yet? Claim one in the Binance App:
**Wallet → homepage banner → Agent ID** (one per user, non-transferable, `name.ai`).

## Collection

| Item | Value |
| --- | --- |
| Name / Symbol | CatsApi / CATS |
| Max supply | 2,500 |
| Free pool | First 1,500 mints can use the free slot (1 free per Agent ID wallet) |
| Paid price | 0.001 BNB per NFT after the free slot |
| Max per wallet | 5 |
| Royalty | ERC-2981, 5% to the contract owner |
| Mint state | Opened by the owner via `setMintOpen(true)` |

### Tiers & monthly API quota (per NFT, stacking)

| Tier | Count | Share | API quota / month |
| --- | ---: | ---: | ---: |
| Common | 1,425 | 57.0% | 500K tokens |
| Rare | 675 | 27.0% | 1M tokens |
| Epic | 300 | 12.0% | 5M tokens |
| Legendary | 90 | 3.6% | 20M tokens |
| Mythic | 10 | 0.4% | 50M tokens |

Artwork is one image per tier (a cat AI-agent operator). Metadata is one JSON per
token (`metadata-sample/` shows the shape); the tier assignment is shuffled with a
seeded PRNG and its provenance SHA-256 is
`5b044f8a817222b31f8f87a4589b9cbcfca1cc33dacbaafd1e1dc6ca147a777f`.
Before `reveal()`, every token shows the `hidden.json` placeholder metadata.

## Owner permissions (full disclosure)

The contract is `Ownable`. The owner (the deployer wallet) can:

- `setMintOpen(bool)` — open/close minting.
- `setRequireAgentId(bool)` — turn the Agent ID gate on/off.
- `setRegistry(address)` — point the gate at a different Agent ID registry.
- `setBaseURI(string)` / `setPlaceholderURI(string)` — update metadata URIs.
- `reveal()` — one-way switch from placeholder metadata to the real base URI.
- `setRoyalty(receiver, feeBps)` — change the ERC-2981 default royalty.
- `withdraw(to)` — withdraw BNB proceeds held by the contract.

The owner **cannot**: mint beyond the 2,500 cap, change the price/free-pool
constants (they are `constant` in the source), pause or freeze user tokens,
force transfers of user NFTs, or charge any tax. There are no approvals in the
mint flow at all — minting is a single payable call with the exact quoted value.

## Safety & compliance notes

- No QR-code or pairing-code login. The site uses a standard injected-wallet
  connection; every transaction is shown and confirmed by the user in their own wallet.
- The project never asks for seed phrases, private keys, API secrets, or pairing codes.
- CatsApi is an independent project. It is not affiliated with, endorsed by, or
  impersonating Binance or BNB Chain; those names are used only to describe the
  network and the Agent ID system the contract integrates with.
- An NFT here is a digital collectible and an API access pass. Nothing on this
  page is a promise of financial return.

## API gateway (live MVP)

The collection's utility layer is built and running — see [`gateway/`](gateway/README.md).
CatsApi holders sign a message (no transaction), the gateway verifies ownership
on-chain, issues an API key, and meters a monthly LLM token quota per tier.
Live endpoint: https://77eef9451ea736.app.lhr.life (tunnel URL — rotates on
reconnect; the website's gateway section carries the current one).

## Run it locally

```bash
npm install
npx hardhat test     # 8 tests: gate, free/paid quote, caps, reveal, withdraw
npx hardhat compile
```

Deploy (mainnet registry is the default on chain 56; see `.env.example`):

```bash
cp .env.example .env   # fill in locally, never commit
npm run deploy:bsc     # if defined, otherwise: npx hardhat run scripts/deploy.js --network bsc
```

## Repo layout

```
contracts/AgentGatedNFT.sol   the collection (the deployed, verified source)
contracts/mocks/              MockAgentId for local/testnet work
test/                         Hardhat test suite
scripts/deploy.js             deployment script
index.html                    the public website + mint page (GitHub Pages)
frontend/index.html           same mint page, kept with the project sources
assets/                       tier artwork (also pinned on IPFS)
metadata-sample/              example token metadata (1.json, hidden.json)
```

## License

MIT — see `LICENSE`. The contract builds on OpenZeppelin Contracts (MIT).
