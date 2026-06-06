import unittest

import app.main as app
from app.dex_quotes import get_read_only_quotes


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

if __name__ == "__main__":
    unittest.main()
