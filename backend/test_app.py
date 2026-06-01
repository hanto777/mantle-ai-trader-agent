import unittest

import app.main as app


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

if __name__ == "__main__":
    unittest.main()
