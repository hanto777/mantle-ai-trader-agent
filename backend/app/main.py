import os
import asyncio
import json
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Literal, Optional
from enum import Enum

import ccxt
from fastapi import FastAPI, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import io
import matplotlib
matplotlib.use("Agg")

import pandas as pd
import mplfinance as mpf

from pydantic import BaseModel, Field
from .dex_quotes import get_read_only_quotes

try:
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

try:
    from eth_account import Account
    from eth_account.messages import encode_defunct
    from web3 import Web3
except Exception:
    Account = None
    encode_defunct = None
    Web3 = None

try:
    from google import genai
    from google.genai import types
except Exception:
    genai = None
    types = None

load_dotenv()

app = FastAPI(title="Mantle AI Trader Backend")

allowed_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
for origin in os.getenv("ALLOWED_ORIGINS", "").split(","):
    origin = origin.strip()
    if origin:
        allowed_origins.append(origin)
allowed_origins = list(dict.fromkeys(allowed_origins))

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


# ===== Models =====

class TradeStatus(str, Enum):
    OPEN = "open"
    CLOSED = "closed"


class Trade(BaseModel):
    id: int
    entry_price: float
    entry_time: str
    take_profit_price: float
    stop_loss_price: float
    current_price: Optional[float] = None
    quantity: float
    usdt_used: float
    status: TradeStatus = TradeStatus.OPEN
    close_price: Optional[float] = None
    close_time: Optional[str] = None
    pnl_usdt: Optional[float] = None
    pnl_percent: Optional[float] = None
    close_reason: Optional[str] = None


class PaperAccount(BaseModel):
    usdt_balance: float = 10000.0
    mnt_held: float = 0.0
    equity: float = 10000.0
    open_trade: Optional[Trade] = None
    trades_history: list[Trade] = Field(default_factory=list)
    last_analyzed_timestamp: Optional[int] = None
    last_analysis: Optional[dict] = None
    agent_running: bool = False
    cooldown_remaining: int = 0
    last_hold_reason: Optional[str] = None


class AgentStatusResponse(BaseModel):
    running: bool
    account: PaperAccount


class AIResponseModel(BaseModel):
    action: Literal["BUY", "HOLD"]
    support_price: float = Field(..., gt=0)
    resistance_price: float = Field(..., gt=0)
    confidence: float = Field(..., ge=0.0, le=1.0)
    reason: str
    indicators: Optional[dict] = None


class AnalyzeRequest(BaseModel):
    symbol: str
    wallet_address: str
    signature: str
    nonce: str
    message: Optional[str] = None


# ===== Global State =====

account = PaperAccount()
agent_task: Optional[asyncio.Task] = None
used_billing_nonces: set[str] = set()
SUPPORTED_SYMBOLS = {
    "MNT/USDT",
    "BTC/USDT",
    "ETH/USDT",
    "SOL/USDT",
    "ARB/USDT",
    "OP/USDT",
}

ANALYSIS_CREDIT_VAULT_ABI = [
    {
        "inputs": [{"internalType": "address", "name": "user", "type": "address"}],
        "name": "creditsOf",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"internalType": "address", "name": "user", "type": "address"},
            {"internalType": "uint256", "name": "amount", "type": "uint256"},
        ],
        "name": "consumeCredit",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "owner",
        "outputs": [{"internalType": "address", "name": "", "type": "address"}],
        "stateMutability": "view",
        "type": "function",
    },
]


# ===== Utility Functions =====

PORTFOLIO_ASSETS = {
    "mantle": {"symbol": "MNT", "name": "Mantle", "exchange_symbol": "MNT/USDT"},
    "bitcoin": {"symbol": "BTC", "name": "Bitcoin", "exchange_symbol": "BTC/USDT"},
    "ethereum": {"symbol": "ETH", "name": "Ethereum", "exchange_symbol": "ETH/USDT"},
    "solana": {"symbol": "SOL", "name": "Solana", "exchange_symbol": "SOL/USDT"},
    "arbitrum": {"symbol": "ARB", "name": "Arbitrum", "exchange_symbol": "ARB/USDT"},
    "optimism": {"symbol": "OP", "name": "Optimism", "exchange_symbol": "OP/USDT"},
    "morpho": {"symbol": "MORPHO", "name": "Morpho", "exchange_symbol": "MORPHO/USDT"},
    "gmx": {"symbol": "GMX", "name": "GMX", "exchange_symbol": "GMX/USDT"},
    "lido-dao": {"symbol": "LDO", "name": "Lido DAO", "exchange_symbol": "LDO/USDT"},
    "aptos": {"symbol": "APT", "name": "Aptos", "exchange_symbol": "APT/USDT"},
}
portfolio_market_cache: dict[str, dict] = {}


def fetch_portfolio_market_data(asset_ids: list[str]) -> list[dict]:
    query = urllib.parse.urlencode({
        "ids": ",".join(asset_ids),
        "vs_currencies": "usd",
        "include_24hr_change": "true",
        "include_last_updated_at": "true",
    })
    request = urllib.request.Request(
        f"https://api.coingecko.com/api/v3/simple/price?{query}",
        headers={"Accept": "application/json", "User-Agent": "Mantle-AI-Trader/1.0"},
    )
    demo_key = os.getenv("COINGECKO_DEMO_API_KEY")
    if demo_key:
        request.add_header("x-cg-demo-api-key", demo_key)

    with urllib.request.urlopen(request, timeout=12) as response:
        prices = json.loads(response.read().decode("utf-8"))

    return [
        {
            "id": asset_id,
            "symbol": PORTFOLIO_ASSETS[asset_id]["symbol"],
            "name": PORTFOLIO_ASSETS[asset_id]["name"],
            "price_usd": float(prices.get(asset_id, {}).get("usd", 0)),
            "change_24h_percent": float(prices.get(asset_id, {}).get("usd_24h_change") or 0),
            "last_updated_at": prices.get(asset_id, {}).get("last_updated_at"),
        }
        for asset_id in asset_ids
    ]


def fetch_portfolio_defillama_fallback(asset_ids: list[str]) -> list[dict]:
    coin_keys = ",".join(f"coingecko:{asset_id}" for asset_id in asset_ids)
    request = urllib.request.Request(
        f"https://coins.llama.fi/prices/current/{coin_keys}",
        headers={"Accept": "application/json", "User-Agent": "Mantle-AI-Trader/1.0"},
    )
    with urllib.request.urlopen(request, timeout=12) as response:
        prices = json.loads(response.read().decode("utf-8")).get("coins", {})

    assets = []
    for asset_id in asset_ids:
        asset = PORTFOLIO_ASSETS[asset_id]
        price_data = prices.get(f"coingecko:{asset_id}", {})
        if not price_data.get("price"):
            raise ValueError(f"DefiLlama price unavailable for {asset_id}")
        cached = portfolio_market_cache.get(asset_id, {})
        assets.append({
            "id": asset_id,
            "symbol": asset["symbol"],
            "name": asset["name"],
            "price_usd": float(price_data["price"]),
            "change_24h_percent": float(cached.get("change_24h_percent") or 0),
            "last_updated_at": price_data.get("timestamp"),
        })
    return assets


def cache_portfolio_assets(assets: list[dict]) -> None:
    for asset in assets:
        portfolio_market_cache[asset["id"]] = dict(asset)


def get_cached_portfolio_assets(asset_ids: list[str]) -> list[dict]:
    if not all(asset_id in portfolio_market_cache for asset_id in asset_ids):
        raise ValueError("No complete cached portfolio price snapshot")
    return [dict(portfolio_market_cache[asset_id]) for asset_id in asset_ids]


async def get_latest_price(symbol: str) -> float:
    exchange = ccxt.bybit({"enableRateLimit": True})
    exchange.options["defaultType"] = "spot"
    try:
        ticker = await run_in_threadpool(exchange.fetch_ticker, symbol)
        return float(ticker["last"])
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch price: {e}")


def normalize_confidence(value: float) -> float:
    """Normalize confidence to 0.0-1.0 range.
    - If 0 <= value <= 1: return as-is
    - If 1 < value <= 100: divide by 100
    - Otherwise: raise ValueError
    """
    if isinstance(value, (int, float)):
        if 0 <= value <= 1:
            return float(value)
        elif 1 < value <= 100:
            return float(value) / 100.0
    raise ValueError(f"Confidence {value} must be 0.0-1.0 or 0-100, not {value}")


def normalize_gemini_response(parsed: dict) -> dict:
    """Normalize Gemini response before Pydantic validation."""
    if "confidence" in parsed and isinstance(parsed["confidence"], (int, float)):
        try:
            parsed["confidence"] = normalize_confidence(parsed["confidence"])
        except ValueError as e:
            raise ValueError(f"Invalid confidence in Gemini response: {e}")
    return parsed


def get_credit_required() -> int:
    return int(os.getenv("ANALYSIS_CREDIT_REQUIRED", "1"))


def get_credit_vault_address() -> str:
    return os.getenv(
        "ANALYSIS_CREDIT_VAULT_ADDRESS",
        "0x58423C0BEF508aDD4F7C9CaaE34366780FD3A28d",
    )


def normalize_symbol(symbol: str) -> str:
    normalized = symbol.strip().upper()
    if normalized not in SUPPORTED_SYMBOLS:
        raise HTTPException(status_code=400, detail=f"Unsupported symbol: {symbol}")
    return normalized


def build_analysis_auth_message(wallet_address: str, amount: int, nonce: str, symbol: str) -> str:
    return (
        "Mantle AI Trader\n"
        "Authorize AI analysis credit spend\n"
        f"Wallet: {wallet_address}\n"
        f"Symbol: {symbol}\n"
        f"Credits: {amount}\n"
        f"Vault: {get_credit_vault_address()}\n"
        "Network: Mantle Sepolia\n"
        f"Nonce: {nonce}"
    )


def get_billing_contract():
    if Web3 is None:
        raise HTTPException(status_code=500, detail="web3 SDK not available")

    rpc_url = os.getenv("MANTLE_SEPOLIA_RPC_URL", "https://rpc.sepolia.mantle.xyz")
    vault_address = get_credit_vault_address()
    if not vault_address:
        raise HTTPException(status_code=500, detail="ANALYSIS_CREDIT_VAULT_ADDRESS not configured")

    web3 = Web3(Web3.HTTPProvider(rpc_url))
    if not web3.is_connected():
        raise HTTPException(status_code=502, detail="Failed to connect to Mantle Sepolia RPC")

    return web3, web3.eth.contract(
        address=web3.to_checksum_address(vault_address),
        abi=ANALYSIS_CREDIT_VAULT_ABI,
    )


def verify_analysis_signature(wallet_address: str, signature: str, nonce: str, amount: int, symbol: str, signed_message: Optional[str] = None) -> str:
    if Account is None or encode_defunct is None or Web3 is None:
        raise HTTPException(status_code=500, detail="eth-account SDK not available")

    try:
        checksum_wallet = Web3.to_checksum_address(wallet_address)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid wallet address")

    message = signed_message or build_analysis_auth_message(checksum_wallet, amount, nonce, symbol)
    expected_fields = {
        "Wallet": checksum_wallet,
        "Symbol": symbol,
        "Credits": str(amount),
        "Vault": get_credit_vault_address(),
        "Network": "Mantle Sepolia",
        "Nonce": nonce,
    }
    parsed_fields = {}
    for line in message.splitlines():
        if ": " not in line:
            continue
        key, value = line.split(": ", 1)
        parsed_fields[key] = value

    try:
        if Web3.to_checksum_address(parsed_fields.get("Wallet", "")) != checksum_wallet:
            raise ValueError("wallet mismatch")
    except Exception:
        raise HTTPException(status_code=401, detail="Signed wallet does not match requester")

    if parsed_fields.get("Symbol") != expected_fields["Symbol"]:
        raise HTTPException(status_code=401, detail="Signed symbol does not match request")
    if parsed_fields.get("Credits") != expected_fields["Credits"]:
        raise HTTPException(status_code=401, detail="Signed credit amount does not match request")
    if parsed_fields.get("Nonce") != expected_fields["Nonce"]:
        raise HTTPException(status_code=401, detail="Signed nonce does not match request")
    if parsed_fields.get("Network") != expected_fields["Network"]:
        raise HTTPException(status_code=401, detail="Signed network does not match request")
    if parsed_fields.get("Vault", "").lower() != expected_fields["Vault"].lower():
        raise HTTPException(status_code=401, detail="Signed vault does not match billing contract")

    try:
        recovered = Account.recover_message(encode_defunct(text=message), signature=signature)
    except Exception as exc:
        raise HTTPException(status_code=401, detail=f"Invalid wallet signature: {exc}")

    if Web3.to_checksum_address(recovered) != checksum_wallet:
        raise HTTPException(status_code=401, detail="Wallet signature does not match requester")

    return checksum_wallet


def get_credit_balance(wallet_address: str) -> int:
    _, contract = get_billing_contract()
    return int(contract.functions.creditsOf(wallet_address).call())


def assert_billing_can_consume() -> None:
    web3, contract = get_billing_contract()
    private_key = os.getenv("BILLING_OWNER_PRIVATE_KEY")
    if not private_key:
        raise HTTPException(status_code=500, detail="BILLING_OWNER_PRIVATE_KEY not configured")

    owner_account = web3.eth.account.from_key(private_key)
    contract_owner = contract.functions.owner().call()
    if web3.to_checksum_address(contract_owner) != web3.to_checksum_address(owner_account.address):
        raise HTTPException(status_code=500, detail="Billing signer is not AnalysisCreditVault owner")


def consume_analysis_credit(wallet_address: str, amount: int) -> str:
    web3, contract = get_billing_contract()
    private_key = os.getenv("BILLING_OWNER_PRIVATE_KEY")
    if not private_key:
        raise HTTPException(status_code=500, detail="BILLING_OWNER_PRIVATE_KEY not configured")

    owner_account = web3.eth.account.from_key(private_key)
    contract_owner = contract.functions.owner().call()
    if web3.to_checksum_address(contract_owner) != web3.to_checksum_address(owner_account.address):
        raise HTTPException(status_code=500, detail="Billing signer is not AnalysisCreditVault owner")

    tx = contract.functions.consumeCredit(wallet_address, amount).build_transaction({
        "from": owner_account.address,
        "nonce": web3.eth.get_transaction_count(owner_account.address),
        "chainId": int(os.getenv("MANTLE_SEPOLIA_CHAIN_ID", "5003")),
        "gas": 120000,
        "gasPrice": web3.eth.gas_price,
    })

    signed = owner_account.sign_transaction(tx)
    raw_tx = getattr(signed, "raw_transaction", None) or signed.rawTransaction
    tx_hash = web3.eth.send_raw_transaction(raw_tx)
    receipt = web3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    if receipt.status != 1:
        raise HTTPException(status_code=502, detail="Credit consume transaction failed")

    return tx_hash.hex()


def _extract_gemini_status(exc: Exception) -> int | None:
    for key in ("status_code", "code", "status"):
        if hasattr(exc, key):
            value = getattr(exc, key)
            try:
                return int(value)
            except Exception:
                pass

    message = str(exc)
    if "429" in message:
        return 429
    if "504" in message:
        return 504
    if "503" in message or "UNAVAILABLE" in message.upper() or "HIGH DEMAND" in message.upper():
        return 503
    if "500" in message:
        return 500
    return None


def _is_gemini_retryable(exc: Exception) -> bool:
    status = _extract_gemini_status(exc)
    return status in (500, 503, 504)


async def _generate_content_with_retry(client, model_name: str, contents: list) -> object:
    delays = [2, 5]
    for attempt in range(len(delays) + 1):
        try:
            return client.models.generate_content(model=model_name, contents=contents)
        except Exception as exc:
            status = _extract_gemini_status(exc)
            message = str(exc)

            if status == 429 or "429" in message:
                raise HTTPException(status_code=429, detail="Gemini request limit reached. Please try again later.")

            if not _is_gemini_retryable(exc):
                raise HTTPException(status_code=502, detail="Failed to fetch Gemini analysis. Please try again later.")

            if attempt == len(delays):
                raise HTTPException(status_code=503, detail="Gemini is temporarily overloaded. Try again in a minute.")

            await asyncio.sleep(delays[attempt])


async def fetch_candles(symbol: str, timeframe: str = "1h", limit: int = 102) -> tuple[list, str]:
    source = "bybit"
    try:
        exchange = ccxt.bybit({"enableRateLimit": True})
        exchange.options["defaultType"] = "spot"
        ohlcv = await run_in_threadpool(exchange.fetch_ohlcv, symbol, timeframe, None, limit)
        if not ohlcv or len(ohlcv) < 2:
            raise ValueError("Insufficient candle data from Bybit")
        return ohlcv[:-1], source
    except Exception as bybit_error:
        if not hasattr(ccxt, "bingx"):
            raise RuntimeError("Installed ccxt version does not support BingX")
        try:
            source = "bingx"
            exchange = ccxt.bingx({"enableRateLimit": True})
            exchange.options["defaultType"] = "spot"
            ohlcv = await run_in_threadpool(exchange.fetch_ohlcv, symbol, timeframe, None, limit)
            if not ohlcv or len(ohlcv) < 2:
                raise ValueError("Insufficient candle data from BingX")
            return ohlcv[:-1], source
        except Exception as bingx_error:
            raise HTTPException(
                status_code=502,
                detail=(
                    f"Failed to fetch candles from Bybit and BingX. "
                    f"Bybit error: {bybit_error}; BingX error: {bingx_error}"
                )
            )


def calculate_indicators(ohlcv: list) -> dict:
    if len(ohlcv) < 35:
        raise ValueError("At least 35 closed candles are required for indicators")

    frame = pd.DataFrame(ohlcv, columns=["timestamp", "open", "high", "low", "close", "volume"])
    close = frame["close"].astype(float)
    high = frame["high"].astype(float)
    low = frame["low"].astype(float)

    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    rs = gain / loss.replace(0, float("nan"))
    rsi = 100 - (100 / (1 + rs))

    macd_line = close.ewm(span=12, adjust=False).mean() - close.ewm(span=26, adjust=False).mean()
    macd_signal = macd_line.ewm(span=9, adjust=False).mean()
    macd_histogram = macd_line - macd_signal

    lowest_low = low.rolling(window=14).min()
    highest_high = high.rolling(window=14).max()
    stochastic_k = 100 * (close - lowest_low) / (highest_high - lowest_low).replace(0, float("nan"))
    stochastic_d = stochastic_k.rolling(window=3).mean()

    def latest_number(series, default: float) -> float:
        value = series.iloc[-1]
        return default if pd.isna(value) else float(value)

    rsi_value = latest_number(rsi, 50.0)
    macd_value = latest_number(macd_line, 0.0)
    signal_value = latest_number(macd_signal, 0.0)
    histogram_value = latest_number(macd_histogram, 0.0)
    stochastic_k_value = latest_number(stochastic_k, 50.0)
    stochastic_d_value = latest_number(stochastic_d, 50.0)

    return {
        "rsi": round(rsi_value, 2),
        "rsi_state": "oversold" if rsi_value < 30 else "overbought" if rsi_value > 70 else "neutral",
        "macd": round(macd_value, 8),
        "macd_signal": round(signal_value, 8),
        "macd_histogram": round(histogram_value, 8),
        "macd_state": "bullish" if macd_value > signal_value else "bearish",
        "stochastic_k": round(stochastic_k_value, 2),
        "stochastic_d": round(stochastic_d_value, 2),
        "stochastic_state": (
            "oversold"
            if stochastic_k_value < 20 and stochastic_d_value < 20
            else "overbought"
            if stochastic_k_value > 80 and stochastic_d_value > 80
            else "neutral"
        ),
    }


async def get_gemini_analysis(symbol: str, timeframe: str = "1h") -> dict:
    """Fetch Gemini analysis for the symbol."""
    api_key = os.getenv("GEMINI_API_KEY")
    model_name = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

    if not api_key:
        raise HTTPException(status_code=400, detail="GEMINI_API_KEY not configured")

    hourly_result, daily_result = await asyncio.gather(
        fetch_candles(symbol, "1h", 121),
        fetch_candles(symbol, "1d", 121),
    )
    ohlcv, _ = hourly_result
    daily_ohlcv, _ = daily_result
    if len(ohlcv) < 100 or len(daily_ohlcv) < 100:
        raise HTTPException(status_code=502, detail="Insufficient closed 1H or 1D candles for analysis")

    indicators = {
        "1h": calculate_indicators(ohlcv),
        "1d": calculate_indicators(daily_ohlcv),
    }

    last100 = ohlcv[-100:]
    df = pd.DataFrame(last100, columns=["timestamp", "open", "high", "low", "close", "volume"])
    df["datetime"] = pd.to_datetime(df["timestamp"], unit="ms")
    df = df.set_index("datetime")[["open", "high", "low", "close", "volume"]]
    df.columns = ["Open", "High", "Low", "Close", "Volume"]

    buf = io.BytesIO()
    try:
        mpf.plot(df, type="candle", volume=True, style="yahoo", figsize=(16, 9), savefig=dict(fname=buf, dpi=150))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to render chart: {exc}")

    buf.seek(0)
    image_bytes = buf.read()

    if genai is None or types is None:
        raise HTTPException(status_code=500, detail="google-genai SDK not available")

    try:
        client = genai.Client(api_key=api_key)
    except TypeError:
        client = genai.Client()

    image_part = types.Part.from_bytes(data=image_bytes, mime_type="image/png")
    prompt = (
        f"Analyze ONLY spot LONG scenario for {symbol}. Respond strictly with JSON only (no markdown).\n"
        "Use the chart together with the exact multi-timeframe indicators below. "
        "The 1D timeframe defines the broader trend; the 1H timeframe helps time an entry. "
        "Explicitly consider whether RSI and Stochastic are overbought/oversold and whether MACD is bullish/bearish. "
        "If 1H and 1D conflict, reduce confidence and prefer HOLD unless the long setup is clearly justified.\n"
        f"Indicators: {json.dumps(indicators, separators=(',', ':'))}\n"
        "Return exactly the following schema:\n"
        "{\n  \"action\": \"BUY\" | \"HOLD\",\n  \"support_price\": number,\n  \"resistance_price\": number,\n  \"confidence\": number,\n  \"reason\": string\n}\n"
        "The reason must clearly explain how the 1D trend, 1H setup, RSI, MACD, Stochastic, "
        "support/resistance, and volume contributed to the final decision. "
        "Mention conflicts between indicators when present. Keep the explanation readable in 3-5 sentences. "
        "Provide numeric prices in the quote currency. "
        "IMPORTANT: confidence must be a decimal number from 0.0 to 1.0 (for example 0.60), NOT 60."
    )

    try:
        response = await _generate_content_with_retry(client, model_name, [image_part, prompt])
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=502, detail="Failed to fetch Gemini analysis. Please try again later.")

    text = None
    try:
        if hasattr(response, "output"):
            out = response.output
            if isinstance(out, list) and len(out) > 0:
                first = out[0]
                if hasattr(first, "content") and isinstance(first.content, list) and len(first.content) > 0:
                    c = first.content[0]
                    if hasattr(c, "text"):
                        text = c.text
        if text is None:
            text = str(response)
    except Exception:
        text = str(response)

    try:
        parsed = None
        try:
            parsed = json.loads(text)
        except Exception:
            start = text.find("{")
            end = text.rfind("}")
            if start != -1 and end != -1 and end > start:
                parsed = json.loads(text[start:end+1])

        if parsed is None:
            raise ValueError("No JSON found in model response")

        parsed = normalize_gemini_response(parsed)
        ai = AIResponseModel.parse_obj(parsed)
        result = ai.dict()
        result["indicators"] = indicators
        return result
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to parse Gemini response: {exc}")


def validate_buy(current_price: float, analysis: dict) -> tuple:
    """Validate BUY conditions. Return (is_valid, reason)."""
    # Check confidence
    if analysis.get("confidence", 0) < 0.70:
        return False, f"Confidence {analysis.get('confidence', 0):.2f} < 0.70"

    # Check if price is within 0.5% of support
    support = analysis.get("support_price", 0)
    max_entry = support * 1.005 + 1e-9
    if current_price > max_entry:
        return False, f"Price ${current_price:.6f} > support ${support:.6f} + 0.5%"

    # Check distance from entry to resistance >= 3%
    resistance = analysis.get("resistance_price", 0)
    min_distance = current_price * 1.03 - 1e-9
    if resistance < min_distance:
        return False, f"Resistance ${resistance:.6f} < entry ${current_price:.6f} + 3%"

    return True, "OK"


async def execute_buy(symbol: str, current_price: float, analysis: dict) -> Trade:
    """Execute BUY trade."""
    global account

    if account.open_trade is not None:
        raise ValueError("Already have an open position")

    # Size: 10% of USDT balance
    usdt_to_use = account.usdt_balance * 0.1
    quantity = usdt_to_use / current_price
    
    tp = current_price * 1.03
    sl = analysis.get("support_price", 0) * 0.99

    trade = Trade(
        id=len(account.trades_history) + 1,
        entry_price=current_price,
        entry_time=datetime.now(timezone.utc).isoformat(),
        take_profit_price=tp,
        stop_loss_price=sl,
        quantity=quantity,
        usdt_used=usdt_to_use,
    )

    account.open_trade = trade
    account.mnt_held += quantity
    account.usdt_balance -= usdt_to_use

    return trade


async def check_tp_sl(symbol: str) -> Optional[dict]:
    """Check TP/SL and close trade if needed. Return trade close info or None."""
    global account

    if account.open_trade is None:
        return None

    current_price = await get_latest_price(symbol)
    account.open_trade.current_price = current_price

    # Check TP
    if current_price >= account.open_trade.take_profit_price:
        return await close_trade(symbol, current_price, "take_profit")

    # Check SL
    if current_price <= account.open_trade.stop_loss_price:
        return await close_trade(symbol, current_price, "stop_loss")

    return None


async def close_trade(symbol: str, close_price: float, reason: str) -> dict:
    """Close the open trade."""
    global account

    if account.open_trade is None:
        return None

    trade = account.open_trade
    trade.close_price = close_price
    trade.close_time = datetime.now(timezone.utc).isoformat()
    trade.status = TradeStatus.CLOSED
    trade.close_reason = reason

    pnl_usdt = (close_price - trade.entry_price) * trade.quantity
    pnl_percent = (pnl_usdt / trade.usdt_used) * 100 if trade.usdt_used > 0 else 0
    
    trade.pnl_usdt = pnl_usdt
    trade.pnl_percent = pnl_percent

    account.usdt_balance += trade.usdt_used + pnl_usdt
    account.mnt_held -= trade.quantity
    account.trades_history.append(trade)
    account.open_trade = None
    account.cooldown_remaining = 4  # 4 hour candles

    return {
        "trade_id": trade.id,
        "close_price": close_price,
        "close_reason": reason,
        "pnl_usdt": pnl_usdt,
        "pnl_percent": pnl_percent,
    }


async def agent_loop():
    """Main agent loop: checks TP/SL every 10s, analyzes new candles."""
    global account

    symbol = os.getenv("TRADING_SYMBOL", "MNT/USDT")

    while account.agent_running:
        try:
            # Check TP/SL every iteration
            close_info = await check_tp_sl(symbol)
            if close_info:
                print(f"Trade closed: {close_info}")

            # Get current candles to check if we need new analysis
            current_ohlcv, _ = await fetch_candles(symbol, "1h", 2)
            if len(current_ohlcv) >= 1:
                current_candle_ts = current_ohlcv[-1][0]
                
                # If new candle opened, run analysis
                if account.last_analyzed_timestamp is None or current_candle_ts != account.last_analyzed_timestamp:
                    if account.cooldown_remaining > 0:
                        account.cooldown_remaining -= 1
                    else:
                        # Run Gemini analysis
                        analysis = await get_gemini_analysis(symbol)
                        account.last_analysis = analysis
                        account.last_analyzed_timestamp = current_candle_ts

                        # Check BUY conditions
                        if account.open_trade is None and analysis.get("action") == "BUY":
                            current_price = await get_latest_price(symbol)
                            is_valid, reason = validate_buy(current_price, analysis)
                            
                            if is_valid:
                                trade = await execute_buy(symbol, current_price, analysis)
                                account.last_hold_reason = None
                                print(f"BUY executed: {trade}")
                            else:
                                account.last_hold_reason = reason
                                print(f"BUY rejected: {reason}")
                        else:
                            if analysis.get("action") == "HOLD":
                                account.last_hold_reason = analysis.get("reason")

            # Update equity
            current_price = await get_latest_price(symbol)
            account.equity = account.usdt_balance + (account.mnt_held * current_price)

            await asyncio.sleep(10)

        except Exception as e:
            print(f"Agent loop error: {e}")
            await asyncio.sleep(10)


# ===== Endpoints =====

@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/api/market/candles")
async def get_market_candles(symbol: str = Query(default="MNT/USDT")):
    symbol = normalize_symbol(symbol)
    ohlcv, source = await fetch_candles(symbol, "1h", 102)
    
    closed_candles = ohlcv
    candles = [
        {
            "timestamp": int(row[0]),
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
            "volume": float(row[5]),
        }
        for row in closed_candles
    ]

    display_name = "Bybit Spot" if source == "bybit" else "BingX Spot"
    return {
        "symbol": symbol,
        "exchange": display_name,
        "source": source,
        "timeframe": "1H",
        "candles": candles,
    }


@app.get("/api/portfolio/markets")
async def portfolio_markets(ids: str = Query(default="mantle,bitcoin,ethereum,solana,arbitrum,optimism")):
    requested_ids = list(dict.fromkeys(part.strip().lower() for part in ids.split(",") if part.strip()))
    invalid_ids = [asset_id for asset_id in requested_ids if asset_id not in PORTFOLIO_ASSETS]
    if invalid_ids:
        raise HTTPException(status_code=400, detail=f"Unsupported portfolio assets: {', '.join(invalid_ids)}")
    if not requested_ids:
        raise HTTPException(status_code=400, detail="Select at least one portfolio asset")

    try:
        assets = await run_in_threadpool(fetch_portfolio_market_data, requested_ids)
        source = "CoinGecko"
        cache_portfolio_assets(assets)
    except Exception:
        try:
            assets = await run_in_threadpool(fetch_portfolio_defillama_fallback, requested_ids)
            source = "DefiLlama fallback"
            cache_portfolio_assets(assets)
        except Exception:
            try:
                assets = get_cached_portfolio_assets(requested_ids)
                source = "Cached market snapshot"
            except Exception as exc:
                raise HTTPException(status_code=502, detail=f"Failed to fetch portfolio prices: {exc}")

    return {"source": source, "currency": "usd", "assets": assets}


@app.get("/api/ai/status")
async def ai_status():
    configured = bool(os.getenv("GEMINI_API_KEY"))
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    return {"configured": configured, "model": model}


@app.get("/api/billing/status")
async def billing_status():
    contract_address = get_credit_vault_address()
    auto_consume_enabled = bool(os.getenv("BILLING_OWNER_PRIVATE_KEY")) and Web3 is not None
    return {
        "enabled": True,
        "network": "Mantle Sepolia testnet",
        "credit_required_for_analysis": get_credit_required(),
        "contract_address": contract_address or None,
        "auto_consume_enabled": auto_consume_enabled,
        "signature_required": True,
        "note": (
            "AI analysis requires a wallet signature and enough Mantle Sepolia demo "
            "credits. Credits are consumed on-chain after a successful Gemini response."
        ),
    }


@app.get("/api/dex/quotes")
async def dex_quotes(
    symbol: str = Query(default="MNT/USDT"),
    amount_in: float = Query(default=100.0, gt=0, le=10_000),
    network: str = Query(default="mantle_mainnet"),
):
    symbol = normalize_symbol(symbol)
    try:
        return await run_in_threadpool(get_read_only_quotes, symbol, amount_in, None, network)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/ai/analyze")
async def ai_analyze(request: AnalyzeRequest):
    symbol = normalize_symbol(request.symbol)
    credit_amount = get_credit_required()
    if request.nonce in used_billing_nonces:
        raise HTTPException(status_code=409, detail="Billing nonce already used")

    wallet_address = verify_analysis_signature(
        request.wallet_address,
        request.signature,
        request.nonce,
        credit_amount,
        symbol,
        request.message,
    )
    await run_in_threadpool(assert_billing_can_consume)
    balance = await run_in_threadpool(get_credit_balance, wallet_address)
    if balance < credit_amount:
        raise HTTPException(status_code=402, detail="Insufficient AI credits")

    analysis = await get_gemini_analysis(symbol)
    consume_tx_hash = await run_in_threadpool(consume_analysis_credit, wallet_address, credit_amount)
    used_billing_nonces.add(request.nonce)
    analysis["credits_consumed"] = credit_amount
    analysis["credit_consume_tx_hash"] = consume_tx_hash
    return analysis


# ===== Agent Endpoints =====

@app.get("/api/agent/status")
async def agent_status():
    acc_dict = account.dict()
    if account.open_trade:
        acc_dict["open_trade"] = account.open_trade.dict()
    return {"running": account.agent_running, "account": acc_dict}


@app.post("/api/agent/start")
async def agent_start():
    global agent_task, account

    if account.agent_running:
        raise HTTPException(status_code=400, detail="Agent is already running")

    account.agent_running = True
    agent_task = asyncio.create_task(agent_loop())

    return {"status": "started"}


@app.post("/api/agent/stop")
async def agent_stop():
    global account, agent_task

    if not account.agent_running:
        raise HTTPException(status_code=400, detail="Agent is not running")

    account.agent_running = False
    if agent_task:
        agent_task.cancel()
        try:
            await agent_task
        except asyncio.CancelledError:
            pass
        agent_task = None

    return {"status": "stopped"}


@app.post("/api/account/reset")
async def account_reset():
    global account, agent_task

    if account.agent_running:
        account.agent_running = False
        if agent_task:
            agent_task.cancel()
            try:
                await agent_task
            except asyncio.CancelledError:
                pass
            agent_task = None

    account = PaperAccount()
    return {"status": "reset"}


@app.on_event("shutdown")
async def shutdown_event():
    global agent_task, account
    if agent_task:
        account.agent_running = False
        agent_task.cancel()
        try:
            await agent_task
        except asyncio.CancelledError:
            pass
        agent_task = None


@app.get("/api/trades")
async def get_trades():
    return {
        "open_trade": account.open_trade.dict() if account.open_trade else None,
        "trades_history": [t.dict() for t in account.trades_history],
    }
