import os
import asyncio
import json
from datetime import datetime, timezone
from typing import Literal, Optional
from enum import Enum

import ccxt
from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import io
import matplotlib
matplotlib.use("Agg")

import pandas as pd
import mplfinance as mpf

from pydantic import BaseModel, Field

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


# ===== Global State =====

account = PaperAccount()
agent_task: Optional[asyncio.Task] = None


# ===== Utility Functions =====

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


async def fetch_candles(symbol: str, timeframe: str = "1h", limit: int = 102) -> list:
    exchange = ccxt.bybit({"enableRateLimit": True})
    exchange.options["defaultType"] = "spot"
    try:
        ohlcv = await run_in_threadpool(exchange.fetch_ohlcv, symbol, timeframe, None, limit)
        if not ohlcv or len(ohlcv) < 2:
            raise ValueError("Insufficient candle data")
        return ohlcv[:-1]  # exclude last unclosed
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch candles: {e}")


async def get_gemini_analysis(symbol: str, timeframe: str = "1h") -> dict:
    """Fetch Gemini analysis for the symbol."""
    api_key = os.getenv("GEMINI_API_KEY")
    model_name = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

    if not api_key:
        raise HTTPException(status_code=400, detail="GEMINI_API_KEY not configured")

    # Fetch last 100 candles
    ohlcv = await fetch_candles(symbol, timeframe, 101)
    if len(ohlcv) < 100:
        raise HTTPException(status_code=502, detail="Insufficient closed candles for analysis")

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
        f"Analyze ONLY spot LONG scenario for {symbol}. Respond strictly with JSON only (no markdown). \n"
        "Return exactly the following schema:\n"
        "{\n  \"action\": \"BUY\" | \"HOLD\",\n  \"support_price\": number,\n  \"resistance_price\": number,\n  \"confidence\": number,\n  \"reason\": string\n}\n"
        "Provide numeric prices in the quote currency. Give concise reasoning. "
        "IMPORTANT: confidence must be a decimal number from 0.0 to 1.0 (for example 0.60), NOT 60."
    )

    try:
        response = client.models.generate_content(
            model=model_name,
            contents=[image_part, prompt]
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"GenAI request failed: {exc}")

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
        return ai.dict()
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
            current_ohlcv = await fetch_candles(symbol, "1h", 2)
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
async def get_market_candles():
    symbol = os.getenv("TRADING_SYMBOL", os.getenv("SYMBOL", "MNT/USDT"))
    ohlcv = await fetch_candles(symbol, "1h", 102)
    
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

    return {
        "symbol": symbol,
        "exchange": "Bybit Spot",
        "timeframe": "1H",
        "candles": candles,
    }


@app.get("/api/ai/status")
async def ai_status():
    configured = bool(os.getenv("GEMINI_API_KEY"))
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    return {"configured": configured, "model": model}


@app.post("/api/ai/analyze")
async def ai_analyze():
    symbol = os.getenv("TRADING_SYMBOL", os.getenv("SYMBOL", "MNT/USDT"))
    analysis = await get_gemini_analysis(symbol)
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
