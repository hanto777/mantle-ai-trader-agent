# Mantle AI Trader

A clean starter project for a crypto trading dashboard UI with a Python FastAPI backend.

## Structure

- `frontend/`: React + TypeScript + Vite + Tailwind CSS
- `backend/`: Python + FastAPI

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
- The backend exposes `GET /api/billing/status` as an architectural placeholder.
- The current MVP does not automatically consume credits and does not block Gemini analysis.

Demo Mantle Sepolia vault:

```text
AnalysisCreditVault=0x58423C0BEF508aDD4F7C9CaaE34366780FD3A28d
```

Important constraints:

- This is only for Mantle Sepolia testnet.
- Do not use real funds.
- This is not production custody.
- `TradeSignalRegistry` is unchanged.
- Existing Gemini analysis, paper trading, and on-chain signal recording remain separate from billing.

Future production flow:

```text
wallet signature -> backend verifies user -> backend checks credits -> Gemini request -> consume credit
```

The backend should only call `consumeCredit(address user, uint256 amount)` after it verifies the signed wallet identity, confirms the user has enough credits, and completes the Gemini request flow.

## API

- `GET /health` returns `{ "ok": true }`
- `GET /api/billing/status` returns demo billing metadata for the future credit-gated AI analysis flow.
