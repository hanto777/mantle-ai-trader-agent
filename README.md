# Mantle AI Trader

Mantle AI Trader is a credit-gated AI signal terminal for crypto markets. Users select a trading pair, spend Mantle Sepolia demo credits for a Gemini-powered market read, and can record selected AI signals on-chain as public trading receipts.

## Structure

- `frontend/`: React + TypeScript + Vite + Tailwind CSS
- `backend/`: Python + FastAPI
- `contracts/`: Mantle Sepolia demo smart contracts

## Local setup

### Backend

```bash
cd backend
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --host 127.0.0.0 --port 8000
```

Use `backend/.env.example` as a template and add `ALLOWED_ORIGINS` if you need custom allowed origins.

### Frontend

```bash
cd frontend
npm install
npm run dev -- --host 0.0.0.0 --port 5173
```

Use `frontend/.env.example` to set `VITE_API_BASE_URL` for the backend.

## Deployment

### Backend on Render

1. Create a new Python web service in Render.
2. Set the root directory to `backend`.
3. Use the start command:

```bash
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

4. Add environment variables on Render:
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL=gemini-2.5-flash`
   - `TRADING_SYMBOL=MNT/USDT`
   - `TRADING_TIMEFRAME=1h`
   - `ALLOWED_ORIGINS` (for example `https://your-frontend-url.vercel.app,https://localhost:5173`)

5. Render will install dependencies from `requirements.txt` automatically.

### Frontend on Vercel

1. Create a new project in Vercel and point it to the frontend folder.
2. Set the project root to `frontend`.
3. Use the build command:

```bash
npm install && npm run build
```

4. Set the output directory to `dist`.
5. Add environment variables:
   - `VITE_API_BASE_URL=https://your-backend-url.onrender.com`

## Verified contract

- `TradeSignalRegistry` verified contract: https://sepolia.mantlescan.xyz/address/0x9Fa694367e58eB96cEB29aCF653d5880f843070D#code

## Business Model

Mantle AI Trader uses prepaid AI credits to turn expensive, decision-ready market intelligence into an on-chain product.

- Users deposit Mantle Sepolia test MNT into `AnalysisCreditVault`.
- The vault converts test MNT deposits into AI analysis credits.
- Each fresh analysis requires a wallet signature and costs an explicit number of credits.
- After a successful Gemini response, the backend calls `consumeCredit` on `AnalysisCreditVault`.
- Read-only DEX route comparison remains available as the execution-intelligence layer after analysis.

### Why users buy credits

A credit does not pay for a generic chatbot answer. It pays for a decision package that combines:

- Live market candles and multi-timeframe `1H / 1D` context.
- RSI, MACD, Stochastic, volume, support, and resistance analysis.
- An explainable `BUY` or `HOLD` decision with confidence and reasoning.
- Real Mantle mainnet quote comparison across OpenOcean, Merchant Moe, Agni, and Uniswap V3.
- A selected route, slippage configuration, minimum-received preview, and safety warnings.
- The option to record the resulting signal on-chain as a public receipt.

The user saves the time and complexity of separately reading charts, comparing indicators, checking DEX liquidity, and calculating execution risk. Future credit tiers can monetize deeper scans, portfolio analysis, recurring agent monitoring, and premium strategy access.

Demo Mantle Sepolia vault:

```text
AnalysisCreditVault=0x58423C0BEF508aDD4F7C9CaaE34366780FD3A28d
```

Important constraints:

- This is only for Mantle Sepolia testnet.
- Do not use real funds.
- This is not production custody.
- `TradeSignalRegistry` is unchanged.
- Paper trading and on-chain signal recording remain separate from billing.

Current credit-gated analysis flow:

```text
wallet signature -> backend verifies user -> backend checks credits -> Gemini request -> consume credit
```

Backend deployment requirements:

- `ANALYSIS_CREDIT_VAULT_ADDRESS`
- `ANALYSIS_CREDIT_REQUIRED=1`
- `MANTLE_SEPOLIA_RPC_URL=https://rpc.sepolia.mantle.xyz`
- `MANTLE_SEPOLIA_CHAIN_ID=5003`
- `BILLING_OWNER_PRIVATE_KEY`

`BILLING_OWNER_PRIVATE_KEY` must belong to the current `AnalysisCreditVault.owner()` account, or ownership must be transferred to a dedicated backend billing signer. Use a dedicated testnet-only signer. Do not put a real-money wallet private key in backend environment variables.

## API

- `GET /health` returns `{ "ok": true }`
- `GET /api/billing/status` returns billing metadata for the credit-gated AI analysis flow.
- `GET /api/portfolio/markets?ids=mantle,bitcoin` returns current CoinGecko prices for the manual investment portfolio.
- `GET /api/dex/quotes?symbol=MNT/USDT&amount_in=100` returns a read-only Mantle mainnet route preview.

The DEX quote preview never returns approval or transaction calldata and cannot submit a swap. It compares a live OpenOcean aggregate quote with direct read-only contract quotes from Merchant Moe, Agni, and Uniswap V3. The configured input asset is Mantle's bridged legacy USDT contract, not USDT0.

## Supported Markets

The market selector loads active Bybit spot `TOKEN/USDT` pairs and supports searchable
single-pair analysis. The selected pair receives live candles and is sent to Gemini only
when the user explicitly requests an analysis.

Each `Analyze Now` request costs `1` demo AI credit across supported Bybit USDT spot
pairs. The signed wallet message includes the selected symbol, so the backend verifies
both user identity and the market being analyzed before spending a credit.

The read-only Mantle DEX route terminal remains limited to `MNT/USDT`.

## Roadmap

### Phase 1: MVP terminal

- Live spot candles
- Explainable Gemini BUY/HOLD analysis
- RSI, MACD, and Stochastic across `1H / 1D`
- Paper trading agent
- On-chain signal recording
- Mantle Sepolia AI credits
- Credit-gated analysis requests
- Multi-pair market selector
- Read-only Mantle DEX route comparison
- OpenOcean, Merchant Moe, Agni, and Uniswap V3 quotes
- DEX selection, BUY/SELL setup preview, slippage, and minimum received
- Manual investment portfolio with browser-local positions, live CoinGecko valuation, 24h change, and PnL

### Phase 2: Verifiable performance

- Track signal outcome after fixed windows
- Calculate PnL per recorded signal
- Add wallet-level win rate and average return
- Show verified signal history per user
- Add leaderboard for best signal records

### Phase 3: Productized credit tiers

- 1 credit: single-pair quick read
- 3 credits: multi-timeframe analysis
- 5 credits: portfolio scan
- Optional agent mode with recurring credit budget

### Phase 4: Agent marketplace

- User-created AI strategies
- Public strategy pages
- Strategy subscriptions paid in credits
- On-chain reputation for agents and signal authors

## Hackathon Description

Mantle AI Trader is a hybrid AI trading terminal and Mantle DEX intelligence aggregator. It helps a user answer two questions in one workflow: **should I trade this market, and where can I get the best execution?**

The user selects a market, signs a wallet authorization, and spends an on-chain AI credit for an explainable multi-timeframe analysis. Gemini combines chart structure, support and resistance, volume, RSI, MACD, and Stochastic across `1H` and `1D` to return a `BUY` or `HOLD` decision with confidence and readable reasoning.

After the analysis, the terminal compares real read-only Mantle mainnet quotes from OpenOcean, Merchant Moe, Agni, and Uniswap V3. The user can select a DEX route and prepare a BUY or SELL setup with configurable slippage and minimum-received protection. Transaction creation, approvals, signatures, and swaps remain disabled in the current safety-first prototype.

The business model is prepaid decision intelligence. Users buy credits because each analysis replaces several manual tasks: technical analysis, timeframe synthesis, DEX discovery, liquidity comparison, and execution-risk preparation. Credits protect the AI backend from unlimited usage while creating a transparent web3 payment flow tied to wallet identity.

Mantle AI Trader currently demonstrates:

- Mantle Sepolia credit deposits and on-chain credit consumption.
- Wallet-authenticated, credit-gated Gemini analysis.
- Explainable `1H / 1D` indicator reasoning.
- Read-only Mantle mainnet DEX aggregation and direct contract quotes.
- On-chain signal receipts through `TradeSignalRegistry`.
- A foundation for future user-confirmed swaps, verifiable strategy performance, recurring AI agents, and a strategy marketplace.

The prototype uses testnet funds for billing and never executes a real trade.

## ERC-8004 Identity Preparation

Mantle AI Trader has a draft ERC-8004 registration file at:

```text
https://raw.githubusercontent.com/hanto777/mantle-ai-trader-agent/main/frontend/public/erc-8004-agent.json
```

The registration target is the canonical Identity Registry on Mantle Sepolia only:

```text
chainId=5003
IdentityRegistry=0x8004A818BFB912233c491871b3d84c89A494BD9e
```

Prepare and simulate the `register(agentURI)` call without sending a transaction:

```powershell
cd frontend
$env:ERC8004_OWNER_ADDRESS="0xYourMantleSepoliaWallet"
npm run erc8004:prepare
```

The script is read-only: it checks the chain and registry bytecode, simulates the call,
estimates gas, and prints calldata. It contains no signer and cannot send a transaction.

The initial registration file intentionally has an empty `registrations` array because
the `agentId` is assigned during minting. After registration, add the resulting `agentId`
and `eip155:5003:0x8004A818BFB912233c491871b3d84c89A494BD9e` registry identifier.

Do not submit the registration transaction until the hackathon organizers confirm whether
canonical Mantle Sepolia registration satisfies the identity requirement or whether they
issue a separate official identity NFT.
