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

This branch adds a testnet-only demo credit system for protecting Gemini analysis from unlimited free usage.

- Users deposit Mantle Sepolia test MNT into `AnalysisCreditVault`.
- The vault converts test MNT deposits into AI analysis credits.
- The frontend can display a connected wallet's credit balance and start a test deposit flow.
- The backend exposes `GET /api/billing/status` for billing policy and contract metadata.
- `POST /api/ai/analyze` requires a wallet signature and enough AI credits.
- After a successful Gemini response, the backend calls `consumeCredit` on `AnalysisCreditVault`.

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

## Supported Markets

The app currently supports credit-gated AI analysis for:

- `MNT/USDT`
- `BTC/USDT`
- `ETH/USDT`
- `SOL/USDT`
- `ARB/USDT`
- `OP/USDT`

Each `Analyze Now` request costs `1` demo AI credit across all supported pairs. The signed wallet message includes the selected symbol, so the backend verifies both user identity and the market being analyzed before spending a credit.

## Roadmap

### Phase 1: MVP terminal

- Live spot candles
- Gemini BUY/HOLD analysis
- Paper trading agent
- On-chain signal recording
- Mantle Sepolia AI credits
- Credit-gated analysis requests
- Multi-pair market selector

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

Mantle AI Trader turns AI market analysis into a credit-gated on-chain product. Instead of offering unlimited free Gemini calls, users deposit Mantle Sepolia test MNT into `AnalysisCreditVault` to receive AI credits. They choose a market pair, sign a wallet authorization, spend credits for an AI analysis, and can publish the resulting signal to `TradeSignalRegistry` on Mantle Sepolia.

The project demonstrates a practical web3 business model for AI apps: wallet identity, prepaid credits, backend API protection, and public on-chain receipts for generated signals. The current demo uses testnet funds only and is designed as a foundation for verifiable signal performance, trader reputation, and future AI strategy marketplaces.
