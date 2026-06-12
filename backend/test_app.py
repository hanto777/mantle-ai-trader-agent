import unittest
import importlib
import json
from unittest.mock import patch

import app.main as app
from app.dex_quotes import get_read_only_quotes

dex_quotes = importlib.import_module("app.dex_quotes")


class TestPortfolioMarkets(unittest.TestCase):
    def test_fetch_portfolio_market_data_normalizes_coingecko_response(self):
        response = {
            "mantle": {
                "usd": 0.54,
                "usd_24h_change": 2.5,
                "last_updated_at": 123,
            }
        }
        mocked_response = unittest.mock.MagicMock()
        mocked_response.read.return_value = json.dumps(response).encode("utf-8")
        mocked_response.__enter__.return_value = mocked_response

        with patch("urllib.request.urlopen", return_value=mocked_response):
            result = app.fetch_portfolio_market_data(["mantle"])

        self.assertEqual(result[0]["symbol"], "MNT")
        self.assertEqual(result[0]["price_usd"], 0.54)
        self.assertEqual(result[0]["change_24h_percent"], 2.5)

    def test_defillama_fallback_returns_price_and_uses_cached_change(self):
        app.portfolio_market_cache["mantle"] = {"change_24h_percent": 2.5}
        response = {
            "coins": {
                "coingecko:mantle": {
                    "price": 0.55,
                    "timestamp": 456,
                }
            }
        }
        mocked_response = unittest.mock.MagicMock()
        mocked_response.read.return_value = json.dumps(response).encode("utf-8")
        mocked_response.__enter__.return_value = mocked_response

        with patch("urllib.request.urlopen", return_value=mocked_response):
            result = app.fetch_portfolio_defillama_fallback(["mantle"])

        self.assertEqual(result[0]["price_usd"], 0.55)
        self.assertEqual(result[0]["change_24h_percent"], 2.5)
        self.assertEqual(result[0]["last_updated_at"], 456)


class TestConfidenceNormalization(unittest.TestCase):
    """Test confidence normalization from Gemini responses."""

    def test_normalize_confidence_decimal_0_6_stays_0_6(self):
        """0.6 should remain 0.6"""
        result = app.normalize_confidence(0.6)
        self.assertAlmostEqual(result, 0.6)

    def test_normalize_confidence_decimal_0_to_1(self):
        """Any value 0-1 should stay as-is"""
        for val in [0.0, 0.1, 0.5, 0.75, 1.0]:
            result = app.normalize_confidence(val)
            self.assertAlmostEqual(result, val)

    def test_normalize_confidence_percent_60_becomes_0_6(self):
        """60 should become 0.6"""
        result = app.normalize_confidence(60)
        self.assertAlmostEqual(result, 0.6)

    def test_normalize_confidence_percent_100_becomes_1_0(self):
        """100 should become 1.0"""
        result = app.normalize_confidence(100)
        self.assertAlmostEqual(result, 1.0)

    def test_normalize_confidence_percent_range(self):
        """Test various percentage values"""
        test_cases = [
            (10, 0.1),
            (50, 0.5),
            (75, 0.75),
            (90, 0.9),
        ]
        for input_val, expected in test_cases:
            result = app.normalize_confidence(input_val)
            self.assertAlmostEqual(result, expected, places=5)

    def test_normalize_confidence_rejects_101(self):
        """101 should raise ValueError"""
        with self.assertRaises(ValueError):
            app.normalize_confidence(101)

    def test_normalize_confidence_rejects_negative(self):
        """Negative values should raise ValueError"""
        with self.assertRaises(ValueError):
            app.normalize_confidence(-0.1)

    def test_extract_gemini_json_prefers_structured_response(self):
        response = unittest.mock.MagicMock()
        response.parsed = {"action": "HOLD", "confidence": 0.7}
        response.text = "not used"

        result = app.extract_gemini_json(response)

        self.assertEqual(result["action"], "HOLD")

    def test_extract_gemini_json_uses_text_fallback(self):
        response = unittest.mock.MagicMock()
        response.parsed = None
        response.text = '```json\\n{"action":"SELL","confidence":0.8}\\n```'

        result = app.extract_gemini_json(response)

        self.assertEqual(result["action"], "SELL")

    def test_extract_gemini_json_rejects_empty_response(self):
        response = unittest.mock.MagicMock()
        response.parsed = None
        response.text = None
        response.candidates = []

        with self.assertRaisesRegex(ValueError, "finish reason"):
            app.extract_gemini_json(response)

    def test_local_billing_bypass_is_opt_in(self):
        with patch.dict("os.environ", {}, clear=True):
            self.assertFalse(app.local_analysis_billing_bypass_enabled())
        with patch.dict("os.environ", {"LOCAL_ANALYSIS_BILLING_BYPASS": "true"}, clear=True):
            self.assertTrue(app.local_analysis_billing_bypass_enabled())


class TestMarketCatalog(unittest.TestCase):
    def setUp(self):
        app.market_catalog_cache.update({"stored_at": 0.0, "markets": [], "exchange": "Bybit Spot", "source": "bybit"})

    def test_normalize_symbol_accepts_standard_usdt_pair(self):
        self.assertEqual(app.normalize_symbol(" aave/usdt "), "AAVE/USDT")

    def test_normalize_symbol_rejects_non_usdt_pair(self):
        with self.assertRaises(Exception):
            app.normalize_symbol("AAVE/USDC")

    def test_market_catalog_keeps_active_spot_usdt_pairs(self):
        exchange = unittest.mock.MagicMock()
        exchange.load_markets.return_value = {
            "AAVE/USDT": {"symbol": "AAVE/USDT", "base": "AAVE", "quote": "USDT", "spot": True, "active": True},
            "BTC/USDC": {"symbol": "BTC/USDC", "base": "BTC", "quote": "USDC", "spot": True, "active": True},
            "ETH3L/USDT": {"symbol": "ETH3L/USDT", "base": "ETH3L", "quote": "USDT", "spot": True, "active": True},
            "OLD/USDT": {"symbol": "OLD/USDT", "base": "OLD", "quote": "USDT", "spot": True, "active": False},
        }
        with patch.object(app, "create_spot_exchange", return_value=exchange):
            result = app.fetch_market_catalog()

        self.assertEqual([market["symbol"] for market in result], ["AAVE/USDT"])

    def test_market_catalog_uses_official_bytick_before_bingx(self):
        bytick = unittest.mock.MagicMock()
        bytick.load_markets.return_value = {
            "AAVE/USDT": {"symbol": "AAVE/USDT", "base": "AAVE", "quote": "USDT", "spot": True, "active": True},
        }
        with patch.object(app, "create_spot_exchange", side_effect=[TimeoutError("blocked"), bytick]) as create:
            result = app.fetch_market_catalog()

        self.assertEqual(result[0]["symbol"], "AAVE/USDT")
        self.assertEqual(app.market_catalog_cache["source"], "bybit-bytick")
        self.assertEqual(create.call_args_list[1].args, ("bybit", "bytick.com"))

    def test_normalize_gemini_response_with_decimal(self):
        """normalize_gemini_response should handle 0.6 correctly"""
        response = {
            "action": "BUY",
            "support_price": 1.0,
            "resistance_price": 1.05,
            "confidence": 0.6,
            "reason": "test"
        }
        result = app.normalize_gemini_response(response)
        self.assertAlmostEqual(result["confidence"], 0.6)

    def test_normalize_gemini_response_with_percent(self):
        """normalize_gemini_response should convert 60 to 0.6"""
        response = {
            "action": "BUY",
            "support_price": 1.0,
            "resistance_price": 1.05,
            "confidence": 60,
            "reason": "test"
        }
        result = app.normalize_gemini_response(response)
        self.assertAlmostEqual(result["confidence"], 0.6)

    def test_normalize_gemini_response_rejects_invalid(self):
        """normalize_gemini_response should reject values > 100"""
        response = {
            "action": "BUY",
            "support_price": 1.0,
            "resistance_price": 1.05,
            "confidence": 101,
            "reason": "test"
        }
        with self.assertRaises(ValueError):
            app.normalize_gemini_response(response)

    def test_normalize_gemini_response_accepts_lowercase_sell(self):
        response = {
            "action": "sell",
            "support_price": 0.90,
            "resistance_price": 1.05,
            "confidence": 0.8,
            "reason": "Bearish confirmation",
        }

        result = app.normalize_gemini_response(response)

        self.assertEqual(result["action"], "SELL")

    def test_sell_quality_gate_accepts_confirmed_bearish_setup(self):
        analysis = {"action": "SELL", "confidence": 0.82, "reason": "Bearish setup"}
        indicators = {
            "1h": {"macd_state": "bearish", "rsi_state": "neutral", "stochastic_state": "neutral"},
            "1d": {"macd_state": "bearish", "rsi_state": "neutral", "stochastic_state": "overbought"},
        }

        result = app.apply_signal_quality_gate(analysis, indicators)

        self.assertEqual(result["action"], "SELL")

    def test_sell_quality_gate_downgrades_unconfirmed_sell(self):
        analysis = {"action": "SELL", "confidence": 0.82, "reason": "Possible rejection"}
        indicators = {
            "1h": {"macd_state": "bullish", "rsi_state": "neutral", "stochastic_state": "neutral"},
            "1d": {"macd_state": "bearish", "rsi_state": "neutral", "stochastic_state": "neutral"},
        }

        result = app.apply_signal_quality_gate(analysis, indicators)

        self.assertEqual(result["action"], "HOLD")
        self.assertIn("1H MACD", result["reason"])

    def test_sell_quality_gate_avoids_oversold_exhaustion(self):
        analysis = {"action": "SELL", "confidence": 0.90, "reason": "Strong decline"}
        indicators = {
            "1h": {"macd_state": "bearish", "rsi_state": "oversold", "stochastic_state": "oversold"},
            "1d": {"macd_state": "bearish", "rsi_state": "oversold", "stochastic_state": "oversold"},
        }

        result = app.apply_signal_quality_gate(analysis, indicators)

        self.assertEqual(result["action"], "HOLD")
        self.assertIn("oversold", result["reason"])

    def test_sell_quality_gate_requires_downside_room_and_invalidation(self):
        analysis = {
            "action": "SELL",
            "confidence": 0.90,
            "support_price": 99.0,
            "resistance_price": 99.5,
            "reason": "Bearish momentum",
        }
        indicators = {
            "1h": {"macd_state": "bearish", "rsi_state": "neutral", "stochastic_state": "neutral"},
            "1d": {"macd_state": "bearish", "rsi_state": "neutral", "stochastic_state": "neutral"},
        }

        result = app.apply_signal_quality_gate(analysis, indicators, current_price=100.0)

        self.assertEqual(result["action"], "HOLD")
        self.assertIn("downside room", result["reason"])
        self.assertIn("invalidation level", result["reason"])


class TestTechnicalIndicators(unittest.TestCase):
    @staticmethod
    def make_candles(close_values):
        return [
            [index * 3_600_000, close - 0.2, close + 0.5, close - 0.5, close, 1000 + index]
            for index, close in enumerate(close_values)
        ]

    def test_calculate_indicators_returns_multi_signal_values(self):
        closes = [100 + ((index % 12) - 6) * 0.4 + index * 0.02 for index in range(120)]
        result = app.calculate_indicators(self.make_candles(closes))

        self.assertIn(result["rsi_state"], {"oversold", "neutral", "overbought"})
        self.assertIn(result["macd_state"], {"bullish", "bearish"})
        self.assertIn(result["stochastic_state"], {"oversold", "neutral", "overbought"})
        self.assertIsInstance(result["stochastic_k"], float)
        self.assertIsInstance(result["stochastic_d"], float)

    def test_calculate_indicators_handles_flat_market(self):
        result = app.calculate_indicators(self.make_candles([100.0] * 120))

        self.assertEqual(result["rsi"], 50.0)
        self.assertEqual(result["stochastic_k"], 50.0)
        self.assertEqual(result["stochastic_d"], 50.0)
        self.assertEqual(result["stochastic_state"], "neutral")

    def test_calculate_timeframe_levels_returns_local_boundaries(self):
        closes = [100, 101, 102, 101, 99, 98, 100, 103, 105, 104, 102, 101, 103]

        result = app.calculate_timeframe_levels(self.make_candles(closes))

        self.assertEqual(result["current_price"], 103)
        self.assertLess(result["support_price"], result["current_price"])
        self.assertGreater(result["resistance_price"], result["current_price"])
        self.assertIn("support_distance_percent", result)
        self.assertIn("resistance_distance_percent", result)
        self.assertIn(result["support_role"], {"demand", "former_resistance"})
        self.assertIn(result["resistance_role"], {"supply", "former_support"})

    def test_calculate_timeframe_levels_uses_shared_current_price(self):
        closes = [100, 101, 102, 101, 99, 98, 100, 103, 105, 104, 102, 101, 103]

        result = app.calculate_timeframe_levels(self.make_candles(closes), current_price_override=99)

        self.assertEqual(result["current_price"], 99)
        self.assertLessEqual(result["support_price"], 99)
        self.assertGreaterEqual(result["resistance_price"], 99)

    def test_build_timeframe_context_digitizes_chart_data(self):
        candles = self.make_candles([100 + index for index in range(80)])
        indicators = app.calculate_indicators(candles)
        reference = app.calculate_timeframe_levels(candles, current_price_override=180)

        result = app.build_timeframe_context("4h", candles, indicators, 180, reference)

        self.assertEqual(result["timeframe"], "4h")
        self.assertEqual(result["live_spot_price"], 180)
        self.assertEqual(len(result["recent_ohlcv"]), 60)
        self.assertEqual(result["indicators"], indicators)

    def test_validate_ai_timeframe_levels_keeps_valid_visual_levels(self):
        reference = app.calculate_timeframe_levels(
            self.make_candles([100, 101, 102, 101, 99, 98, 100, 103, 105, 104, 102, 101, 103]),
            current_price_override=103,
        )

        result = app.validate_ai_timeframe_levels(
            {"1h": {"support_price": 100, "resistance_price": 106}},
            {"1h": reference},
        )

        self.assertEqual(result["1h"]["support_price"], 100)
        self.assertEqual(result["1h"]["resistance_price"], 106)
        self.assertEqual(result["1h"]["level_source"], "gemini")

    def test_historical_setup_match_returns_expected_shape(self):
        closes = [100 + (index % 20) * 0.5 + index * 0.03 for index in range(220)]

        result = app.calculate_historical_setup_match(self.make_candles(closes))

        self.assertIn(result["signal"], {"bullish", "bearish", "neutral", "insufficient"})
        self.assertGreaterEqual(result["similar_cases"], 0)
        self.assertEqual(result["evaluation_candles"], 12)
        self.assertIn("average_move_percent", result)

    def test_historical_setup_match_reports_insufficient_short_history(self):
        result = app.calculate_historical_setup_match(self.make_candles([100.0] * 40))

        self.assertEqual(result["signal"], "insufficient")
        self.assertEqual(result["insufficient_reason"], "insufficient_history")
        self.assertEqual(result["similar_cases"], 0)


class TestAnalysisModes(unittest.TestCase):
    def test_analysis_modes_use_expected_entry_and_trend_timeframes(self):
        self.assertEqual(app.ANALYSIS_MODES["scalping"]["entry"], "15m")
        self.assertEqual(app.ANALYSIS_MODES["scalping"]["trend"], "1h")
        self.assertEqual(app.ANALYSIS_MODES["intraday"]["entry"], "1h")
        self.assertEqual(app.ANALYSIS_MODES["intraday"]["trend"], "4h")
        self.assertEqual(app.ANALYSIS_MODES["swing"]["entry"], "4h")
        self.assertEqual(app.ANALYSIS_MODES["swing"]["trend"], "1d")
        self.assertEqual(app.ANALYSIS_MODES["position"]["entry"], "1d")
        self.assertEqual(app.ANALYSIS_MODES["position"]["trend"], "1w")
        self.assertEqual(app.ANALYSIS_MODES["macro"]["entry"], "1w")
        self.assertEqual(app.ANALYSIS_MODES["macro"]["trend"], "1M")

    def test_supported_chart_timeframes_match_mode_entries(self):
        self.assertEqual(app.SUPPORTED_MARKET_TIMEFRAMES, {"15m", "1h", "4h", "1d", "1w"})
        self.assertEqual(app.MIN_ANALYSIS_CANDLES, 35)

    def test_timeframe_display_name_distinguishes_month_from_minute(self):
        self.assertEqual(app.timeframe_display_name("1w"), "ONE WEEK (1W)")
        self.assertEqual(app.timeframe_display_name("1M"), "ONE MONTH (1M, not 1 minute)")
        self.assertEqual(app.timeframe_display_name("1m"), "ONE MINUTE (1m)")


class TestGeminiModelFallback(unittest.IsolatedAsyncioTestCase):
    async def test_uses_fallback_model_after_primary_rate_limit(self):
        fallback_response = object()
        with patch.object(
            app,
            "_generate_content_with_retry",
            side_effect=[app.HTTPException(status_code=429, detail="limited"), fallback_response],
        ) as generate:
            response, model = await app.generate_gemini_with_model_fallback(
                object(),
                "gemini-primary",
                "gemini-fallback",
                ["prompt"],
            )

        self.assertIs(response, fallback_response)
        self.assertEqual(model, "gemini-fallback")
        self.assertEqual(generate.await_count, 2)

    async def test_does_not_fallback_for_non_transient_error(self):
        with patch.object(
            app,
            "_generate_content_with_retry",
            side_effect=app.HTTPException(status_code=502, detail="bad request"),
        ) as generate:
            with self.assertRaises(app.HTTPException):
                await app.generate_gemini_with_model_fallback(
                    object(),
                    "gemini-primary",
                    "gemini-fallback",
                    ["prompt"],
                )

        self.assertEqual(generate.await_count, 1)


class TestPaperTrading(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._original_account = app.account
        app.account = app.PaperAccount()

    def tearDown(self):
        app.account = self._original_account

    def test_validate_buy_rejects_low_confidence(self):
        is_valid, reason = app.validate_buy(1.0, {
            "confidence": 0.5,
            "support_price": 0.99,
            "resistance_price": 1.05,
        })
        self.assertFalse(is_valid)
        self.assertIn("Confidence", reason)

    def test_validate_buy_rejects_price_above_support(self):
        is_valid, reason = app.validate_buy(1.02, {
            "confidence": 0.9,
            "support_price": 1.0,
            "resistance_price": 1.10,
        })
        self.assertFalse(is_valid)
        self.assertIn("Price $", reason)

    def test_validate_buy_rejects_low_resistance(self):
        is_valid, reason = app.validate_buy(1.0, {
            "confidence": 0.9,
            "support_price": 0.996,
            "resistance_price": 1.02,
        })
        self.assertFalse(is_valid)
        self.assertIn("Resistance", reason)

    def test_validate_buy_accepts_good_setup(self):
        is_valid, reason = app.validate_buy(1.0, {
            "confidence": 0.9,
            "support_price": 0.9951,
            "resistance_price": 1.05,
        })
        self.assertTrue(is_valid)
        self.assertEqual(reason, "OK")

    async def test_execute_and_close_trade_creates_history(self):
        analysis = {
            "support_price": 1.0,
            "resistance_price": 1.05,
            "confidence": 0.95,
            "action": "BUY",
        }
        trade = await app.execute_buy("MNT/USDT", 1.0, analysis)

        self.assertIsNotNone(app.account.open_trade)
        self.assertEqual(app.account.open_trade.id, trade.id)
        self.assertAlmostEqual(app.account.usdt_balance, 9000.0)
        self.assertGreater(app.account.mnt_held, 0)

        result = await app.close_trade("MNT/USDT", 1.03, "take_profit")
        self.assertIsNone(app.account.open_trade)
        self.assertEqual(app.account.cooldown_remaining, 4)
        self.assertEqual(len(app.account.trades_history), 1)
        self.assertEqual(result["close_reason"], "take_profit")
        self.assertGreater(result["pnl_usdt"], 0)


class TestDexQuotePreview(unittest.TestCase):
    def setUp(self):
        dex_quotes._openocean_cache.clear()

    def test_quote_snapshot_is_read_only(self):
        def fake_openocean(amount_in):
            return {
                "provider": "OpenOcean",
                "kind": "aggregator",
                "status": "available",
                "amount_in": amount_in,
                "amount_out": 201.5,
                "rate": 2.015,
                "route": "Merchant Moe",
                "estimated_gas": 123456,
                "price_impact_percent": "0.05",
                "note": "test quote",
            }

        def fake_direct(provider, amount_out):
            return lambda amount_in: {
                "provider": provider,
                "kind": "direct",
                "status": "available",
                "amount_in": amount_in,
                "amount_out": amount_out,
                "rate": amount_out / amount_in,
                "route": "USDT -> WMNT",
                "note": "test quote",
            }

        fetchers = (
            ("OpenOcean", "aggregator", fake_openocean),
            ("Merchant Moe", "direct", fake_direct("Merchant Moe", 201.0)),
            ("Agni", "direct", fake_direct("Agni", 199.0)),
            ("Uniswap V3", "direct", fake_direct("Uniswap V3", 180.0)),
        )
        result = get_read_only_quotes("MNT/USDT", 100, provider_fetchers=fetchers)

        self.assertEqual(result["best_provider"], "OpenOcean")
        self.assertFalse(result["execution_enabled"])
        self.assertEqual(len(result["quotes"]), 4)
        self.assertNotIn("calldata", result)
        self.assertEqual(result["quotes"][0]["difference_from_best_percent"], 0)
        self.assertLess(result["quotes"][3]["difference_from_best_percent"], 0)

    def test_quote_snapshot_keeps_failed_provider(self):
        def failed(_amount_in):
            raise ValueError("no liquidity")

        result = get_read_only_quotes(
            "MNT/USDT",
            100,
            provider_fetchers=(("Merchant Moe", "direct", failed),),
        )

        self.assertIsNone(result["best_provider"])
        self.assertEqual(result["quotes"][0]["status"], "unavailable")

    def test_quote_snapshot_rejects_unsupported_symbol(self):
        with self.assertRaises(ValueError):
            get_read_only_quotes("BTC/USDT", 100)

    def test_fusionx_testnet_quote_decodes_router_response(self):
        encoded = (
            (32).to_bytes(32, "big")
            + (2).to_bytes(32, "big")
            + (100_000_000).to_bytes(32, "big")
            + (250 * 10 ** 18).to_bytes(32, "big")
        )
        with patch.object(dex_quotes, "_rpc_eth_call", return_value=encoded) as rpc_call:
            quote = dex_quotes.fetch_fusionx_testnet_quote(100)

        self.assertEqual(quote["provider"], "FusionX V2")
        self.assertEqual(quote["amount_out"], 250)
        self.assertIn("Sepolia", quote["note"])
        self.assertEqual(rpc_call.call_args.kwargs["rpc_url"], dex_quotes.MANTLE_SEPOLIA_RPC_URL)

    def test_testnet_snapshot_uses_fusionx_metadata(self):
        result = get_read_only_quotes(
            "MNT/USDT",
            100,
            provider_fetchers=(("FusionX V2", "direct", lambda _: {
                "provider": "FusionX V2",
                "kind": "direct",
                "status": "available",
                "amount_in": 100,
                "amount_out": 200,
                "rate": 2,
                "route": "Testnet USDT -> wrapped MNT",
                "note": "test quote",
            }),),
            network="mantle_sepolia",
        )

        self.assertEqual(result["network"], "Mantle Sepolia")
        self.assertEqual(result["chain_id"], 5003)
        self.assertEqual(result["best_provider"], "FusionX V2")
        self.assertEqual(result["token_in"]["address"], dex_quotes.FUSIONX_TESTNET_USDT)

    def test_openocean_retries_after_temporary_failure(self):
        payload = {
            "outAmount": "200000000000000000000",
            "outToken": {"decimals": 18},
            "dexes": [{"dexCode": "MerchantMoe"}],
        }
        with patch.object(dex_quotes, "_request_openocean_quote", side_effect=[TimeoutError("slow"), payload]) as request:
            quote = dex_quotes.fetch_openocean_quote(100)

        self.assertEqual(request.call_count, 2)
        self.assertEqual(quote["status"], "available")
        self.assertAlmostEqual(quote["amount_out"], 200)

    def test_openocean_uses_recent_quote_after_retries_fail(self):
        payload = {
            "outAmount": "200000000000000000000",
            "outToken": {"decimals": 18},
            "dexes": [{"dexCode": "MerchantMoe"}],
        }
        with patch.object(dex_quotes, "_request_openocean_quote", return_value=payload):
            dex_quotes.fetch_openocean_quote(100)
        with patch.object(dex_quotes, "_request_openocean_quote", side_effect=TimeoutError("slow")):
            quote = dex_quotes.fetch_openocean_quote(100)

        self.assertTrue(quote["stale"])
        self.assertIn("temporary API timeout", quote["note"])

if __name__ == "__main__":
    unittest.main()
