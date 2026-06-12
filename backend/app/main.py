import os
import asyncio
import json
import re
import time
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
    action: Literal["BUY", "SELL", "HOLD"]
    support_price: float = Field(..., gt=0)
    resistance_price: float = Field(..., gt=0)
    confidence: float = Field(..., ge=0.0, le=1.0)
    reason: str
    indicators: Optional[dict] = None
    timeframe_levels: dict


class AnalyzeRequest(BaseModel):
    symbol: str
    analysis_mode: Literal["scalping", "intraday", "swing", "position", "macro"] = "intraday"
    wallet_address: str
    signature: str
    nonce: str
    message: Optional[str] = None


class PerformanceSignalRequest(BaseModel):
    symbol: str
    action: str
    price: int = Field(..., gt=0)
    confidence: int = Field(..., ge=0, le=100)
    timestamp: int = Field(..., gt=0)
    trader: Optional[str] = None


class PerformanceEvaluateRequest(BaseModel):
    signals: list[PerformanceSignalRequest] = Field(default_factory=list, max_length=100)


# ===== Global State =====

account = PaperAccount()
agent_task: Optional[asyncio.Task] = None
used_billing_nonces: set[str] = set()
MARKET_CATALOG_TTL_SECONDS = 15 * 60
market_catalog_cache: dict = {"stored_at": 0.0, "markets": [], "exchange": "Bybit Spot", "source": "bybit"}
MARKET_SYMBOL_PATTERN = re.compile(r"^[A-Z0-9]{2,20}/USDT$")
LEVERAGED_TOKEN_SUFFIXES = ("3L", "3S", "5L", "5S", "UP", "DOWN", "BULL", "BEAR")
ANALYSIS_MODES = {
    "scalping": {"entry": "15m", "trend": "1h", "label": "Scalping"},
    "intraday": {"entry": "1h", "trend": "4h", "label": "Intraday"},
    "swing": {"entry": "4h", "trend": "1d", "label": "Swing"},
    "position": {"entry": "1d", "trend": "1w", "label": "Position"},
    "macro": {"entry": "1w", "trend": "1M", "label": "Macro"},
}
SUPPORTED_MARKET_TIMEFRAMES = {mode["entry"] for mode in ANALYSIS_MODES.values()}
MIN_ANALYSIS_CANDLES = 35
BUY_EVALUATION_WINDOW_SECONDS = 24 * 60 * 60
BUY_PROFIT_OPPORTUNITY_THRESHOLD_PERCENT = 1.0
BUY_EVALUATION_TIMEFRAME = "5m"
BUY_EVALUATION_CANDLE_SECONDS = 5 * 60
BUY_MIN_CONFIDENCE = 0.70
BUY_MIN_UPSIDE_PERCENT = 2.0
BUY_MIN_REWARD_RISK = 1.5
PERFORMANCE_TRACKING_START_TIMESTAMP = int(os.getenv("PERFORMANCE_TRACKING_START_TIMESTAMP", "1781280465"))


def timeframe_display_name(timeframe: str) -> str:
    if timeframe == "1M":
        return "ONE MONTH (1M, not 1 minute)"
    if timeframe == "1m":
        return "ONE MINUTE (1m)"
    if timeframe == "1w":
        return "ONE WEEK (1W)"
    return timeframe.upper()


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
    errors = []
    providers = (
        ("bybit", None, "bybit"),
        ("bybit", "bytick.com", "bybit-bytick"),
        ("bingx", None, "bingx"),
    )
    for exchange_id, hostname, source in providers:
        try:
            exchange = create_spot_exchange(exchange_id, hostname)
            ticker = await run_in_threadpool(exchange.fetch_ticker, symbol)
            return float(ticker["last"])
        except Exception as exc:
            errors.append(f"{source}: {exc}")
    raise HTTPException(status_code=502, detail=f"Failed to fetch price. {'; '.join(errors)}")


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
    if "action" in parsed and isinstance(parsed["action"], str):
        parsed["action"] = parsed["action"].strip().upper()
    if "confidence" in parsed and isinstance(parsed["confidence"], (int, float)):
        try:
            parsed["confidence"] = normalize_confidence(parsed["confidence"])
        except ValueError as e:
            raise ValueError(f"Invalid confidence in Gemini response: {e}")
    return parsed


def apply_signal_quality_gate(
    analysis: dict,
    indicators: dict,
    current_price: Optional[float] = None,
    entry_timeframe: str = "1h",
    trend_timeframe: str = "1d",
) -> dict:
    """Downgrade weak directional calls to HOLD before presenting or recording them."""
    action = analysis.get("action")
    if action not in {"BUY", "SELL"}:
        return analysis

    entry_indicators = indicators.get(entry_timeframe, {})
    trend_indicators = indicators.get(trend_timeframe, {})
    rejection_reasons = []
    quality_details = {}

    if action == "BUY":
        if analysis.get("confidence", 0) < BUY_MIN_CONFIDENCE:
            rejection_reasons.append(f"BUY confidence is below {BUY_MIN_CONFIDENCE:.0%}")
        if trend_indicators.get("macd_state") != "bullish":
            rejection_reasons.append(f"the {trend_timeframe.upper()} MACD does not confirm a bullish trend")
        if entry_indicators.get("macd_state") != "bullish":
            rejection_reasons.append(f"the {entry_timeframe.upper()} MACD does not confirm bullish entry timing")
        if trend_indicators.get("rsi_state") == "overbought" and entry_indicators.get("rsi_state") == "overbought":
            rejection_reasons.append("both timeframes are already RSI-overbought")
        if (
            trend_indicators.get("stochastic_state") == "overbought"
            and entry_indicators.get("stochastic_state") == "overbought"
        ):
            rejection_reasons.append("both timeframes are already Stochastic-overbought")
        if current_price:
            support = float(analysis.get("support_price", 0))
            resistance = float(analysis.get("resistance_price", 0))
            risk = current_price - support
            reward = resistance - current_price
            upside_percent = reward / current_price * 100 if current_price > 0 else 0
            reward_risk = reward / risk if risk > 0 else 0
            quality_details = {
                "upside_percent": round(upside_percent, 2),
                "reward_risk": round(reward_risk, 2),
            }
            if support <= 0 or support >= current_price:
                rejection_reasons.append("support does not provide a valid BUY invalidation level")
            if resistance <= current_price:
                rejection_reasons.append("resistance does not provide valid upside room")
            elif upside_percent < BUY_MIN_UPSIDE_PERCENT:
                rejection_reasons.append(f"upside to resistance is below {BUY_MIN_UPSIDE_PERCENT:.0f}%")
            if risk <= 0 or reward_risk < BUY_MIN_REWARD_RISK:
                rejection_reasons.append(f"reward/risk is below {BUY_MIN_REWARD_RISK:.1f}")

        if not rejection_reasons:
            return {
                **analysis,
                "quality_gate": {
                    "passed": True,
                    "original_action": "BUY",
                    **quality_details,
                },
            }

        original_reason = analysis.get("reason", "")
        return {
            **analysis,
            "action": "HOLD",
            "reason": (
                f"BUY was not confirmed because {', '.join(rejection_reasons)}. "
                f"The safer decision is HOLD. Original market assessment: {original_reason}"
            ),
            "quality_gate": {
                "passed": False,
                "original_action": "BUY",
                "rejection_reasons": rejection_reasons,
                **quality_details,
            },
        }

    if analysis.get("confidence", 0) < 0.70:
        rejection_reasons.append("SELL confidence is below 70%")
    if trend_indicators.get("macd_state") != "bearish":
        rejection_reasons.append(f"the {trend_timeframe.upper()} MACD does not confirm a bearish trend")
    if entry_indicators.get("macd_state") != "bearish":
        rejection_reasons.append(f"the {entry_timeframe.upper()} MACD does not confirm bearish entry timing")
    if trend_indicators.get("rsi_state") == "oversold" and entry_indicators.get("rsi_state") == "oversold":
        rejection_reasons.append("both timeframes are already RSI-oversold")
    if trend_indicators.get("stochastic_state") == "oversold" and entry_indicators.get("stochastic_state") == "oversold":
        rejection_reasons.append("both timeframes are already Stochastic-oversold")
    if current_price:
        support = analysis.get("support_price", 0)
        resistance = analysis.get("resistance_price", 0)
        if support >= current_price * 0.98:
            rejection_reasons.append("support offers less than 2% downside room")
        if resistance <= current_price:
            rejection_reasons.append("resistance does not provide a valid bearish invalidation level")

    if not rejection_reasons:
        return {
            **analysis,
            "quality_gate": {
                "passed": True,
                "original_action": "SELL",
            },
        }

    original_reason = analysis.get("reason", "")
    return {
        **analysis,
        "action": "HOLD",
        "reason": (
            f"SELL was not confirmed because {', '.join(rejection_reasons)}. "
            f"The safer decision is HOLD. Original market assessment: {original_reason}"
        ),
        "quality_gate": {
            "passed": False,
            "original_action": "SELL",
            "rejection_reasons": rejection_reasons,
        },
    }


def get_credit_required() -> int:
    return int(os.getenv("ANALYSIS_CREDIT_REQUIRED", "1"))


def local_analysis_billing_bypass_enabled() -> bool:
    return os.getenv("LOCAL_ANALYSIS_BILLING_BYPASS", "").strip().lower() == "true"


def get_credit_vault_address() -> str:
    return os.getenv(
        "ANALYSIS_CREDIT_VAULT_ADDRESS",
        "0x58423C0BEF508aDD4F7C9CaaE34366780FD3A28d",
    )


def normalize_symbol(symbol: str) -> str:
    normalized = symbol.strip().upper()
    if not MARKET_SYMBOL_PATTERN.fullmatch(normalized):
        raise HTTPException(status_code=400, detail="Only standard spot TOKEN/USDT symbols are supported")
    return normalized


def create_spot_exchange(exchange_id: str, hostname: str | None = None):
    exchange_class = getattr(ccxt, exchange_id)
    config = {"enableRateLimit": True}
    if hostname:
        config["hostname"] = hostname
    exchange = exchange_class(config)
    exchange.options["defaultType"] = "spot"
    return exchange


def _normalize_market_catalog(markets: dict, exchange_name: str) -> list[dict]:
    catalog = []
    for market in markets.values():
        base = str(market.get("base") or "").upper()
        symbol = str(market.get("symbol") or "").upper()
        if (
            market.get("spot")
            and market.get("active") is not False
            and market.get("quote") == "USDT"
            and MARKET_SYMBOL_PATTERN.fullmatch(symbol)
            and not base.endswith(LEVERAGED_TOKEN_SUFFIXES)
        ):
            catalog.append({
                "symbol": symbol,
                "base": base,
                "quote": "USDT",
                "exchange": exchange_name,
            })
    catalog.sort(key=lambda market: (market["symbol"] != "MNT/USDT", market["base"]))
    return catalog


def fetch_market_catalog() -> list[dict]:
    if time.monotonic() - market_catalog_cache["stored_at"] < MARKET_CATALOG_TTL_SECONDS:
        return market_catalog_cache["markets"]

    errors = []
    providers = (
        ("bybit", None, "Bybit Spot", "bybit"),
        ("bybit", "bytick.com", "Bybit Spot", "bybit-bytick"),
        ("bingx", None, "BingX Spot fallback", "bingx"),
    )
    for exchange_id, hostname, exchange_name, source in providers:
        try:
            exchange = create_spot_exchange(exchange_id, hostname)
            catalog = _normalize_market_catalog(exchange.load_markets(), exchange_name)
            if not catalog:
                raise ValueError(f"{exchange_name} returned no active USDT spot pairs")
            market_catalog_cache.update({
                "stored_at": time.monotonic(),
                "markets": catalog,
                "exchange": exchange_name,
                "source": source,
            })
            return catalog
        except Exception as exc:
            errors.append(f"{source}: {exc}")

    if market_catalog_cache["markets"]:
        return market_catalog_cache["markets"]
    raise RuntimeError("; ".join(errors))


def build_analysis_auth_message(wallet_address: str, amount: int, nonce: str, symbol: str, analysis_mode: str = "intraday") -> str:
    return (
        "Mantle AI Trader\n"
        "Authorize AI analysis credit spend\n"
        f"Wallet: {wallet_address}\n"
        f"Symbol: {symbol}\n"
        f"Mode: {analysis_mode}\n"
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


def verify_analysis_signature(wallet_address: str, signature: str, nonce: str, amount: int, symbol: str, signed_message: Optional[str] = None, analysis_mode: str = "intraday") -> str:
    if Account is None or encode_defunct is None or Web3 is None:
        raise HTTPException(status_code=500, detail="eth-account SDK not available")

    try:
        checksum_wallet = Web3.to_checksum_address(wallet_address)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid wallet address")

    message = signed_message or build_analysis_auth_message(checksum_wallet, amount, nonce, symbol, analysis_mode)
    expected_fields = {
        "Wallet": checksum_wallet,
        "Symbol": symbol,
        "Mode": analysis_mode,
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
    if parsed_fields.get("Mode") != expected_fields["Mode"]:
        raise HTTPException(status_code=401, detail="Signed analysis mode does not match request")
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


async def _generate_content_with_retry(client, model_name: str, contents: list, config=None) -> object:
    delays = [2, 5]
    for attempt in range(len(delays) + 1):
        try:
            return await run_in_threadpool(
                client.models.generate_content,
                model=model_name,
                contents=contents,
                config=config,
            )
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


async def generate_gemini_with_model_fallback(client, primary_model: str, fallback_model: str, contents: list, config=None) -> tuple[object, str]:
    try:
        return await _generate_content_with_retry(client, primary_model, contents, config), primary_model
    except HTTPException as exc:
        if exc.status_code not in (429, 503) or not fallback_model or fallback_model == primary_model:
            raise
        return await _generate_content_with_retry(client, fallback_model, contents, config), fallback_model


def extract_gemini_json(response: object) -> dict:
    parsed = getattr(response, "parsed", None)
    if isinstance(parsed, dict):
        return parsed

    text = getattr(response, "text", None)
    if not isinstance(text, str) or not text.strip():
        candidates = getattr(response, "candidates", None) or []
        finish_reason = getattr(candidates[0], "finish_reason", None) if candidates else None
        reason = str(finish_reason) if finish_reason else "unknown"
        raise ValueError(f"Gemini returned no JSON output (finish reason: {reason})")

    try:
        return json.loads(text)
    except Exception:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(text[start:end + 1])
        raise ValueError("No JSON found in Gemini response")


async def fetch_candles(symbol: str, timeframe: str = "1h", limit: int = 102) -> tuple[list, str]:
    errors = []
    providers = (
        ("bybit", None, "bybit"),
        ("bybit", "bytick.com", "bybit-bytick"),
        ("bingx", None, "bingx"),
    )
    for exchange_id, hostname, source in providers:
        try:
            exchange = create_spot_exchange(exchange_id, hostname)
            ohlcv = await run_in_threadpool(exchange.fetch_ohlcv, symbol, timeframe, None, limit)
            if not ohlcv or len(ohlcv) < 2:
                raise ValueError(f"Insufficient candle data from {source}")
            return ohlcv[:-1], source
        except Exception as exc:
            errors.append(f"{source}: {exc}")
    raise HTTPException(status_code=502, detail=f"Failed to fetch candles. {'; '.join(errors)}")


async def fetch_evaluation_window(symbol: str, signal_timestamp: int, evaluation_timestamp: int) -> tuple[list, str]:
    errors = []
    since_ms = signal_timestamp * 1000
    evaluation_ms = evaluation_timestamp * 1000
    providers = (
        ("bybit", None, "bybit"),
        ("bybit", "bytick.com", "bybit-bytick"),
        ("bingx", None, "bingx"),
    )
    for exchange_id, hostname, source in providers:
        try:
            exchange = create_spot_exchange(exchange_id, hostname)
            candles = await run_in_threadpool(exchange.fetch_ohlcv, symbol, BUY_EVALUATION_TIMEFRAME, since_ms, 300)
            eligible = [candle for candle in candles if since_ms <= int(candle[0]) <= evaluation_ms]
            if not eligible or int(eligible[-1][0]) < evaluation_ms - BUY_EVALUATION_CANDLE_SECONDS * 1000:
                raise ValueError("Complete 24-hour candle window was not returned")
            return eligible, source
        except Exception as exc:
            errors.append(f"{source}: {exc}")
    raise ValueError("; ".join(errors))


async def evaluate_buy_signal(signal: PerformanceSignalRequest, now_timestamp: int) -> dict:
    symbol = normalize_symbol(signal.symbol)
    entry_price = signal.price / 1e8
    evaluation_at = signal.timestamp + BUY_EVALUATION_WINDOW_SECONDS
    base = {
        "symbol": symbol,
        "action": "BUY",
        "entry_price": round(entry_price, 8),
        "confidence": signal.confidence,
        "signal_timestamp": signal.timestamp,
        "evaluation_at": evaluation_at,
        "trader": signal.trader,
    }
    if evaluation_at > now_timestamp:
        return {
            **base,
            "status": "pending",
            "evaluation_price": None,
            "return_percent": None,
            "mfe_percent": None,
            "mae_percent": None,
            "outcome": None,
        }

    try:
        candles, source = await fetch_evaluation_window(symbol, signal.timestamp, evaluation_at)
    except Exception as exc:
        return {
            **base,
            "status": "unavailable",
            "evaluation_price": None,
            "return_percent": None,
            "mfe_percent": None,
            "mae_percent": None,
            "outcome": None,
            "error": str(exc),
        }

    evaluation_candle = candles[-1]
    evaluation_price = float(evaluation_candle[4])
    evaluated_timestamp = int(evaluation_candle[0] // 1000)
    max_price = max(float(candle[2]) for candle in candles)
    min_price = min(float(candle[3]) for candle in candles)
    return_percent = (evaluation_price / entry_price - 1) * 100
    mfe_percent = (max_price / entry_price - 1) * 100
    mae_percent = (min_price / entry_price - 1) * 100
    if mfe_percent >= BUY_PROFIT_OPPORTUNITY_THRESHOLD_PERCENT:
        outcome = "PROFIT_OPPORTUNITY" if return_percent >= 0 else "REVERSED"
    elif return_percent < 0:
        outcome = "LOSS"
    else:
        outcome = "FLAT"
    return {
        **base,
        "status": "evaluated",
        "evaluation_price": round(evaluation_price, 8),
        "evaluated_timestamp": evaluated_timestamp,
        "return_percent": round(return_percent, 2),
        "max_price": round(max_price, 8),
        "min_price": round(min_price, 8),
        "mfe_percent": round(mfe_percent, 2),
        "mae_percent": round(mae_percent, 2),
        "outcome": outcome,
        "source": source,
    }


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


def calculate_timeframe_levels(ohlcv: list, current_price_override: Optional[float] = None) -> dict:
    if len(ohlcv) < 5:
        raise ValueError("At least 5 closed candles are required for support/resistance levels")

    frame = pd.DataFrame(ohlcv[-90:], columns=["timestamp", "open", "high", "low", "close", "volume"])
    high = frame["high"].astype(float).reset_index(drop=True)
    low = frame["low"].astype(float).reset_index(drop=True)
    close = frame["close"].astype(float).reset_index(drop=True)
    current_price = float(current_price_override) if current_price_override else float(close.iloc[-1])

    pivot_lows: list[float] = []
    pivot_highs: list[float] = []
    wing = 2
    for index in range(wing, len(frame) - wing):
        low_window = low.iloc[index - wing:index + wing + 1]
        high_window = high.iloc[index - wing:index + wing + 1]
        if float(low.iloc[index]) <= float(low_window.min()):
            pivot_lows.append(float(low.iloc[index]))
        if float(high.iloc[index]) >= float(high_window.max()):
            pivot_highs.append(float(high.iloc[index]))

    support_candidates = [price for price in pivot_lows + pivot_highs if price < current_price]
    resistance_candidates = [price for price in pivot_highs + pivot_lows if price > current_price]
    support_fallbacks = [float(value) for value in low if float(value) < current_price]
    resistance_fallbacks = [float(value) for value in high if float(value) > current_price]
    support_price = max(support_candidates) if support_candidates else (max(support_fallbacks) if support_fallbacks else current_price)
    resistance_price = min(resistance_candidates) if resistance_candidates else (min(resistance_fallbacks) if resistance_fallbacks else current_price)
    support_role = "former_resistance" if support_price in pivot_highs else "demand"
    resistance_role = "former_support" if resistance_price in pivot_lows else "supply"

    return {
        "current_price": round(current_price, 8),
        "support_price": round(support_price, 8),
        "resistance_price": round(resistance_price, 8),
        "support_distance_percent": round((current_price / support_price - 1) * 100, 2) if support_price > 0 else 0.0,
        "resistance_distance_percent": round((resistance_price / current_price - 1) * 100, 2) if current_price > 0 else 0.0,
        "support_status": "at_price" if support_price == current_price else "below_price",
        "resistance_status": "at_price" if resistance_price == current_price else "above_price",
        "support_role": support_role,
        "resistance_role": resistance_role,
    }


def build_timeframe_context(timeframe: str, ohlcv: list, indicators: dict, current_price: float, reference_levels: dict) -> dict:
    recent_candles = [
        {
            "timestamp": int(candle[0]),
            "open": round(float(candle[1]), 8),
            "high": round(float(candle[2]), 8),
            "low": round(float(candle[3]), 8),
            "close": round(float(candle[4]), 8),
            "volume": round(float(candle[5]), 4),
        }
        for candle in ohlcv[-60:]
    ]
    return {
        "timeframe": timeframe,
        "live_spot_price": round(current_price, 8),
        "closed_candle_count": len(ohlcv),
        "visible_chart_candles": min(len(ohlcv), 100),
        "recent_ohlcv": recent_candles,
        "indicators": indicators,
        "backend_reference_levels": reference_levels,
    }


def render_timeframe_chart(ohlcv: list, symbol: str, timeframe: str) -> bytes:
    last100 = ohlcv[-100:]
    frame = pd.DataFrame(last100, columns=["timestamp", "open", "high", "low", "close", "volume"])
    frame["datetime"] = pd.to_datetime(frame["timestamp"], unit="ms")
    frame = frame.set_index("datetime")[["open", "high", "low", "close", "volume"]]
    frame.columns = ["Open", "High", "Low", "Close", "Volume"]

    buffer = io.BytesIO()
    try:
        mpf.plot(
            frame,
            type="candle",
            volume=True,
            style="yahoo",
            title=f"{symbol} - {timeframe_display_name(timeframe)} - CLOSED CANDLES",
            ylabel="Price",
            ylabel_lower="Volume",
            figsize=(16, 9),
            savefig=dict(fname=buffer, dpi=150),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to render {timeframe_display_name(timeframe)} chart: {exc}")
    buffer.seek(0)
    return buffer.read()


def validate_ai_timeframe_levels(candidate_levels: dict, reference_levels: dict) -> dict:
    validated = {}
    for timeframe, reference in reference_levels.items():
        candidate = candidate_levels.get(timeframe, {}) if isinstance(candidate_levels, dict) else {}
        current_price = float(reference["current_price"])
        try:
            support_price = float(candidate["support_price"])
            resistance_price = float(candidate["resistance_price"])
        except (KeyError, TypeError, ValueError):
            support_price = float(reference["support_price"])
            resistance_price = float(reference["resistance_price"])
            source = "backend_fallback"
        else:
            source = "gemini"
            if support_price <= 0 or support_price > current_price:
                support_price = float(reference["support_price"])
                source = "backend_fallback"
            if resistance_price <= 0 or resistance_price < current_price:
                resistance_price = float(reference["resistance_price"])
                source = "backend_fallback"

        validated[timeframe] = {
            **reference,
            "support_price": round(support_price, 8),
            "resistance_price": round(resistance_price, 8),
            "support_distance_percent": round((current_price / support_price - 1) * 100, 2),
            "resistance_distance_percent": round((resistance_price / current_price - 1) * 100, 2),
            "support_role": "model_selected" if source == "gemini" else reference["support_role"],
            "resistance_role": "model_selected" if source == "gemini" else reference["resistance_role"],
            "level_source": source,
        }
    return validated


def calculate_historical_setup_match(ohlcv: list, horizon: int = 12) -> dict:
    if len(ohlcv) < MIN_ANALYSIS_CANDLES + horizon:
        return {
            "signal": "insufficient",
            "insufficient_reason": "insufficient_history",
            "similar_cases": 0,
            "bullish_percent": 0.0,
            "bearish_percent": 0.0,
            "average_move_percent": 0.0,
            "median_move_percent": 0.0,
            "evaluation_candles": horizon,
        }

    frame = pd.DataFrame(ohlcv, columns=["timestamp", "open", "high", "low", "close", "volume"])
    close = frame["close"].astype(float)
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    rsi = 100 - (100 / (1 + gain / loss.replace(0, float("nan"))))
    macd = close.ewm(span=12, adjust=False).mean() - close.ewm(span=26, adjust=False).mean()
    macd_signal = macd.ewm(span=9, adjust=False).mean()
    lowest_low = frame["low"].astype(float).rolling(window=14).min()
    highest_high = frame["high"].astype(float).rolling(window=14).max()
    stochastic_k = 100 * (close - lowest_low) / (highest_high - lowest_low).replace(0, float("nan"))
    stochastic_d = stochastic_k.rolling(window=3).mean()

    current_rsi = float(rsi.iloc[-1]) if not pd.isna(rsi.iloc[-1]) else 50.0
    current_macd_state = "bullish" if macd.iloc[-1] > macd_signal.iloc[-1] else "bearish"
    current_stochastic_state = (
        "oversold" if stochastic_k.iloc[-1] < 20 and stochastic_d.iloc[-1] < 20
        else "overbought" if stochastic_k.iloc[-1] > 80 and stochastic_d.iloc[-1] > 80
        else "neutral"
    )

    forward_returns = []
    for index in range(MIN_ANALYSIS_CANDLES - 1, len(frame) - horizon - 1):
        if pd.isna(rsi.iloc[index]) or pd.isna(stochastic_k.iloc[index]) or pd.isna(stochastic_d.iloc[index]):
            continue
        macd_state = "bullish" if macd.iloc[index] > macd_signal.iloc[index] else "bearish"
        stochastic_state = (
            "oversold" if stochastic_k.iloc[index] < 20 and stochastic_d.iloc[index] < 20
            else "overbought" if stochastic_k.iloc[index] > 80 and stochastic_d.iloc[index] > 80
            else "neutral"
        )
        if macd_state != current_macd_state or stochastic_state != current_stochastic_state:
            continue
        if abs(float(rsi.iloc[index]) - current_rsi) > 10:
            continue
        forward_returns.append((float(close.iloc[index + horizon]) / float(close.iloc[index]) - 1) * 100)

    if len(forward_returns) < 5:
        return {
            "signal": "insufficient",
            "insufficient_reason": "no_reliable_match",
            "similar_cases": len(forward_returns),
            "bullish_percent": 0.0,
            "bearish_percent": 0.0,
            "average_move_percent": 0.0,
            "median_move_percent": 0.0,
            "evaluation_candles": horizon,
        }

    bullish_percent = sum(value > 0 for value in forward_returns) / len(forward_returns) * 100
    bearish_percent = 100 - bullish_percent
    average_move = sum(forward_returns) / len(forward_returns)
    median_move = float(pd.Series(forward_returns).median())
    signal = (
        "bullish" if bullish_percent >= 55 and average_move > 0
        else "bearish" if bearish_percent >= 55 and average_move < 0
        else "neutral"
    )
    return {
        "signal": signal,
        "insufficient_reason": None,
        "similar_cases": len(forward_returns),
        "bullish_percent": round(bullish_percent, 1),
        "bearish_percent": round(bearish_percent, 1),
        "average_move_percent": round(average_move, 2),
        "median_move_percent": round(median_move, 2),
        "evaluation_candles": horizon,
    }


async def get_gemini_analysis(symbol: str, analysis_mode: str = "intraday") -> dict:
    """Fetch Gemini analysis for the symbol."""
    api_key = os.getenv("GEMINI_API_KEY")
    model_name = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    fallback_model_name = os.getenv("GEMINI_FALLBACK_MODEL", "gemini-2.5-flash-lite")

    if not api_key:
        raise HTTPException(status_code=400, detail="GEMINI_API_KEY not configured")

    mode = ANALYSIS_MODES[analysis_mode]
    entry_timeframe = mode["entry"]
    trend_timeframe = mode["trend"]
    entry_timeframe_label = timeframe_display_name(entry_timeframe)
    trend_timeframe_label = timeframe_display_name(trend_timeframe)
    entry_result, trend_result = await asyncio.gather(
        fetch_candles(symbol, entry_timeframe, 301),
        fetch_candles(symbol, trend_timeframe, 121),
    )
    ohlcv, _ = entry_result
    trend_ohlcv, _ = trend_result
    insufficient = [
        f"{timeframe.upper()} has {len(candles)}"
        for timeframe, candles in ((entry_timeframe, ohlcv), (trend_timeframe, trend_ohlcv))
        if len(candles) < MIN_ANALYSIS_CANDLES
    ]
    if insufficient:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{symbol} does not have enough closed candle history for {mode['label']} analysis: "
                f"{', '.join(insufficient)}; at least {MIN_ANALYSIS_CANDLES} candles are required."
            ),
        )

    indicators = {
        entry_timeframe: calculate_indicators(ohlcv),
        trend_timeframe: calculate_indicators(trend_ohlcv),
    }
    try:
        current_reference_price = await get_latest_price(symbol)
        price_reference = "live_spot"
    except HTTPException:
        current_reference_price = float(ohlcv[-1][4])
        price_reference = "latest_closed_entry_candle"
    timeframe_levels = {
        entry_timeframe: calculate_timeframe_levels(ohlcv, current_reference_price),
        trend_timeframe: calculate_timeframe_levels(trend_ohlcv, current_reference_price),
    }
    for levels in timeframe_levels.values():
        levels["price_reference"] = price_reference
    historical_setup = calculate_historical_setup_match(ohlcv)
    entry_context = build_timeframe_context(
        entry_timeframe,
        ohlcv,
        indicators[entry_timeframe],
        current_reference_price,
        timeframe_levels[entry_timeframe],
    )
    trend_context = build_timeframe_context(
        trend_timeframe,
        trend_ohlcv,
        indicators[trend_timeframe],
        current_reference_price,
        timeframe_levels[trend_timeframe],
    )
    entry_image_bytes = render_timeframe_chart(ohlcv, symbol, entry_timeframe)
    trend_image_bytes = render_timeframe_chart(trend_ohlcv, symbol, trend_timeframe)

    if genai is None or types is None:
        raise HTTPException(status_code=500, detail="google-genai SDK not available")

    try:
        client = genai.Client(api_key=api_key)
    except TypeError:
        client = genai.Client()

    entry_image_part = types.Part.from_bytes(data=entry_image_bytes, mime_type="image/png")
    trend_image_part = types.Part.from_bytes(data=trend_image_bytes, mime_type="image/png")
    prompt = (
        f"Analyze the spot market setup for {symbol}. Respond strictly with JSON only (no markdown).\n"
        "You received two separately labeled chart screenshots. Each screenshot is immediately followed by a JSON block "
        "that digitizes its exact timeframe data. Analyze each screenshot together with only its adjacent JSON block, then "
        "combine both timeframes into one decision. "
        f"This is a {mode['label']} analysis. The {trend_timeframe_label} timeframe defines the broader trend; "
        f"the {entry_timeframe_label} timeframe helps time an entry or exit. "
        "Explicitly consider whether RSI and Stochastic are overbought/oversold and whether MACD is bullish/bearish. "
        f"Return BUY only when confidence is at least {BUY_MIN_CONFIDENCE:.0%}, MACD is bullish on both timeframes, "
        f"upside toward resistance is at least {BUY_MIN_UPSIDE_PERCENT:.0f}%, and reward/risk from support to resistance "
        f"is at least {BUY_MIN_REWARD_RISK:.1f}. "
        f"Return SELL only for a clearly confirmed bearish setup where both {trend_timeframe_label} and "
        f"{entry_timeframe_label} support the exit, "
        "there is downside room toward support, and the market is not already exhausted in deep oversold conditions. "
        "SELL means reduce or exit spot exposure; it does not mean opening a short position. "
        f"If {entry_timeframe_label} and {trend_timeframe_label} conflict or neither direction is clearly confirmed, "
        "reduce confidence and return HOLD.\n"
        f"Historical setup match on the {entry_timeframe_label} timeframe: "
        f"{json.dumps(historical_setup, separators=(',', ':'))}. "
        "Use this as supporting statistical evidence, not as a standalone decision.\n"
        f"Choose the nearest meaningful support below live spot price and resistance above live spot price separately for "
        f"{entry_timeframe_label} and {trend_timeframe_label}. Use visible market structure, repeated reactions, consolidation "
        "zones, wicks, and volume. backend_reference_levels are only a numeric cross-check, not mandatory answers. "
        "If your visual level differs, return your visual level. The backend will reject only geometrically invalid levels.\n"
        "Return exactly the following schema:\n"
        "{\n  \"action\": \"BUY\" | \"SELL\" | \"HOLD\",\n  \"support_price\": number,\n  \"resistance_price\": number,\n"
        f"  \"timeframe_levels\": {{\"{entry_timeframe}\": {{\"support_price\": number, \"resistance_price\": number}}, "
        f"\"{trend_timeframe}\": {{\"support_price\": number, \"resistance_price\": number}}}},\n"
        "  \"confidence\": number,\n  \"reason\": string\n}\n"
        f"The reason must clearly explain how the {trend_timeframe_label} trend, {entry_timeframe_label} setup, "
        "RSI, MACD, Stochastic, "
        f"{entry_timeframe_label} support/resistance, {trend_timeframe_label} support/resistance, and volume "
        "contributed to the final decision. "
        "Mention conflicts between indicators when present. Keep the explanation readable in 3-5 sentences. "
        "Provide numeric prices in the quote currency. "
        "IMPORTANT: confidence must be a decimal number from 0.0 to 1.0 (for example 0.60), NOT 60."
    )

    timeframe_level_schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["support_price", "resistance_price"],
        "properties": {
            "support_price": {"type": "number", "exclusiveMinimum": 0},
            "resistance_price": {"type": "number", "exclusiveMinimum": 0},
        },
    }
    response_schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["action", "support_price", "resistance_price", "timeframe_levels", "confidence", "reason"],
        "properties": {
            "action": {"type": "string", "enum": ["BUY", "SELL", "HOLD"]},
            "support_price": {"type": "number", "exclusiveMinimum": 0},
            "resistance_price": {"type": "number", "exclusiveMinimum": 0},
            "timeframe_levels": {
                "type": "object",
                "additionalProperties": False,
                "required": [entry_timeframe, trend_timeframe],
                "properties": {
                    entry_timeframe: timeframe_level_schema,
                    trend_timeframe: timeframe_level_schema,
                },
            },
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "reason": {"type": "string"},
        },
    }
    config = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_json_schema=response_schema,
        temperature=0.2,
        max_output_tokens=2048,
        thinking_config=types.ThinkingConfig(thinking_budget=0),
    )

    try:
        response, used_model_name = await generate_gemini_with_model_fallback(
            client,
            model_name,
            fallback_model_name,
            [
                f"ENTRY TIMEFRAME SCREENSHOT: {symbol} {entry_timeframe_label}",
                entry_image_part,
                f"ENTRY TIMEFRAME JSON:\n{json.dumps(entry_context, separators=(',', ':'))}",
                f"TREND TIMEFRAME SCREENSHOT: {symbol} {trend_timeframe_label}",
                trend_image_part,
                f"TREND TIMEFRAME JSON:\n{json.dumps(trend_context, separators=(',', ':'))}",
                prompt,
            ],
            config,
        )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=502, detail="Failed to fetch Gemini analysis. Please try again later.")

    try:
        parsed = extract_gemini_json(response)
        parsed = normalize_gemini_response(parsed)
        ai = AIResponseModel.parse_obj(parsed)
        result = ai.dict()
        result["timeframe_levels"] = validate_ai_timeframe_levels(result["timeframe_levels"], timeframe_levels)
        result["support_price"] = result["timeframe_levels"][entry_timeframe]["support_price"]
        result["resistance_price"] = result["timeframe_levels"][entry_timeframe]["resistance_price"]
        result["indicators"] = indicators
        result["historical_setup"] = historical_setup
        result["analysis_mode"] = analysis_mode
        result["symbol"] = symbol
        result["model"] = used_model_name
        result["entry_timeframe"] = entry_timeframe
        result["trend_timeframe"] = trend_timeframe
        result["level_price_reference"] = price_reference
        result["timeframe_candle_counts"] = {
            entry_timeframe: len(ohlcv),
            trend_timeframe: len(trend_ohlcv),
        }
        return apply_signal_quality_gate(result, indicators, current_reference_price, entry_timeframe, trend_timeframe)
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
async def get_market_candles(symbol: str = Query(default="MNT/USDT"), timeframe: str = Query(default="1h")):
    symbol = normalize_symbol(symbol)
    timeframe = timeframe.lower()
    if timeframe not in SUPPORTED_MARKET_TIMEFRAMES:
        raise HTTPException(status_code=400, detail="Unsupported market chart timeframe")
    ohlcv, source = await fetch_candles(symbol, timeframe, 102)
    
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

    display_name = "Bybit Spot" if source.startswith("bybit") else "BingX Spot fallback"
    return {
        "symbol": symbol,
        "exchange": display_name,
        "source": source,
        "timeframe": timeframe.upper(),
        "candles": candles,
    }


@app.get("/api/market/catalog")
async def get_market_catalog():
    try:
        markets = await run_in_threadpool(fetch_market_catalog)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to load Bybit spot markets: {exc}")
    return {
        "exchange": market_catalog_cache["exchange"],
        "source": market_catalog_cache["source"],
        "quote": "USDT",
        "markets": markets,
        "cached_for_seconds": MARKET_CATALOG_TTL_SECONDS,
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


@app.post("/api/performance/evaluate")
async def performance_evaluate(request: PerformanceEvaluateRequest):
    all_buy_signals = [signal for signal in request.signals if signal.action.strip().upper() == "BUY"]
    buy_signals = [signal for signal in all_buy_signals if signal.timestamp >= PERFORMANCE_TRACKING_START_TIMESTAMP]
    now_timestamp = int(time.time())
    evaluations = await asyncio.gather(*(evaluate_buy_signal(signal, now_timestamp) for signal in buy_signals))
    evaluated = [item for item in evaluations if item["status"] == "evaluated"]
    opportunities = [item for item in evaluated if item["outcome"] in {"PROFIT_OPPORTUNITY", "REVERSED"}]
    average_return = sum(float(item["return_percent"]) for item in evaluated) / len(evaluated) if evaluated else 0.0
    average_mfe = sum(float(item["mfe_percent"]) for item in evaluated) / len(evaluated) if evaluated else 0.0
    average_mae = sum(float(item["mae_percent"]) for item in evaluated) / len(evaluated) if evaluated else 0.0
    return {
        "methodology": {
            "tracked_action": "BUY",
            "evaluation_window_hours": BUY_EVALUATION_WINDOW_SECONDS // 3600,
            "evaluation_timeframe": BUY_EVALUATION_TIMEFRAME,
            "tracking_start_timestamp": PERFORMANCE_TRACKING_START_TIMESTAMP,
            "profit_opportunity_threshold_percent": BUY_PROFIT_OPPORTUNITY_THRESHOLD_PERCENT,
            "outcome_rule": "Tracks BUY signals created after the strict quality-gate launch across their full 24-hour candle path. Legacy BUY and HOLD signals are excluded.",
        },
        "metrics": {
            "tracked_buy_signals": len(evaluations),
            "legacy_buy_signals_excluded": len(all_buy_signals) - len(buy_signals),
            "evaluated_signals": len(evaluated),
            "pending_signals": sum(item["status"] == "pending" for item in evaluations),
            "unavailable_signals": sum(item["status"] == "unavailable" for item in evaluations),
            "profit_opportunities": len(opportunities),
            "reversed_signals": sum(item["outcome"] == "REVERSED" for item in evaluated),
            "losses": sum(item["outcome"] == "LOSS" for item in evaluated),
            "opportunity_rate_percent": round(len(opportunities) / len(evaluated) * 100, 1) if evaluated else None,
            "average_mfe_percent": round(average_mfe, 2) if evaluated else None,
            "average_mae_percent": round(average_mae, 2) if evaluated else None,
            "average_return_percent": round(average_return, 2) if evaluated else None,
        },
        "evaluations": sorted(evaluations, key=lambda item: item["signal_timestamp"], reverse=True),
    }


@app.get("/api/billing/status")
async def billing_status():
    contract_address = get_credit_vault_address()
    auto_consume_enabled = bool(os.getenv("BILLING_OWNER_PRIVATE_KEY")) and Web3 is not None
    local_bypass = local_analysis_billing_bypass_enabled()
    return {
        "enabled": True,
        "network": "Mantle Sepolia testnet",
        "credit_required_for_analysis": get_credit_required(),
        "contract_address": contract_address or None,
        "auto_consume_enabled": auto_consume_enabled,
        "local_billing_bypass": local_bypass,
        "signature_required": True,
        "note": (
            "Local billing bypass is enabled; wallet signatures remain required and no credits are consumed."
            if local_bypass
            else "AI analysis requires a wallet signature and enough Mantle Sepolia demo "
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
    local_bypass = local_analysis_billing_bypass_enabled()
    if request.nonce in used_billing_nonces:
        raise HTTPException(status_code=409, detail="Billing nonce already used")

    wallet_address = verify_analysis_signature(
        request.wallet_address,
        request.signature,
        request.nonce,
        credit_amount,
        symbol,
        request.message,
        request.analysis_mode,
    )
    if not local_bypass:
        await run_in_threadpool(assert_billing_can_consume)
        balance = await run_in_threadpool(get_credit_balance, wallet_address)
        if balance < credit_amount:
            raise HTTPException(status_code=402, detail="Insufficient AI credits")

    analysis = await get_gemini_analysis(symbol, request.analysis_mode)
    if local_bypass:
        analysis["credits_consumed"] = 0
        analysis["billing_mode"] = "local_billing_bypass"
    else:
        consume_tx_hash = await run_in_threadpool(consume_analysis_credit, wallet_address, credit_amount)
        analysis["credits_consumed"] = credit_amount
        analysis["credit_consume_tx_hash"] = consume_tx_hash
    used_billing_nonces.add(request.nonce)
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
