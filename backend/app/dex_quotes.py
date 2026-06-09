import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from threading import Lock
from urllib.parse import urlencode
from urllib.request import Request, urlopen


MANTLE_CHAIN_ID = 5000
MANTLE_SEPOLIA_CHAIN_ID = 5003
NATIVE_MNT_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
MANTLE_USDT_ADDRESS = "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE"
WMNT_ADDRESS = "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8"
MANTLE_MAINNET_RPC_URL = os.getenv("MANTLE_MAINNET_RPC_URL", "https://rpc.mantle.xyz")
MANTLE_SEPOLIA_RPC_URL = os.getenv("MANTLE_SEPOLIA_RPC_URL", "https://rpc.sepolia.mantle.xyz")

FUSIONX_MAINNET_V2_ROUTER = "0xDd0840118bF9CCCc6d67b2944ddDfbdb995955FD"
FUSIONX_TESTNET_V2_ROUTER = "0x45e6f621c5ED8616cCFB9bBaeBAcF9638aBB0033"
FUSIONX_TESTNET_USDT = "0xa9b72cCC9968aFeC98A96239B5AA48d828e8D827"
FUSIONX_TESTNET_WMNT = "0x8734110e5e1dcF439c7F549db740E546fea82d66"
FUSIONX_GET_AMOUNTS_OUT_SELECTOR = "d06ca61f"

MERCHANT_MOE_QUOTER = "0x501b8AFd35df20f531fF45F6f695793AC3316c85"
AGNI_QUOTER = "0x9488C05a7b75a6FefdcAE4f11a33467bcBA60177"
UNISWAP_V3_QUOTER = "0xdD489C75be1039ec7d843A6aC2Fd658350B067Cf"

MERCHANT_MOE_QUOTE_SELECTOR = "0f902a40"
AGNI_QUOTE_SELECTOR = "f7729d43"
UNISWAP_V3_QUOTE_SELECTOR = "c6a5026a"

AGNI_FEE_TIERS = (100, 500, 3000, 10_000)
UNISWAP_FEE_TIERS = (100, 500, 3000, 10_000)
OPENOCEAN_TIMEOUTS = (6, 14)
OPENOCEAN_CACHE_TTL_SECONDS = 120
_openocean_cache = {}
_openocean_cache_lock = Lock()


def _as_decimal(value, default="0") -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal(default)


def _human_token_amount(value, decimals: int) -> float:
    amount = _as_decimal(value)
    if amount > Decimal(10) ** max(decimals - 2, 1):
        amount = amount / (Decimal(10) ** decimals)
    return float(amount)


def _extract_route(payload: dict) -> str:
    dexes = payload.get("dexes") or payload.get("route") or []
    if isinstance(dexes, list):
        names = []
        for item in dexes:
            if isinstance(item, str):
                names.append(item)
            elif isinstance(item, dict):
                name = item.get("dexCode") or item.get("name") or item.get("dex")
                if name:
                    names.append(str(name))
        if names:
            return " -> ".join(dict.fromkeys(names))
    return "Best aggregated route"


def _word(value: int) -> str:
    return f"{value:064x}"


def _address_word(address: str) -> str:
    return address.lower().removeprefix("0x").rjust(64, "0")


def _rpc_eth_call(to: str, data: str, timeout: int = 8, rpc_url: str = MANTLE_MAINNET_RPC_URL) -> bytes:
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "method": "eth_call",
            "params": [{"to": to, "data": f"0x{data.removeprefix('0x')}"}, "latest"],
            "id": 1,
        }
    ).encode("utf-8")
    request = Request(
        rpc_url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "Mantle-AI-Trader/0.6"},
        method="POST",
    )
    with urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("error"):
        raise ValueError(payload["error"].get("message", "Mantle RPC call failed"))
    result = payload.get("result", "0x")
    if not isinstance(result, str) or result == "0x":
        raise ValueError("Mantle RPC returned no quote")
    return bytes.fromhex(result.removeprefix("0x"))


def _uint_at(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset:offset + 32], "big")


def _dynamic_uint_array(data: bytes, tuple_base: int, field_index: int) -> list[int]:
    array_offset = _uint_at(data, tuple_base + field_index * 32)
    array_base = tuple_base + array_offset
    length = _uint_at(data, array_base)
    return [_uint_at(data, array_base + 32 + index * 32) for index in range(length)]


def _available_quote(
    provider: str,
    amount_in: float,
    amount_out_wei: int,
    route: str,
    note: str = "Live Mantle mainnet contract quote",
    **details,
) -> dict:
    amount_out = float(Decimal(amount_out_wei) / Decimal(10 ** 18))
    if amount_out <= 0:
        raise ValueError(f"{provider} returned an empty quote")
    return {
        "provider": provider,
        "kind": "direct",
        "status": "available",
        "amount_in": amount_in,
        "amount_out": amount_out,
        "rate": amount_out / amount_in,
        "route": route,
        "note": note,
        **details,
    }


def _request_openocean_quote(url: str, timeout: int) -> dict:
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "Mantle-AI-Trader/0.6"})
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _cached_openocean_quote(amount_in: float) -> dict | None:
    with _openocean_cache_lock:
        cached = _openocean_cache.get(amount_in)
        if not cached or time.monotonic() - cached["stored_at"] > OPENOCEAN_CACHE_TTL_SECONDS:
            return None
        quote = deepcopy(cached["quote"])
    quote["note"] = "Recent OpenOcean quote used after a temporary API timeout"
    quote["stale"] = True
    return quote


def fetch_openocean_quote(amount_in: float) -> dict:
    params = urlencode(
        {
            "inTokenAddress": MANTLE_USDT_ADDRESS,
            "outTokenAddress": NATIVE_MNT_ADDRESS,
            "amount": f"{amount_in:g}",
            "gasPrice": "0.02",
        }
    )
    url = f"https://open-api.openocean.finance/v3/{MANTLE_CHAIN_ID}/quote?{params}"
    body = None
    last_error = None
    for timeout in OPENOCEAN_TIMEOUTS:
        try:
            body = _request_openocean_quote(url, timeout)
            break
        except Exception as exc:
            last_error = exc
    if body is None:
        cached = _cached_openocean_quote(amount_in)
        if cached:
            return cached
        raise last_error or ValueError("OpenOcean quote request failed")

    payload = body.get("data") if isinstance(body.get("data"), dict) else body
    if not isinstance(payload, dict) or payload.get("outAmount") is None:
        raise ValueError("OpenOcean returned no quote")

    out_decimals = int((payload.get("outToken") or {}).get("decimals", 18))
    amount_out = _human_token_amount(payload.get("outAmount"), out_decimals)
    if amount_out <= 0:
        raise ValueError("OpenOcean returned an empty quote")

    quote = {
        "provider": "OpenOcean",
        "kind": "aggregator",
        "status": "available",
        "amount_in": amount_in,
        "amount_out": amount_out,
        "rate": amount_out / amount_in,
        "route": _extract_route(payload),
        "estimated_gas": payload.get("estimatedGas") or payload.get("gas"),
        "price_impact_percent": payload.get("priceImpact"),
        "note": "Live Mantle mainnet quote",
    }
    with _openocean_cache_lock:
        _openocean_cache[amount_in] = {"stored_at": time.monotonic(), "quote": deepcopy(quote)}
    return quote


def fetch_merchant_moe_quote(amount_in: float) -> dict:
    amount_raw = int(Decimal(str(amount_in)) * Decimal(10 ** 6))
    calldata = (
        MERCHANT_MOE_QUOTE_SELECTOR
        + _word(64)
        + _word(amount_raw)
        + _word(2)
        + _address_word(MANTLE_USDT_ADDRESS)
        + _address_word(WMNT_ADDRESS)
    )
    data = _rpc_eth_call(MERCHANT_MOE_QUOTER, calldata)
    tuple_base = _uint_at(data, 0)
    bin_steps = _dynamic_uint_array(data, tuple_base, 2)
    versions = _dynamic_uint_array(data, tuple_base, 3)
    amounts = _dynamic_uint_array(data, tuple_base, 4)
    fees = _dynamic_uint_array(data, tuple_base, 6)
    if len(amounts) < 2:
        raise ValueError("Merchant Moe returned no route")
    version = versions[0] if versions else None
    version_label = {0: "V1", 1: "V2", 2: "V2.1", 3: "V2.2"}.get(version, f"V{version}")
    return _available_quote(
        "Merchant Moe",
        amount_in,
        amounts[-1],
        f"USDT -> WMNT | LB {version_label} bin {bin_steps[0] if bin_steps else '-'}",
        fee_amount_wei=str(fees[0]) if fees else None,
    )


def _fetch_v3_quote(provider: str, quoter: str, selector: str, amount_in: float, fee_tiers, tuple_input: bool) -> dict:
    amount_raw = int(Decimal(str(amount_in)) * Decimal(10 ** 6))
    candidates = []
    for fee in fee_tiers:
        calldata = (
            selector
            + _address_word(MANTLE_USDT_ADDRESS)
            + _address_word(WMNT_ADDRESS)
            + (_word(amount_raw) + _word(fee) if tuple_input else _word(fee) + _word(amount_raw))
            + _word(0)
        )
        try:
            data = _rpc_eth_call(quoter, calldata)
            amount_out = _uint_at(data, 0)
            gas_estimate = _uint_at(data, 96) if tuple_input and len(data) >= 128 else None
            if amount_out > 0:
                candidates.append((amount_out, fee, gas_estimate))
        except Exception:
            continue
    if not candidates:
        raise ValueError(f"{provider} has no direct USDT/WMNT quote")
    amount_out, fee, gas_estimate = max(candidates, key=lambda item: item[0])
    return _available_quote(
        provider,
        amount_in,
        amount_out,
        f"USDT -> WMNT | fee {fee / 10_000:.2f}%",
        estimated_gas=gas_estimate,
        fee_tier=fee,
    )


def fetch_agni_quote(amount_in: float) -> dict:
    return _fetch_v3_quote("Agni", AGNI_QUOTER, AGNI_QUOTE_SELECTOR, amount_in, AGNI_FEE_TIERS, False)


def fetch_uniswap_v3_quote(amount_in: float) -> dict:
    return _fetch_v3_quote(
        "Uniswap V3",
        UNISWAP_V3_QUOTER,
        UNISWAP_V3_QUOTE_SELECTOR,
        amount_in,
        UNISWAP_FEE_TIERS,
        True,
    )


def _fetch_fusionx_v2_quote(
    amount_in: float,
    router: str,
    token_in: str,
    token_out: str,
    rpc_url: str,
    note: str,
) -> dict:
    amount_raw = int(Decimal(str(amount_in)) * Decimal(10 ** 6))
    calldata = (
        FUSIONX_GET_AMOUNTS_OUT_SELECTOR
        + _word(amount_raw)
        + _word(64)
        + _word(2)
        + _address_word(token_in)
        + _address_word(token_out)
    )
    data = _rpc_eth_call(router, calldata, rpc_url=rpc_url)
    amounts = _dynamic_uint_array(data, 0, 0)
    if len(amounts) < 2:
        raise ValueError("FusionX returned no USDT/WMNT route")
    return _available_quote(
        "FusionX V2",
        amount_in,
        amounts[-1],
        "USDT -> wrapped MNT",
        note=note,
        router=router,
    )


def fetch_fusionx_mainnet_quote(amount_in: float) -> dict:
    return _fetch_fusionx_v2_quote(
        amount_in,
        FUSIONX_MAINNET_V2_ROUTER,
        MANTLE_USDT_ADDRESS,
        WMNT_ADDRESS,
        MANTLE_MAINNET_RPC_URL,
        "Live Mantle mainnet FusionX contract quote",
    )


def fetch_fusionx_testnet_quote(amount_in: float) -> dict:
    return _fetch_fusionx_v2_quote(
        amount_in,
        FUSIONX_TESTNET_V2_ROUTER,
        FUSIONX_TESTNET_USDT,
        FUSIONX_TESTNET_WMNT,
        MANTLE_SEPOLIA_RPC_URL,
        "Live Mantle Sepolia FusionX contract quote",
    )


MAINNET_FETCHERS = (
    ("OpenOcean", "aggregator", fetch_openocean_quote),
    ("Merchant Moe", "direct", fetch_merchant_moe_quote),
    ("Agni", "direct", fetch_agni_quote),
    ("Uniswap V3", "direct", fetch_uniswap_v3_quote),
    ("FusionX V2", "direct", fetch_fusionx_mainnet_quote),
)
SEPOLIA_FETCHERS = (("FusionX V2", "direct", fetch_fusionx_testnet_quote),)
DEFAULT_FETCHERS = MAINNET_FETCHERS


def get_read_only_quotes(symbol: str, amount_in: float, provider_fetchers=None, network: str = "mantle_mainnet") -> dict:
    if symbol != "MNT/USDT":
        raise ValueError("DEX quote preview currently supports MNT/USDT only")
    if amount_in <= 0 or amount_in > 10_000:
        raise ValueError("Quote amount must be greater than 0 and no more than 10,000 USDT")

    if network not in {"mantle_mainnet", "mantle_sepolia"}:
        raise ValueError("DEX quote network must be mantle_mainnet or mantle_sepolia")

    is_sepolia = network == "mantle_sepolia"
    fetchers = provider_fetchers or (SEPOLIA_FETCHERS if is_sepolia else MAINNET_FETCHERS)
    quotes_by_provider = {}
    with ThreadPoolExecutor(max_workers=len(fetchers)) as executor:
        futures = {
            executor.submit(fetcher, amount_in): (provider, kind)
            for provider, kind, fetcher in fetchers
        }
        for future in as_completed(futures):
            provider, kind = futures[future]
            try:
                quotes_by_provider[provider] = future.result()
            except Exception as exc:
                quotes_by_provider[provider] = {
                    "provider": provider,
                    "kind": kind,
                    "status": "unavailable",
                    "note": f"Quote unavailable: {str(exc)[:120]}",
                }
    quotes = [quotes_by_provider[provider] for provider, _, _ in fetchers]

    available = [quote for quote in quotes if quote.get("status") == "available"]
    best_provider = max(available, key=lambda quote: quote.get("amount_out", 0))["provider"] if available else None
    best_amount_out = max((quote.get("amount_out", 0) for quote in available), default=0)
    if best_amount_out:
        for quote in available:
            quote["difference_from_best_percent"] = round(
                ((quote["amount_out"] / best_amount_out) - 1) * 100,
                2,
            )

    return {
        "mode": "read_only",
        "network": "Mantle Sepolia" if is_sepolia else "Mantle Mainnet",
        "chain_id": MANTLE_SEPOLIA_CHAIN_ID if is_sepolia else MANTLE_CHAIN_ID,
        "symbol": symbol,
        "token_in": {
            "symbol": "USDT",
            "variant": "FusionX testnet USDT" if is_sepolia else "Mantle bridged legacy USDT",
            "address": FUSIONX_TESTNET_USDT if is_sepolia else MANTLE_USDT_ADDRESS,
            "amount": amount_in,
        },
        "token_out": {
            "symbol": "MNT",
            "address": FUSIONX_TESTNET_WMNT if is_sepolia else NATIVE_MNT_ADDRESS,
        },
        "best_provider": best_provider,
        "quotes": quotes,
        "quoted_at": datetime.now(timezone.utc).isoformat(),
        "execution_enabled": False,
        "warning": "Preview only. No approval, calldata, signature, or transaction is created.",
    }
