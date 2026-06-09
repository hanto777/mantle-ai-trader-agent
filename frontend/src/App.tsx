import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, type CandlestickData, type UTCTimestamp } from 'lightweight-charts'
import { ethers } from 'ethers'
import { TradeSignalRegistryABI, TRADE_SIGNAL_REGISTRY_ADDRESS, MANTLE_SEPOLIA_CHAIN_ID, MANTLE_SEPOLIA_CHAIN_ID_HEX, MANTLE_SEPOLIA_RPC } from './abi/TradeSignalRegistry'
import { AnalysisCreditVaultABI, ANALYSIS_CREDIT_REQUIRED, ANALYSIS_CREDIT_VAULT_ADDRESS } from './abi/AnalysisCreditVault'

const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000'
const portfolioApiBase = import.meta.env.VITE_PORTFOLIO_API_BASE_URL || apiBase
const dexApiBase = import.meta.env.VITE_DEX_API_BASE_URL || portfolioApiBase
const marketApiBase = import.meta.env.VITE_MARKET_API_BASE_URL || portfolioApiBase

const FEATURED_MARKETS = [
  { symbol: 'MNT/USDT', label: 'MNT', tone: 'Mantle native' },
  { symbol: 'BTC/USDT', label: 'BTC', tone: 'Macro king' },
  { symbol: 'ETH/USDT', label: 'ETH', tone: 'L1 pulse' },
  { symbol: 'SOL/USDT', label: 'SOL', tone: 'High beta' },
  { symbol: 'ARB/USDT', label: 'ARB', tone: 'L2 watch' },
  { symbol: 'OP/USDT', label: 'OP', tone: 'L2 watch' },
]

const MARKET_SOURCE_LABEL = 'Live Spot Market'

type AnalysisMode = 'scalping' | 'intraday' | 'swing' | 'position'

const ANALYSIS_MODES: Record<AnalysisMode, { label: string; entry: string; trend: string; description: string }> = {
  scalping: { label: 'Scalping', entry: '15m', trend: '1h', description: 'Fast entries with hourly trend confirmation' },
  intraday: { label: 'Intraday', entry: '1h', trend: '4h', description: 'Same-day setups with broader session context' },
  swing: { label: 'Swing', entry: '4h', trend: '1d', description: 'Multi-day setups filtered by the daily trend' },
  position: { label: 'Position', entry: '1d', trend: '1w', description: 'Long-horizon decisions with weekly context' },
}

const ANALYSIS_MODE_BY_ENTRY: Record<string, AnalysisMode> = {
  '15m': 'scalping',
  '1h': 'intraday',
  '4h': 'swing',
  '1d': 'position',
}

const ANALYSIS_METHODS = [
  { label: '1H candle structure', value: 'Reading trend direction, swing highs, swing lows, and reversal candles', tone: 'cyan' },
  { label: '1D trend filter', value: 'Checking the broader daily market direction before allowing a directional setup', tone: 'violet' },
  { label: 'Support mapping', value: 'Locating demand zones and the nearest invalidation level', tone: 'cyan' },
  { label: 'Resistance mapping', value: 'Locating rejection zones and realistic upside targets', tone: 'amber' },
  { label: 'Volume context', value: 'Comparing price movement with visible trading volume', tone: 'cyan' },
  { label: 'RSI entry / trend', value: 'Checking momentum and overbought or oversold conditions on both timeframes', tone: 'violet' },
  { label: 'MACD entry / trend', value: 'Comparing trend momentum, signal lines, and histogram direction', tone: 'violet' },
  { label: 'Stochastic entry / trend', value: 'Checking where momentum points and whether the asset is overbought or oversold', tone: 'amber' },
  { label: 'Timeframe synthesis', value: 'Resolving conflicts between short-term entry timing and the daily trend', tone: 'cyan' },
  { label: 'Final decision', value: 'Combining every signal into BUY, SELL, or HOLD with a confidence score', tone: 'green' },
] as const

const PORTFOLIO_CATALOG = [
  { id: 'mantle', symbol: 'MNT', name: 'Mantle' },
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum' },
  { id: 'solana', symbol: 'SOL', name: 'Solana' },
  { id: 'arbitrum', symbol: 'ARB', name: 'Arbitrum' },
  { id: 'optimism', symbol: 'OP', name: 'Optimism' },
  { id: 'morpho', symbol: 'MORPHO', name: 'Morpho' },
  { id: 'gmx', symbol: 'GMX', name: 'GMX' },
  { id: 'lido-dao', symbol: 'LDO', name: 'Lido DAO' },
  { id: 'aptos', symbol: 'APT', name: 'Aptos' },
] as const

const PORTFOLIO_COLORS = ['#38bdf8', '#8b5cf6', '#22c55e', '#f59e0b', '#f43f5e', '#14b8a6', '#eab308', '#ec4899', '#6366f1', '#84cc16']

type Candle = {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

type CandlesResponse = {
  symbol: string
  exchange: string
  timeframe: string
  candles: Candle[]
}

type MarketCatalogItem = {
  symbol: string
  base: string
  quote: string
  exchange: string
}

type AIResult = {
  action: 'BUY' | 'SELL' | 'HOLD'
  support_price: number
  resistance_price: number
  confidence: number
  reason: string
  analyzed_at?: string
  model?: string
  candles_last_timestamp?: number
  stale?: boolean
  warning?: string
  credits_consumed?: number
  credit_consume_tx_hash?: string
  analysis_mode?: AnalysisMode
  entry_timeframe?: string
  trend_timeframe?: string
  indicators?: Record<string, {
    rsi: number
    rsi_state: string
    macd: number
    macd_signal: number
    macd_histogram: number
    macd_state: string
    stochastic_k: number
    stochastic_d: number
    stochastic_state: string
  }>
  historical_setup?: {
    signal: 'bullish' | 'bearish' | 'neutral' | 'insufficient'
    similar_cases: number
    bullish_percent: number
    bearish_percent: number
    average_move_percent: number
    median_move_percent: number
    evaluation_candles: number
  }
}

type Trade = {
  id: number
  entry_price: number
  entry_time: string
  take_profit_price: number
  stop_loss_price: number
  current_price?: number | null
  quantity: number
  usdt_used: number
  status: 'open' | 'closed'
  close_price?: number | null
  close_time?: string | null
  pnl_usdt?: number | null
  pnl_percent?: number | null
  close_reason?: string | null
}

type PaperAccount = {
  usdt_balance: number
  mnt_held: number
  equity: number
  open_trade: Trade | null
  trades_history: Trade[]
  last_analyzed_timestamp: number | null
  last_analysis: AIResult | null
  agent_running: boolean
  cooldown_remaining: number
  last_hold_reason: string | null
}

type AgentStatusResponse = {
  running: boolean
  account: PaperAccount
}

type BillingStatus = {
  enabled: boolean
  network: string
  credit_required_for_analysis: number
  contract_address: string | null
  auto_consume_enabled: boolean
  signature_required?: boolean
  note: string
}

type DexQuote = {
  provider: string
  kind: 'aggregator' | 'direct'
  status: 'available' | 'unavailable' | 'ready'
  amount_in?: number
  amount_out?: number
  rate?: number
  route?: string
  estimated_gas?: number | string | null
  price_impact_percent?: number | string | null
  difference_from_best_percent?: number
  stale?: boolean
  note: string
}

type DexQuoteResponse = {
  mode: 'read_only'
  network: string
  chain_id: number
  symbol: string
  best_provider: string | null
  quotes: DexQuote[]
  quoted_at: string
  execution_enabled: false
  warning: string
}

type PortfolioPosition = {
  assetId: string
  quantity: number
  averageBuyPrice: number
}

type PortfolioMarket = {
  id: string
  symbol: string
  name: string
  price_usd: number
  change_24h_percent: number
  last_updated_at?: number | null
}

type PortfolioMarketsResponse = {
  source: string
  currency: string
  assets: PortfolioMarket[]
}

function formatCurrency(value: number) {
  return `$${value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

function formatSignedCurrency(value: number) {
  return `${value >= 0 ? '+' : '-'}${formatCurrency(Math.abs(value))}`
}

function signalClass(action?: string) {
  return action === 'BUY' ? 'buy' : action === 'SELL' ? 'sell' : 'hold'
}

function App() {
  const chartContainerRef = useRef<HTMLDivElement | null>(null)
  const [activeView, setActiveView] = useState<'terminal' | 'performance' | 'portfolio'>('terminal')
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('intraday')
  const [selectedSymbol, setSelectedSymbol] = useState('MNT/USDT')
  const [marketCatalog, setMarketCatalog] = useState<MarketCatalogItem[]>(
    FEATURED_MARKETS.map((market) => ({ symbol: market.symbol, base: market.label, quote: 'USDT', exchange: MARKET_SOURCE_LABEL }))
  )
  const [marketSearch, setMarketSearch] = useState('')
  const [marketSelectorOpen, setMarketSelectorOpen] = useState(false)
  const [marketCatalogError, setMarketCatalogError] = useState<string | null>(null)
  const [candles, setCandles] = useState<Candle[]>([])
  const [latestPrice, setLatestPrice] = useState<number | null>(null)
  const [marketInfo, setMarketInfo] = useState({ symbol: 'MNT/USDT', exchange: MARKET_SOURCE_LABEL, timeframe: '1H' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiResult, setAiResult] = useState<AIResult | null>(null)
  const [aiTime, setAiTime] = useState<string | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [account, setAccount] = useState<PaperAccount | null>(null)
  const [controlLoading, setControlLoading] = useState(false)
  // Wallet / on-chain signals
  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [shortAddress, setShortAddress] = useState<string | null>(null)
  const [networkName, setNetworkName] = useState<string | null>(null)
  const [walletChainId, setWalletChainId] = useState<number | null>(null)
  const [isCorrectNetwork, setIsCorrectNetwork] = useState<boolean>(false)
  const [walletMntBalance, setWalletMntBalance] = useState<string | null>(null)
  const [walletBalanceLoading, setWalletBalanceLoading] = useState(false)
  const [walletBalanceError, setWalletBalanceError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [signals, setSignals] = useState<any[]>([])
  const [loadingSignals, setLoadingSignals] = useState(false)
  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null)
  const [credits, setCredits] = useState<number | null>(null)
  const [creditRate, setCreditRate] = useState<number | null>(null)
  const [creditVaultPaused, setCreditVaultPaused] = useState(false)
  const [creditsLoading, setCreditsLoading] = useState(false)
  const [creditsError, setCreditsError] = useState<string | null>(null)
  const [depositLoading, setDepositLoading] = useState(false)
  const [depositQuoteLoading, setDepositQuoteLoading] = useState(false)
  const [depositModalOpen, setDepositModalOpen] = useState(false)
  const [depositAmountMnt, setDepositAmountMnt] = useState('1')
  const [showAllSignals, setShowAllSignals] = useState(false)
  const [reasoningStepIndex, setReasoningStepIndex] = useState(0)
  const [dexQuoteAmount, setDexQuoteAmount] = useState('100')
  const [dexQuotes, setDexQuotes] = useState<DexQuoteResponse | null>(null)
  const [dexQuotesLoading, setDexQuotesLoading] = useState(false)
  const [dexQuotesError, setDexQuotesError] = useState<string | null>(null)
  const [selectedDexProvider, setSelectedDexProvider] = useState<string | null>(null)
  const [tradeSide, setTradeSide] = useState<'BUY' | 'SELL'>('BUY')
  const [slippagePercent, setSlippagePercent] = useState('0.5')
  const [portfolioPositions, setPortfolioPositions] = useState<PortfolioPosition[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('mantle-ai-trader-portfolio') || '[]')
    } catch {
      return []
    }
  })
  const [portfolioMarkets, setPortfolioMarkets] = useState<Record<string, PortfolioMarket>>({})
  const [portfolioSource, setPortfolioSource] = useState('CoinGecko')
  const [portfolioAssetId, setPortfolioAssetId] = useState('mantle')
  const [portfolioQuantity, setPortfolioQuantity] = useState('')
  const [portfolioBuyPrice, setPortfolioBuyPrice] = useState('')
  const [portfolioLoading, setPortfolioLoading] = useState(false)
  const [portfolioError, setPortfolioError] = useState<string | null>(null)

  const creditVaultConfigured = Boolean(ANALYSIS_CREDIT_VAULT_ADDRESS)
  const creditsRequired = billingStatus?.credit_required_for_analysis ?? ANALYSIS_CREDIT_REQUIRED
  const selectedMarket = marketCatalog.find((market) => market.symbol === selectedSymbol)
    ?? { symbol: selectedSymbol, base: selectedSymbol.split('/')[0], quote: 'USDT', exchange: MARKET_SOURCE_LABEL }
  const filteredMarkets = useMemo(() => {
    const query = marketSearch.trim().toUpperCase()
    if (!query) return marketCatalog.slice(0, 80)
    return marketCatalog
      .filter((market) => market.symbol.includes(query) || market.base.includes(query))
      .slice(0, 80)
  }, [marketCatalog, marketSearch])
  const displayedSignals = useMemo(
    () => (showAllSignals ? signals : signals.slice(0, 4)),
    [showAllSignals, signals]
  )

  const stats = useMemo(() => {
    if (!account) {
      return [
        { label: 'Balance', value: '$0.00', trend: '-' },
        { label: 'Equity', value: '$0.00', trend: '-' },
        { label: 'Position', value: 'No position', trend: '-' },
        { label: 'Cooldown', value: '0', trend: 'hours' },
      ]
    }

    return [
      { label: 'Balance', value: formatCurrency(account.usdt_balance), trend: '' },
      { label: 'Equity', value: formatCurrency(account.equity), trend: '' },
      {
        label: 'Position',
        value: account.open_trade ? `Long ${account.open_trade.quantity.toFixed(4)} MNT` : 'No position',
        trend: account.open_trade ? '+ active' : 'idle',
      },
      { label: 'Cooldown', value: `${account.cooldown_remaining}`, trend: 'hour candles' },
    ]
  }, [account])

  const fetchMarketCandles = async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch(`${marketApiBase}/api/market/candles?symbol=${encodeURIComponent(selectedSymbol)}&timeframe=${ANALYSIS_MODES[analysisMode].entry}`)
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || 'Failed to fetch candles')
      }
      const data = (await response.json()) as CandlesResponse
      if (!data.candles?.length) {
        throw new Error('No candle data available')
      }
      setMarketInfo({ symbol: data.symbol, exchange: MARKET_SOURCE_LABEL, timeframe: data.timeframe })
      setCandles(data.candles)
      setLatestPrice(data.candles[data.candles.length - 1].close)
    } catch (err: any) {
      setError(err?.message || 'Failed to load market candles')
    } finally {
      setLoading(false)
    }
  }

  const fetchMarketCatalog = async () => {
    setMarketCatalogError(null)
    try {
      const response = await fetch(`${marketApiBase}/api/market/catalog`)
      if (!response.ok) throw new Error(await response.text() || 'Failed to load market catalog')
      const data = await response.json()
      if (Array.isArray(data.markets) && data.markets.length) setMarketCatalog(data.markets)
    } catch (err: any) {
      setMarketCatalogError(err?.message || 'Failed to load market catalog')
    }
  }

  const chooseMarket = (symbol: string) => {
    setSelectedSymbol(symbol)
    setMarketSearch('')
    setMarketSelectorOpen(false)
    setAiResult(null)
    setAiError(null)
  }

  const fetchAgentStatus = async () => {
    setStatusLoading(true)
    setStatusError(null)

    try {
      const response = await fetch(`${apiBase}/api/agent/status`)
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || 'Failed to fetch agent status')
      }
      const data = (await response.json()) as AgentStatusResponse
      setAccount(data.account)
    } catch (err: any) {
      setStatusError(err?.message || 'Failed to load agent status')
    } finally {
      setStatusLoading(false)
    }
  }

  const fetchBillingStatus = async () => {
    try {
      const response = await fetch(`${apiBase}/api/billing/status`)
      if (!response.ok) return
      const data = (await response.json()) as BillingStatus
      setBillingStatus(data)
    } catch {
      // Billing is a demo placeholder and should never block the MVP.
    }
  }

  const refreshAll = async () => {
    await Promise.all([fetchMarketCandles(), fetchAgentStatus(), fetchBillingStatus()])
  }

  useEffect(() => {
    setCandles([])
    setLatestPrice(null)
    setAiResult(null)
    setAiTime(null)
    setAiError(null)
    refreshAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSymbol, analysisMode])

  useEffect(() => {
    if (!chartContainerRef.current) return

    const chartHeight = chartContainerRef.current.clientHeight || 280
    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: chartHeight,
      layout: {
        background: { color: '#07101f' },
        textColor: '#cbd5e1',
      },
      grid: {
        vertLines: { color: '#1f2a44' },
        horzLines: { color: '#1f2a44' },
      },
      crosshair: {
        mode: 1,
      },
      rightPriceScale: {
        borderColor: '#1f2a44',
      },
      timeScale: {
        borderColor: '#1f2a44',
        timeVisible: true,
        secondsVisible: false,
      },
    })

    const series = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#f87171',
      borderVisible: false,
      wickUpColor: '#22c55e',
      wickDownColor: '#f87171',
    })

    if (candles.length > 0) {
      const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp)
      const seriesData: CandlestickData<UTCTimestamp>[] = []

      for (const c of sorted) {
        const timeSec = Math.floor(c.timestamp / 1000)
        const open = Number(c.open)
        const high = Number(c.high)
        const low = Number(c.low)
        const close = Number(c.close)

        if ([open, high, low, close].some((v) => Number.isNaN(v))) continue

        seriesData.push({ time: timeSec as UTCTimestamp, open, high, low, close })
      }

      if (seriesData.length > 0) {
        series.setData(seriesData)
      }
    }

    const handleResize = () => {
      if (!chartContainerRef.current) return
      chart.applyOptions({
        width: chartContainerRef.current.clientWidth,
        height: chartContainerRef.current.clientHeight || chartHeight,
      })
    }

    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
    }
  }, [candles])

  const handleAgentAction = async (action: 'start' | 'stop') => {
    setControlLoading(true)
    setStatusError(null)
    try {
      const response = await fetch(`${apiBase}/api/agent/${action}`, { method: 'POST' })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `Failed to ${action} agent`)
      }
      await fetchAgentStatus()
    } catch (err: any) {
      setStatusError(err?.message || `Failed to ${action} agent`)
    } finally {
      setControlLoading(false)
    }
  }

  const handleReset = async () => {
    setControlLoading(true)
    setStatusError(null)
    try {
      const response = await fetch(`${apiBase}/api/account/reset`, { method: 'POST' })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || 'Failed to reset account')
      }
      await refreshAll()
    } catch (err: any) {
      setStatusError(err?.message || 'Failed to reset account')
    } finally {
      setControlLoading(false)
    }
  }

  const getFriendlyAiError = (rawMessage?: string) => {
    if (!rawMessage) {
      return 'Analysis failed. Please try again.'
    }

    let message = rawMessage
    try {
      const parsed = JSON.parse(rawMessage)
      message = parsed?.detail || parsed?.message || rawMessage
    } catch {
      // Plain text errors are expected from fetch/network failures.
    }

    if (message.includes('Wallet signature does not match requester')) {
      return 'Wallet signature does not match the connected wallet. Reconnect wallet and try again.'
    }

    if (message.includes('Analysis timeframe mismatch')) {
      return 'The analysis backend returned different timeframes. Refresh the page and run the selected timeframe again.'
    }

    if (message.includes('Gemini request limit') || message.includes('Достигнут лимит запросов Gemini') || message.includes('429')) {
      return 'Gemini request limit reached. Please try again later.'
    }

    if (message.includes('Gemini temporarily overloaded') || message.includes('Gemini is temporarily overloaded') || message.includes('Gemini временно перегружен') || message.includes('503')) {
      return 'Gemini is temporarily overloaded. Try again in a minute.'
    }

    if (message.includes('Failed to fetch Gemini analysis') || message.includes('Не удалось получить анализ Gemini') || message.includes('502')) {
      return 'Failed to fetch Gemini analysis. Please try again later.'
    }

    if (message.length > 120) {
      return 'Analysis failed. Please try again.'
    }

    return message
  }

  const fetchPortfolioMarkets = async () => {
    setPortfolioLoading(true)
    setPortfolioError(null)
    const ids = PORTFOLIO_CATALOG.map((asset) => asset.id).join(',')
    let lastError = 'Failed to fetch portfolio prices'

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${portfolioApiBase}/api/portfolio/markets?ids=${encodeURIComponent(ids)}`)
        if (!response.ok) {
          throw new Error(await response.text() || lastError)
        }
        const data = (await response.json()) as PortfolioMarketsResponse
        setPortfolioMarkets(Object.fromEntries(data.assets.map((asset) => [asset.id, asset])))
        setPortfolioSource(data.source)
        setPortfolioLoading(false)
        return
      } catch (err: any) {
        lastError = err?.message || lastError
        if (attempt < 2) {
          await new Promise((resolve) => window.setTimeout(resolve, 2500))
        }
      }
    }

    setPortfolioError(`${lastError}. Press Refresh prices to try again.`)
    setPortfolioLoading(false)
  }

  const fetchDexQuotes = async () => {
    const amount = Number(dexQuoteAmount.replace(',', '.'))
    if (selectedSymbol !== 'MNT/USDT') {
      setDexQuotes(null)
      setDexQuotesError('Read-only DEX preview currently supports MNT/USDT only.')
      return
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) {
      setDexQuotesError('Enter a quote amount between 0 and 10,000 USDT.')
      return
    }

    setDexQuotesLoading(true)
    setDexQuotesError(null)
    try {
      const response = await fetch(`${dexApiBase}/api/dex/quotes?symbol=MNT%2FUSDT&amount_in=${encodeURIComponent(amount)}&network=mantle_mainnet`)
      if (!response.ok) {
        const text = await response.text()
        if (response.status === 404) {
          throw new Error('DEX quote API is not deployed on the configured backend yet.')
        }
        let message = text || 'Failed to fetch DEX quotes'
        try {
          const parsed = JSON.parse(text)
          message = parsed?.detail || parsed?.message || message
        } catch {
          // Plain text API errors are valid fallback messages.
        }
        throw new Error(message)
      }
      setDexQuotes(await response.json() as DexQuoteResponse)
    } catch (err: any) {
      setDexQuotes(null)
      setDexQuotesError(err?.message || 'Failed to fetch DEX quotes')
    } finally {
      setDexQuotesLoading(false)
    }
  }

  const analyzeNow = async () => {
    if (!walletAddress) {
      setAiError('Connect your wallet to spend AI credits.')
      return
    }
    if (!isCorrectNetwork) {
      setAiError('Switch to Mantle Sepolia before running analysis.')
      return
    }
    if ((credits ?? 0) < creditsRequired) {
      setAiError('Insufficient AI credits. Deposit test MNT for credits first.')
      return
    }

    setAiLoading(true)
    setAiError(null)
    setAiResult(null)
    setAiTime(null)
    setReasoningStepIndex(0)
    try {
      const eth = (window as any).ethereum
      if (!eth) throw new Error('Wallet not found')
      const provider = new ethers.BrowserProvider(eth)
      const signer = await provider.getSigner()
      const checksumWallet = ethers.getAddress(await signer.getAddress())
      if (checksumWallet !== ethers.getAddress(walletAddress)) {
        setWalletAddress(checksumWallet)
        setShortAddress(shorten(checksumWallet))
      }
      const nonce = `${Date.now()}-${crypto.randomUUID()}`
      const message = [
        'Mantle AI Trader',
        'Authorize AI analysis credit spend',
        `Wallet: ${checksumWallet}`,
        `Symbol: ${selectedSymbol}`,
        `Mode: ${analysisMode}`,
        `Credits: ${creditsRequired}`,
        `Vault: ${ANALYSIS_CREDIT_VAULT_ADDRESS}`,
        'Network: Mantle Sepolia',
        `Nonce: ${nonce}`,
      ].join('\n')
      const signature = await signer.signMessage(message)

      const res = await fetch(`${apiBase}/api/ai/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: selectedSymbol,
          analysis_mode: analysisMode,
          wallet_address: checksumWallet,
          signature,
          nonce,
          message,
        }),
      })
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(txt || 'AI analyze failed')
      }
      const data = (await res.json()) as AIResult
      const expectedMode = ANALYSIS_MODES[analysisMode]
      if (
        data.entry_timeframe !== expectedMode.entry ||
        data.trend_timeframe !== expectedMode.trend
      ) {
        throw new Error(
          `Analysis timeframe mismatch: expected ${expectedMode.entry.toUpperCase()} + ${expectedMode.trend.toUpperCase()}, received ${(data.entry_timeframe || 'unknown').toUpperCase()} + ${(data.trend_timeframe || 'unknown').toUpperCase()}.`
        )
      }
      setAiResult(data)
      if ((data as any).analyzed_at) {
        setAiTime(new Date((data as any).analyzed_at).toLocaleString())
      } else if ((data as any).candles_last_timestamp) {
        setAiTime(new Date((data as any).candles_last_timestamp).toLocaleString())
      } else {
        setAiTime(new Date().toLocaleString())
      }
      if (data.credits_consumed) {
        setCredits((current) => (
          current === null ? current : Math.max(current - (data.credits_consumed ?? 0), 0)
        ))
      }
      window.setTimeout(() => {
        loadCreditBalance()
      }, 5000)
    } catch (e: any) {
      setAiError(getFriendlyAiError(e?.message || ''))
    } finally {
      setAiLoading(false)
    }
  }

  const loadCreditBalance = async () => {
    if (!walletAddress || !creditVaultConfigured) {
      setCredits(null)
      setCreditRate(null)
      setCreditVaultPaused(false)
      return
    }

    setCreditsLoading(true)
    setCreditsError(null)
    try {
      const provider = new ethers.JsonRpcProvider(MANTLE_SEPOLIA_RPC)
      const contract = new ethers.Contract(ANALYSIS_CREDIT_VAULT_ADDRESS, AnalysisCreditVaultABI as any, provider) as any
      const [balanceBn, rateBn, paused] = await Promise.all([
        contract.creditsOf(walletAddress),
        contract.creditsPerMnt(),
        contract.paused(),
      ])

      setCredits(Number(balanceBn?.toString ? balanceBn.toString() : balanceBn))
      setCreditRate(Number(rateBn?.toString ? rateBn.toString() : rateBn))
      setCreditVaultPaused(Boolean(paused))
    } catch (e: any) {
      console.error('loadCreditBalance', e)
      setCreditsError(e?.message || 'Failed to load AI credits')
    } finally {
      setCreditsLoading(false)
    }
  }

  const loadDepositQuote = async () => {
    if (!creditVaultConfigured) return

    setDepositQuoteLoading(true)
    setCreditsError(null)
    try {
      const provider = new ethers.JsonRpcProvider(MANTLE_SEPOLIA_RPC)
      const contract = new ethers.Contract(ANALYSIS_CREDIT_VAULT_ADDRESS, AnalysisCreditVaultABI as any, provider) as any
      const [rateBn, paused] = await Promise.all([
        contract.creditsPerMnt(),
        contract.paused(),
      ])
      setCreditRate(Number(rateBn?.toString ? rateBn.toString() : rateBn))
      setCreditVaultPaused(Boolean(paused))
    } catch (e: any) {
      console.error('loadDepositQuote', e)
      setCreditRate(null)
      setCreditsError('Unable to read the current credit rate from Mantle Sepolia.')
    } finally {
      setDepositQuoteLoading(false)
    }
  }

  // --- Wallet helpers ---
  const shorten = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`

  const handleAccountsChanged = (accounts: string[]) => {
    if (accounts && accounts.length > 0) {
      setWalletAddress(accounts[0])
      setShortAddress(shorten(accounts[0]))
    } else {
      setWalletAddress(null)
      setShortAddress(null)
      setWalletMntBalance(null)
      setWalletBalanceError(null)
    }
  }

  const connectWallet = async () => {
    try {
      const eth = (window as any).ethereum
      if (!eth) throw new Error('No wallet found')
      const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' })
      handleAccountsChanged(accounts)
      await detectNetwork()
      eth.on && eth.on('accountsChanged', handleAccountsChanged)
      eth.on && eth.on('chainChanged', () => detectNetwork())
    } catch (err: any) {
      console.error('connectWallet', err)
      alert(err?.message || 'Failed to connect wallet')
    }
  }

  const detectNetwork = async () => {
    try {
      const eth = (window as any).ethereum
      if (!eth) {
        setNetworkName(null)
        setWalletChainId(null)
        setIsCorrectNetwork(false)
        return
      }
      const provider = new ethers.BrowserProvider(eth)
      const net = await provider.getNetwork()
      const chainId = Number(net.chainId)
      setWalletChainId(chainId)
      setNetworkName(chainId === MANTLE_SEPOLIA_CHAIN_ID ? 'Mantle Sepolia' : (net.name || `Chain ${chainId}`))
      setIsCorrectNetwork(chainId === Number(MANTLE_SEPOLIA_CHAIN_ID))
    } catch (e) {
      setNetworkName(null)
      setWalletChainId(null)
      setIsCorrectNetwork(false)
    }
  }

  const loadWalletMntBalance = async () => {
    if (!walletAddress || !isCorrectNetwork) {
      setWalletMntBalance(null)
      setWalletBalanceError(null)
      return
    }
    setWalletBalanceLoading(true)
    setWalletBalanceError(null)
    try {
      const eth = (window as any).ethereum
      if (!eth) throw new Error('Wallet provider unavailable')
      const provider = new ethers.BrowserProvider(eth)
      const balance = await provider.getBalance(walletAddress)
      setWalletMntBalance(ethers.formatEther(balance))
    } catch (err: any) {
      setWalletMntBalance(null)
      setWalletBalanceError(err?.message || 'Unable to read MNT balance')
    } finally {
      setWalletBalanceLoading(false)
    }
  }

  const switchToMantleSepolia = async () => {
    const eth = (window as any).ethereum
    if (!eth) return alert('Wallet not found')
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: MANTLE_SEPOLIA_CHAIN_ID_HEX }] })
    } catch (switchError: any) {
      // 4902: chain not found
      if (switchError?.code === 4902 || /Unrecognized chain/.test(switchError?.message || '')) {
        try {
          await eth.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: MANTLE_SEPOLIA_CHAIN_ID_HEX,
              chainName: 'Mantle Sepolia',
              rpcUrls: [MANTLE_SEPOLIA_RPC],
              nativeCurrency: { name: 'MNT', symbol: 'MNT', decimals: 18 },
              blockExplorerUrls: ['https://explorer.sepolia.mantle.xyz']
            }]
          })
          // try switch again
          await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: MANTLE_SEPOLIA_CHAIN_ID_HEX }] })
        } catch (addErr) {
          console.error('wallet_addEthereumChain', addErr)
          alert('Failed to add Mantle Sepolia to wallet')
        }
      } else {
        console.error('wallet_switchEthereumChain', switchError)
        alert('Failed to switch network')
      }
    }
    await detectNetwork()
  }

  const depositCredits = async () => {
    if (!creditVaultConfigured) return alert('AnalysisCreditVault is not deployed/configured yet')
    if (!walletAddress) return alert('Connect your wallet first')
    if (!isCorrectNetwork) return alert('Switch to Mantle Sepolia network')

    setDepositLoading(true)
    setCreditsError(null)
    try {
      const normalizedDepositAmount = depositAmountMnt.replace(',', '.').trim()
      const depositValue = ethers.parseEther(normalizedDepositAmount)
      if (depositValue <= 0n) throw new Error('Enter a deposit amount greater than 0 MNT')
      const eth = (window as any).ethereum
      const provider = new ethers.BrowserProvider(eth)
      const signer = await provider.getSigner()
      const contract = new ethers.Contract(ANALYSIS_CREDIT_VAULT_ADDRESS, AnalysisCreditVaultABI as any, signer) as any
      const tx = await contract.deposit({ value: depositValue })
      setTxHash(tx.hash)
      await tx.wait()
      await loadCreditBalance()
      setDepositModalOpen(false)
    } catch (e: any) {
      console.error('depositCredits', e)
      setCreditsError(e?.message || 'Failed to deposit test MNT')
    } finally {
      setDepositLoading(false)
    }
  }

  // --- Contract interaction ---
  const recordAiSignalOnChain = async () => {
    if (!aiResult) return
    if ((aiResult as any).stale) return alert('Cannot record stale analysis on-chain')
    if (!walletAddress) return alert('Connect your wallet first')
    if (!isCorrectNetwork) return alert('Switch to Mantle Sepolia network')

    try {
      const eth = (window as any).ethereum
      const provider = new ethers.BrowserProvider(eth)
      const signer = await provider.getSigner()
      const contract = new ethers.Contract(TRADE_SIGNAL_REGISTRY_ADDRESS, TradeSignalRegistryABI as any, signer) as any

      const symbol = marketInfo.symbol || selectedSymbol
      const action = aiResult.action
      const price = Math.round((latestPrice ?? 0) * 1e8)
      const confidence = Math.round(aiResult.confidence * 100)
      const reason = (aiResult.reason || '').slice(0, 240)

      const tx = await contract.recordSignal(symbol, action, price, confidence, reason)
      setTxHash(tx.hash)
      // wait for confirmation
      await tx.wait()
      // refresh signals after confirmed
      await loadSignals()
      alert('Signal recorded on-chain: ' + tx.hash)
    } catch (e: any) {
      console.error('recordAiSignalOnChain', e)
      alert(e?.message || 'Failed to record signal')
    }
  }

  const loadSignals = async () => {
    setLoadingSignals(true)
    try {
      const eth = (window as any).ethereum
      // Use read-only provider if no wallet connected
      const provider = eth ? new ethers.BrowserProvider(eth) : new ethers.JsonRpcProvider(MANTLE_SEPOLIA_RPC)
      const contract = new ethers.Contract(TRADE_SIGNAL_REGISTRY_ADDRESS, TradeSignalRegistryABI as any, provider) as any
      const countBn = await contract.getSignalsCount()
      const count = Number(countBn?.toString ? countBn.toString() : countBn)
      const items = [] as any[]
      for (let i = 0; i < count; i++) {
        const s = await contract.getSignal(i)
        items.push({
          trader: s.trader,
          symbol: s.symbol,
          action: s.action,
          price: Number(s.price?.toString ? s.price.toString() : s.price),
          confidence: Number(s.confidence?.toString ? s.confidence.toString() : s.confidence),
          timestamp: Number(s.timestamp?.toString ? s.timestamp.toString() : s.timestamp),
          reason: s.reason
        })
      }
      setSignals(items.reverse())
    } catch (e) {
      console.error('loadSignals', e)
    } finally {
      setLoadingSignals(false)
    }
  }

  useEffect(() => {
    detectNetwork()
    // try to load signals on mount
    loadSignals()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    fetchPortfolioMarkets()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    fetchMarketCatalog()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    localStorage.setItem('mantle-ai-trader-portfolio', JSON.stringify(portfolioPositions))
  }, [portfolioPositions])

  useEffect(() => {
    loadCreditBalance()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, isCorrectNetwork])

  useEffect(() => {
    loadWalletMntBalance()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, isCorrectNetwork])

  useEffect(() => {
    if (!aiLoading) {
      setReasoningStepIndex(0)
      return
    }

    const timer = window.setInterval(() => {
      setReasoningStepIndex((current) => (current + 1) % ANALYSIS_METHODS.length)
    }, 850)

    return () => window.clearInterval(timer)
  }, [aiLoading])

  useEffect(() => {
    setDexQuotes(null)
    setDexQuotesError(null)
    setSelectedDexProvider(null)
  }, [selectedSymbol])

  useEffect(() => {
    if (aiResult?.action === 'BUY' && selectedSymbol === 'MNT/USDT') {
      fetchDexQuotes()
    }
    // Quote preview follows a new BUY decision; amount changes remain manual.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiResult])

  useEffect(() => {
    if (!dexQuotes) return
    const selectedStillAvailable = dexQuotes.quotes.some(
      (quote) => quote.provider === selectedDexProvider && quote.status === 'available'
    )
    if (!selectedStillAvailable) {
      setSelectedDexProvider(dexQuotes.best_provider)
    }
  }, [dexQuotes, selectedDexProvider])

  const addPortfolioPosition = () => {
    const quantity = Number(portfolioQuantity.replace(',', '.'))
    const averageBuyPrice = Number(portfolioBuyPrice.replace(',', '.'))
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(averageBuyPrice) || averageBuyPrice <= 0) {
      setPortfolioError('Enter a valid quantity and average buy price.')
      return
    }

    setPortfolioPositions((positions) => {
      const existing = positions.find((position) => position.assetId === portfolioAssetId)
      if (!existing) return [...positions, { assetId: portfolioAssetId, quantity, averageBuyPrice }]
      const totalQuantity = existing.quantity + quantity
      const weightedBuyPrice = (
        existing.quantity * existing.averageBuyPrice + quantity * averageBuyPrice
      ) / totalQuantity
      return positions.map((position) => position.assetId === portfolioAssetId
        ? { ...position, quantity: totalQuantity, averageBuyPrice: weightedBuyPrice }
        : position)
    })
    setPortfolioQuantity('')
    setPortfolioBuyPrice('')
    setPortfolioError(null)
  }

  const removePortfolioPosition = (assetId: string) => {
    setPortfolioPositions((positions) => positions.filter((position) => position.assetId !== assetId))
  }

  const confidencePercent = aiResult ? Math.round(aiResult.confidence * 100) : 0
  const supportLevel = aiResult?.support_price ?? null
  const resistanceLevel = aiResult?.resistance_price ?? null
  const selectedMode = ANALYSIS_MODES[analysisMode]
  const resultIndicatorTimeframes = Object.keys(aiResult?.indicators ?? {})
  const resultEntryTimeframe = aiResult?.entry_timeframe
    ?? (resultIndicatorTimeframes.includes(selectedMode.entry) ? selectedMode.entry : resultIndicatorTimeframes[0])
    ?? selectedMode.entry
  const resultTrendTimeframe = aiResult?.trend_timeframe
    ?? (resultIndicatorTimeframes.includes(selectedMode.trend)
      ? selectedMode.trend
      : resultIndicatorTimeframes.find((timeframe) => timeframe !== resultEntryTimeframe))
    ?? selectedMode.trend
  const entryIndicators = aiResult?.indicators?.[resultEntryTimeframe]
  const trendIndicators = aiResult?.indicators?.[resultTrendTimeframe]
  const historicalSetup = aiResult?.historical_setup
  const totalVolume = candles.reduce((sum, candle) => sum + candle.volume, 0)
  const firstClose = candles[0]?.close ?? latestPrice ?? 0
  const marketChange = latestPrice && firstClose ? ((latestPrice - firstClose) / firstClose) * 100 : 0
  const latestHigh = candles.length ? Math.max(...candles.slice(-24).map((c) => c.high)) : null
  const latestLow = candles.length ? Math.min(...candles.slice(-24).map((c) => c.low)) : null
  const canAnalyze = Boolean(walletAddress && isCorrectNetwork && (credits ?? 0) >= creditsRequired && !aiLoading)
  const selectedDexQuote = dexQuotes?.quotes.find(
    (quote) => quote.provider === selectedDexProvider && quote.status === 'available'
  ) ?? null
  const parsedSlippage = Number(slippagePercent.replace(',', '.'))
  const minimumReceived = selectedDexQuote?.amount_out && Number.isFinite(parsedSlippage)
    ? selectedDexQuote.amount_out * (1 - Math.max(0, parsedSlippage) / 100)
    : null
  const normalizedDepositAmount = depositAmountMnt.replace(',', '.').trim()
  const parsedDepositAmount = Number(normalizedDepositAmount)
  const estimatedDepositCredits = Number.isFinite(parsedDepositAmount) && parsedDepositAmount > 0
    ? Math.floor(parsedDepositAmount * (creditRate ?? 0))
    : 0
  const canDeposit = Boolean(
    walletAddress &&
    isCorrectNetwork &&
    creditVaultConfigured &&
    !creditVaultPaused &&
    !depositLoading &&
    !depositQuoteLoading &&
    creditRate !== null &&
    parsedDepositAmount > 0 &&
    estimatedDepositCredits > 0
  )
  const verifiedContractUrl = `https://sepolia.mantlescan.xyz/address/${TRADE_SIGNAL_REGISTRY_ADDRESS}#code`
  const reasoningPhase = aiLoading ? 'processing' : aiError ? 'error' : aiResult ? 'complete' : 'idle'
  const getReasoningState = (index: number) => {
    if (!aiLoading) return 'idle'
    if (index === reasoningStepIndex) return 'active'
    return index < reasoningStepIndex ? 'done' : 'queued'
  }
  const analysisMethodSteps = ANALYSIS_METHODS.map((method, index) => ({
    ...method,
    index,
    state: getReasoningState(index),
  }))
  const methodWindowStart = aiLoading
    ? Math.min(reasoningStepIndex, ANALYSIS_METHODS.length - 6)
    : 0
  const visibleAnalysisMethodSteps = analysisMethodSteps.slice(methodWindowStart, methodWindowStart + 6)
  const portfolioRows = portfolioPositions.map((position) => {
    const catalogAsset = PORTFOLIO_CATALOG.find((asset) => asset.id === position.assetId)
    const market = portfolioMarkets[position.assetId]
    const currentPrice = market?.price_usd ?? 0
    const currentValue = currentPrice * position.quantity
    const investedValue = position.averageBuyPrice * position.quantity
    const pnl = currentValue - investedValue
    const pnlPercent = investedValue ? (pnl / investedValue) * 100 : 0
    const change24hPercent = market?.change_24h_percent ?? 0
    const previousValue = change24hPercent > -100 ? currentValue / (1 + change24hPercent / 100) : currentValue
    return {
      ...position,
      name: market?.name ?? catalogAsset?.name ?? position.assetId,
      symbol: market?.symbol ?? catalogAsset?.symbol ?? position.assetId.toUpperCase(),
      currentPrice,
      currentValue,
      investedValue,
      pnl,
      pnlPercent,
      change24hPercent,
      change24hValue: currentValue - previousValue,
    }
  }).sort((a, b) => b.currentValue - a.currentValue)
  const portfolioValue = portfolioRows.reduce((sum, row) => sum + row.currentValue, 0)
  const portfolioInvested = portfolioRows.reduce((sum, row) => sum + row.investedValue, 0)
  const portfolioPnl = portfolioValue - portfolioInvested
  const portfolioPnlPercent = portfolioInvested ? (portfolioPnl / portfolioInvested) * 100 : 0
  const portfolio24hChange = portfolioRows.reduce((sum, row) => sum + row.change24hValue, 0)
  const topPortfolioPerformer = [...portfolioRows].sort((a, b) => b.change24hPercent - a.change24hPercent)[0]
  const portfolioAllocation = portfolioRows
    .filter((row) => row.currentValue > 0 && portfolioValue > 0)
    .map((row, index) => ({
      ...row,
      color: PORTFOLIO_COLORS[index % PORTFOLIO_COLORS.length],
      allocationPercent: (row.currentValue / portfolioValue) * 100,
    }))
  let allocationCursor = 0
  const allocationGradient = portfolioAllocation.length
    ? `conic-gradient(${portfolioAllocation.map((row) => {
      const start = allocationCursor
      allocationCursor += row.allocationPercent
      return `${row.color} ${start}% ${allocationCursor}%`
    }).join(', ')})`
    : 'conic-gradient(rgba(100, 116, 139, .28) 0 100%)'
  const largestAllocation = portfolioAllocation[0]

  return (
    <div className="terminal-shell min-h-screen text-slate-100">
      <div className="starfield" />
      <header className="terminal-topbar relative z-10 flex flex-col gap-4 border-b border-cyan-400/20 px-4 py-4 backdrop-blur-xl lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <div className="flex items-center gap-8">
          <button type="button" className="brand-home flex items-center gap-3" onClick={() => setActiveView('terminal')}>
            <div className="brand-orb">M</div>
            <div>
              <div className="text-sm font-semibold tracking-tight text-white">Mantle AI Trader</div>
              <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-400">Signal Intelligence v0.5</div>
            </div>
          </button>
          <nav className="flex flex-wrap items-center gap-2 text-sm">
            <button type="button" onClick={() => setActiveView('terminal')} className={`nav-pill ${activeView === 'terminal' ? 'active' : ''}`}>Terminal</button>
            <button type="button" onClick={() => setActiveView('performance')} className={`nav-pill ${activeView === 'performance' ? 'active' : ''}`}>AI Performance</button>
            <button type="button" onClick={() => setActiveView('portfolio')} className={`nav-pill ${activeView === 'portfolio' ? 'active' : ''}`}>Portfolio</button>
            <a className="nav-pill" href="https://github.com/hanto777/mantle-ai-trader-agent#readme" target="_blank" rel="noreferrer">Docs</a>
          </nav>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="status-pill hidden lg:flex">
            <span className="pulse-dot" /> Mantle Sepolia - 5003
          </div>
          {!isCorrectNetwork && (
            <button onClick={switchToMantleSepolia} className="ghost-button px-4 py-2 text-xs font-semibold">
              Switch Network
            </button>
          )}
          <div className="credit-nav-card">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">AI Credits</div>
              <div className="font-mono text-lg font-semibold text-white">
                {creditsLoading ? '...' : credits !== null ? credits.toLocaleString() : '0'}
              </div>
              <div className="font-mono text-[10px] text-cyan-300">cost per analysis: {creditsRequired} credits</div>
            </div>
            <button
              onClick={() => {
                setCreditsError(null)
                setDepositModalOpen(true)
                loadDepositQuote()
              }}
              disabled={depositLoading || !walletAddress || !isCorrectNetwork || !creditVaultConfigured || creditVaultPaused}
              className="command-button px-3 py-2 text-[10px] font-bold uppercase tracking-wider disabled:opacity-50"
            >
              {depositLoading ? 'Depositing' : 'Deposit'}
            </button>
          </div>
          {walletAddress ? (
            <button onClick={connectWallet} className="command-button alt px-4 py-2 text-xs font-bold">
              {shortAddress} <span className="ml-1 text-cyan-100/70">{isCorrectNetwork ? 'ready' : 'wrong net'}</span>
            </button>
          ) : (
            <button onClick={connectWallet} className="command-button alt px-4 py-2 text-xs font-bold">Connect Wallet</button>
          )}
        </div>
      </header>

      {depositModalOpen && (
        <div className="deposit-modal-backdrop" onMouseDown={() => !depositLoading && setDepositModalOpen(false)}>
          <div className="deposit-modal" role="dialog" aria-modal="true" aria-labelledby="deposit-modal-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-300">Mantle Sepolia testnet</div>
                <h2 id="deposit-modal-title" className="mt-2 text-lg font-semibold text-white">Get AI analysis credits</h2>
                <p className="mt-1 text-xs leading-5 text-slate-400">Deposit test MNT into the credit vault. No real funds.</p>
              </div>
              <button onClick={() => setDepositModalOpen(false)} disabled={depositLoading} className="deposit-modal-close" aria-label="Close deposit dialog">X</button>
            </div>

            <label className="mt-5 block">
              <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">Deposit amount</span>
              <div className="deposit-input-wrap mt-2">
                <input
                  value={depositAmountMnt}
                  onChange={(event) => setDepositAmountMnt(event.target.value)}
                  inputMode="decimal"
                  type="text"
                  autoFocus
                  className="deposit-input"
                  placeholder="0.0"
                />
                <span>MNT</span>
              </div>
            </label>

            <div className="mt-3 grid grid-cols-4 gap-2">
              {['0.01', '0.05', '0.1', '0.5'].map((amount) => (
                <button key={amount} onClick={() => setDepositAmountMnt(amount)} className={`deposit-preset ${depositAmountMnt === amount ? 'active' : ''}`}>
                  {amount}
                </button>
              ))}
            </div>

            <div className="deposit-quote mt-5">
              <div>
                <span>On-chain rate</span>
                <strong>{depositQuoteLoading ? 'Loading...' : creditRate !== null ? `1 MNT = ${creditRate.toLocaleString()} credits` : 'Rate unavailable'}</strong>
              </div>
              <div>
                <span>You receive</span>
                <strong className="text-cyan-200">{depositQuoteLoading || creditRate === null ? '-' : `${estimatedDepositCredits.toLocaleString()} credits`}</strong>
              </div>
              <div>
                <span>Analyses available</span>
                <strong>{depositQuoteLoading || creditRate === null || creditsRequired <= 0 ? '-' : Math.floor(estimatedDepositCredits / creditsRequired).toLocaleString()}</strong>
              </div>
            </div>

            {!depositQuoteLoading && creditRate !== null && estimatedDepositCredits === 0 && parsedDepositAmount > 0 && (
              <div className="mt-3 rounded-lg border border-amber-300/25 bg-amber-400/10 p-3 text-xs text-amber-100">
                Deposit is too small to mint one credit at the current on-chain rate.
              </div>
            )}
            {creditsError && <div className="alert-card mt-3 p-3 text-xs text-red-200">{creditsError}</div>}

            <button onClick={depositCredits} disabled={!canDeposit} className="command-button mt-5 w-full px-4 py-3 text-xs font-bold disabled:opacity-50">
              {depositLoading ? 'Waiting for confirmation...' : `Deposit ${normalizedDepositAmount || '0'} MNT`}
            </button>
          </div>
        </div>
      )}

      <main className="relative z-10 mx-auto max-w-[1500px] space-y-6 px-4 py-6 lg:px-8">
        <section className={`${activeView === 'terminal' ? 'grid' : 'hidden'} market-workspace gap-6 xl:grid-cols-[0.95fr_1.45fr]`}>
          <div className="market-left-panel glass-panel p-4">
            <div className="mb-3 flex items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="asset-dot">{selectedMarket.base.slice(0, 1)}</div>
                  <div className="market-selector">
                    <button type="button" className="market-selector-trigger" onClick={() => setMarketSelectorOpen((open) => !open)}>
                      <span>{marketInfo.symbol}</span>
                      <small>Change market</small>
                    </button>
                    {marketSelectorOpen && (
                      <div className="market-selector-popover">
                        <input
                          value={marketSearch}
                          onChange={(event) => setMarketSearch(event.target.value)}
                          placeholder="Search BTC, AAVE, ENA..."
                          autoFocus
                        />
                        <div className="market-selector-results">
                          {filteredMarkets.map((market) => (
                            <button
                              type="button"
                              key={market.symbol}
                              onClick={() => chooseMarket(market.symbol)}
                              className={market.symbol === selectedSymbol ? 'active' : ''}
                            >
                              <strong>{market.base}</strong>
                              <span>{market.symbol}</span>
                            </button>
                          ))}
                          {!filteredMarkets.length && <div className="market-selector-empty">No matching USDT spot pair</div>}
                        </div>
                        {marketCatalogError && <div className="market-selector-error">{marketCatalogError}</div>}
                      </div>
                    )}
                  </div>
                  <span className="mini-badge">{marketInfo.exchange}</span>
                  <label className="timeframe-selector">
                    <span className="sr-only">Analysis timeframe</span>
                    <select
                      value={selectedMode.entry}
                      onChange={(event) => setAnalysisMode(ANALYSIS_MODE_BY_ENTRY[event.target.value])}
                      disabled={aiLoading}
                      aria-label="Analysis timeframe"
                    >
                      {(Object.entries(ANALYSIS_MODES) as [AnalysisMode, typeof selectedMode][]).map(([mode, config]) => (
                        <option key={mode} value={config.entry}>{config.entry.toUpperCase()}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="mt-2 flex items-baseline gap-3">
                  <span className="font-mono text-2xl font-semibold text-white">
                    {latestPrice ? `$${latestPrice.toFixed(6)}` : 'Loading'}
                  </span>
                  <span className={marketChange >= 0 ? 'text-emerald-300' : 'text-red-300'}>
                    {marketChange >= 0 ? '+' : ''}{marketChange.toFixed(2)}%
                  </span>
                </div>
              </div>
              <div className="flex max-w-[13rem] flex-wrap justify-end gap-2">
                <span className="mini-badge live">Live market data</span>
                <span className="mini-badge violet">DEX intelligence</span>
                <span className="mini-badge amber">Mantle Sepolia</span>
              </div>
            </div>

            {error ? (
              <div className="alert-card p-5 text-sm text-red-200">Error loading candles: {error}</div>
            ) : (
              <div className="chart-frame compact-chart grid-bg relative overflow-hidden p-3">
                <div ref={chartContainerRef} className="h-[280px] w-full" />
                {supportLevel && <div className="chart-tag support">S - ${supportLevel.toFixed(4)}</div>}
                {resistanceLevel && <div className="chart-tag resistance">R - ${resistanceLevel.toFixed(4)}</div>}
              </div>
            )}

            <div className="market-stat-grid mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <div className="stat-tile"><span>Chart high</span><strong>{latestHigh ? `$${latestHigh.toFixed(4)}` : '-'}</strong></div>
              <div className="stat-tile"><span>Chart low</span><strong>{latestLow ? `$${latestLow.toFixed(4)}` : '-'}</strong></div>
              <div className="stat-tile"><span>Chart volume</span><strong>{Math.round(totalVolume).toLocaleString()}</strong></div>
              <div className="stat-tile"><span>Source</span><strong>{marketInfo.exchange || '-'}</strong></div>
            </div>

            <div className="dex-terminal mt-3">
              <div className="dex-terminal-head">
                <div>
                  <div className="font-mono text-xs uppercase tracking-[0.2em] text-cyan-300">DEX route terminal</div>
                  <h3 className="mt-1 text-base font-semibold text-white">{dexQuotes?.network || 'Mantle Mainnet'} quote preview</h3>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-slate-400">Read-only route comparison, including FusionX V2</div>
                </div>
                <span className="mini-badge live">Read only</span>
              </div>

              <div className={`dex-wallet-status ${isCorrectNetwork ? 'connected' : ''}`}>
                <div>
                  <span>Test wallet</span>
                  <strong>{shortAddress || 'Not connected'}</strong>
                </div>
                <div>
                  <span>Wallet network</span>
                  <strong>{networkName ? `${networkName}${walletChainId ? ` · ${walletChainId}` : ''}` : 'Not detected'}</strong>
                </div>
                <div>
                  <span>MNT balance</span>
                  <strong>
                    {walletBalanceLoading
                      ? 'Reading...'
                      : walletMntBalance
                        ? `${Number(walletMntBalance).toFixed(4)} MNT`
                        : isCorrectNetwork
                          ? 'Unavailable'
                          : '-'}
                  </strong>
                </div>
                {!walletAddress ? (
                  <button type="button" onClick={connectWallet} className="ghost-button px-3 py-2 text-[10px] font-bold">
                    Connect wallet
                  </button>
                ) : !isCorrectNetwork ? (
                  <button type="button" onClick={switchToMantleSepolia} className="ghost-button px-3 py-2 text-[10px] font-bold">
                    Switch to Sepolia
                  </button>
                ) : (
                  <button type="button" onClick={loadWalletMntBalance} className="ghost-button px-3 py-2 text-[10px] font-bold">
                    Refresh balance
                  </button>
                )}
              </div>
              {walletBalanceError && <div className="mt-2 font-mono text-[10px] text-rose-300">{walletBalanceError}</div>}

              <div className="dex-quote-controls">
                <label>
                  <span>Spend</span>
                  <input
                    value={dexQuoteAmount}
                    onChange={(event) => setDexQuoteAmount(event.target.value)}
                    inputMode="decimal"
                    aria-label="DEX quote amount in USDT"
                  />
                  <strong>USDT</strong>
                </label>
                <button
                  onClick={fetchDexQuotes}
                  disabled={dexQuotesLoading || selectedSymbol !== 'MNT/USDT'}
                  className="ghost-button px-4 py-3 text-xs font-bold disabled:opacity-50"
                >
                  {dexQuotesLoading ? 'Scanning...' : 'Scan routes'}
                </button>
              </div>

              <div className="dex-route-list">
                {(dexQuotes?.quotes ?? [
                  { provider: 'OpenOcean', kind: 'aggregator', status: 'ready', note: 'Live aggregate quote ready' },
                  { provider: 'Merchant Moe', kind: 'direct', status: 'ready', note: 'Live LB Quoter ready' },
                  { provider: 'Agni', kind: 'direct', status: 'ready', note: 'Live direct quoter ready' },
                  { provider: 'Uniswap V3', kind: 'direct', status: 'ready', note: 'Live QuoterV2 ready' },
                  { provider: 'FusionX V2', kind: 'direct', status: 'ready', note: 'Live V2 router ready' },
                ] as DexQuote[]).map((quote) => (
                  <button
                    key={quote.provider}
                    type="button"
                    onClick={() => quote.status === 'available' && setSelectedDexProvider(quote.provider)}
                    disabled={quote.status !== 'available'}
                    className={`dex-route-row ${dexQuotes?.best_provider === quote.provider ? 'best' : ''} ${selectedDexProvider === quote.provider ? 'selected' : ''}`}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <strong>{quote.provider}</strong>
                        {dexQuotes?.best_provider === quote.provider && <span className="dex-best-tag">best</span>}
                        {quote.stale && <span className="dex-cache-tag">cached</span>}
                      </div>
                      <span className="dex-route-path">{quote.route || quote.note}</span>
                    </div>
                    <div className="dex-route-amount text-right">
                      <strong>{quote.amount_out ? `${quote.amount_out.toFixed(4)} MNT` : quote.status}</strong>
                      <span>
                        {quote.amount_out
                          ? quote.difference_from_best_percent === 0
                            ? `${quote.amount_in?.toFixed(2)} USDT in`
                            : `${quote.difference_from_best_percent?.toFixed(2)}% vs best`
                          : quote.kind}
                      </span>
                    </div>
                  </button>
                ))}
              </div>

              {dexQuotesError && <div className="mt-3 font-mono text-[10px] text-red-300">{dexQuotesError}</div>}
              <div className="dex-safety-line">
                <span>No approval</span><span>No calldata</span><span>No signature</span><span>No transaction</span>
              </div>
            </div>

            <div className="trade-setup mt-3">
              <div className="trade-setup-head">
                <div>
                  <div className="font-mono text-xs uppercase tracking-[0.2em] text-cyan-300">Trade setup</div>
                  <h3 className="mt-1 text-base font-semibold text-white">{selectedDexQuote?.provider || 'Select a DEX route'}</h3>
                </div>
                <span className="mini-badge amber">Preview only</span>
              </div>

              <div className="trade-side-grid mt-4">
                <button type="button" onClick={() => setTradeSide('BUY')} className={`trade-side-button buy ${tradeSide === 'BUY' ? 'active' : ''}`}>
                  BUY
                  <span>USDT to MNT</span>
                </button>
                <button type="button" onClick={() => setTradeSide('SELL')} className={`trade-side-button sell ${tradeSide === 'SELL' ? 'active' : ''}`}>
                  SELL
                  <span>MNT to USDT</span>
                </button>
              </div>

              <div className="slippage-panel mt-4">
                <div className="mb-2 flex items-center justify-between">
                  <label htmlFor="slippage-input">Slippage (%)</label>
                  <span>{tradeSide} setup</span>
                </div>
                <div className="slippage-controls">
                  <input
                    id="slippage-input"
                    value={slippagePercent}
                    onChange={(event) => setSlippagePercent(event.target.value)}
                    inputMode="decimal"
                  />
                  {[0.02, 0.1, 0.5, 1].map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setSlippagePercent(String(value))}
                      className={Number(slippagePercent) === value ? 'active' : ''}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </div>

              <div className="trade-preview-grid mt-4">
                <div><span>Selected DEX</span><strong>{selectedDexQuote?.provider || '-'}</strong></div>
                <div><span>Quoted output</span><strong>{tradeSide === 'BUY' && selectedDexQuote?.amount_out ? `${selectedDexQuote.amount_out.toFixed(4)} MNT` : 'Reverse quote pending'}</strong></div>
                <div><span>Minimum received</span><strong>{tradeSide === 'BUY' && minimumReceived ? `${minimumReceived.toFixed(4)} MNT` : '-'}</strong></div>
                <div><span>Execution</span><strong>Locked</strong></div>
              </div>

              <div className="mt-4 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 font-mono text-[10px] leading-5 text-amber-100/80">
                {tradeSide === 'BUY'
                  ? `BUY preview prepared on ${selectedDexQuote?.provider || 'no selected DEX'}.`
                  : `SELL selected on ${selectedDexQuote?.provider || 'no selected DEX'}; reverse quotes are not connected yet.`}
                {' '}Real approvals, signatures, and swaps remain disabled.
              </div>
            </div>
          </div>

          <div className={`glass-panel relative overflow-hidden p-5 reasoning-panel ${reasoningPhase}`}>
            <div className="mb-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="brain-chip">AI</div>
                <div>
                  <h2 className="text-lg font-semibold text-white">AI Reasoning Engine</h2>
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-slate-400">Gemini - Chart Vision - Credit gated</div>
                </div>
              </div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-emerald-300">
                <span className="pulse-dot" /> {aiLoading ? 'Thinking' : aiResult ? 'Decision synced' : aiError ? 'Needs retry' : 'Standby'}
              </div>
            </div>

            <div className={`ai-core grid-bg ${aiLoading ? 'is-thinking' : ''}`}>
              <video
                className="ai-robot-video"
                src="/ai-robot.mp4"
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
              />
              {aiLoading && <div className="scan-beam" />}
              {aiLoading && <div className="core-particles"><i /><i /><i /><i /><i /></div>}
              <div className="ai-orbit"><span /></div>
              <div className="ai-core-label">{aiLoading ? 'Reasoning loop active' : 'Neural core online'}</div>
              <div className="ai-core-sync">{aiLoading ? `Method ${reasoningStepIndex + 1}/${ANALYSIS_METHODS.length}` : aiResult ? 'Decision complete' : `${ANALYSIS_METHODS.length} methods ready`}</div>
            </div>

            <div className="ai-action-dock mt-3">
              <div>
                <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-cyan-300">{aiLoading ? 'Analysis in progress' : aiResult ? 'Run another analysis' : 'Ready for analysis'}</div>
                <div className="mt-1 text-xs text-slate-400">{creditsRequired} credit · {selectedMode.entry.toUpperCase()} + {selectedMode.trend.toUpperCase()}</div>
              </div>
              <div className="flex gap-2">
                {aiResult && (
                  <button onClick={recordAiSignalOnChain} disabled={aiResult.stale || !walletAddress || !isCorrectNetwork} className="ghost-button px-3 py-2 text-[10px] font-semibold disabled:opacity-50">
                    Record On-chain
                  </button>
                )}
                <button onClick={analyzeNow} disabled={!canAnalyze} className="command-button alt px-4 py-2 text-[10px] font-bold disabled:opacity-50">
                  {aiLoading ? 'Analyzing...' : `Analyze Now (${creditsRequired})`}
                </button>
              </div>
            </div>

            {aiResult ? (
              <div className="ai-explanation mt-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-300">Gemini decision explanation</div>
                    <h3 className="mt-2 text-lg font-semibold text-white">Why the agent chose {aiResult.action}</h3>
                  </div>
                  <div className={`signal-pill ${signalClass(aiResult.action)}`}>{confidencePercent}% confidence</div>
                </div>
                <p className="mt-4 text-sm leading-7 text-slate-200">{aiResult.reason}</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div className="explanation-fact"><span>Timeframes</span><strong>{resultEntryTimeframe.toUpperCase()} entry + {resultTrendTimeframe.toUpperCase()} trend</strong></div>
                  <div className="explanation-fact"><span>{aiResult.action === 'SELL' ? 'Downside target' : 'Risk boundary'}</span><strong>{supportLevel ? `$${supportLevel.toFixed(6)}` : '-'}</strong></div>
                  <div className="explanation-fact"><span>{aiResult.action === 'SELL' ? 'Bearish invalidation' : 'Upside reference'}</span><strong>{resistanceLevel ? `$${resistanceLevel.toFixed(6)}` : '-'}</strong></div>
                </div>
              </div>
            ) : (
              <div className="mt-5 space-y-2">
                <div className="mb-3 flex items-center justify-between gap-4">
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-300">Analysis methods</span>
                  <span className="font-mono text-[9px] uppercase text-slate-500">{aiLoading ? 'Processing live' : 'Ready pipeline'}</span>
                </div>
                {visibleAnalysisMethodSteps.map((step) => (
                  <div key={step.label} className={`reason-row ${step.state}`}>
                    <div className={`reason-dot ${step.tone}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-100">{step.label}</span>
                        <span className="font-mono text-[9px] text-slate-500">
                          {step.state === 'done' ? 'checked' : step.state === 'active' ? 'analyzing' : step.state === 'queued' ? 'queued' : `${step.index + 1}/${ANALYSIS_METHODS.length}`}
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-xs leading-relaxed text-slate-400">{step.value}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {(aiResult || aiError) && <div className="signal-output mt-5 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-200">Multi-Timeframe Evidence</div>
                  <p className="mt-1 text-xs text-slate-400">{selectedMode.label} evidence from the entry and trend-filter timeframes.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className="mini-badge violet">{resultEntryTimeframe.toUpperCase()} + {resultTrendTimeframe.toUpperCase()}</span>
                  {aiResult?.model && <span className="mini-badge">{aiResult.model}</span>}
                </div>
              </div>
              {aiResult && (
                <div className="indicator-grid mt-4">
                  {[
                    { label: `${resultEntryTimeframe.toUpperCase()} entry timing`, values: entryIndicators },
                    { label: `${resultTrendTimeframe.toUpperCase()} trend filter`, values: trendIndicators },
                  ].map(({ label, values }) => (
                    <div key={label} className="indicator-card">
                      {values ? <>
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-200">{label}</span>
                          <span className={`indicator-state ${values.stochastic_state}`}>{values.stochastic_state}</span>
                        </div>
                        <div className="indicator-row">
                          <span>RSI 14</span>
                          <strong>{values.rsi.toFixed(2)}</strong>
                          <em className={values.rsi_state}>{values.rsi_state}</em>
                        </div>
                        <div className="indicator-row">
                          <span>MACD</span>
                          <strong>{values.macd_histogram >= 0 ? '+' : ''}{values.macd_histogram.toFixed(6)}</strong>
                          <em className={values.macd_state}>{values.macd_state}</em>
                        </div>
                        <div className="indicator-row">
                          <span>Stochastic</span>
                          <strong>{values.stochastic_k.toFixed(1)} / {values.stochastic_d.toFixed(1)}</strong>
                          <em className={values.stochastic_state}>{values.stochastic_state}</em>
                        </div>
                      </> : <>
                        <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-200">{label}</div>
                        <div className="empty-state p-4 text-center text-xs text-slate-400">Indicator evidence was not returned for this timeframe.</div>
                      </>}
                    </div>
                  ))}
                </div>
              )}
              {historicalSetup && (
                <div className={`historical-rsi-card mt-4 ${historicalSetup.signal}`}>
                  <div className="historical-rsi-visual">
                    <div className="historical-rsi-orbit">
                      <i />
                      <i />
                      <i />
                      <div className="historical-rsi-core">
                        <span>RSI 14</span>
                        <strong>{entryIndicators?.rsi.toFixed(1) ?? '-'}</strong>
                        <small>{entryIndicators?.rsi_state ?? 'unknown'}</small>
                      </div>
                    </div>
                  </div>
                  <div className="historical-rsi-content">
                    <div className="historical-rsi-heading">
                      <div>
                        <span>Historical RSI Signal</span>
                        <h4>{historicalSetup.signal === 'insufficient' ? 'Awaiting more history' : `${historicalSetup.signal} bias`}</h4>
                        <p>Current RSI context matched with MACD and Stochastic history on {resultEntryTimeframe.toUpperCase()}.</p>
                      </div>
                      <strong className="historical-rsi-score">
                        {historicalSetup.signal === 'bearish' ? historicalSetup.bearish_percent : historicalSetup.bullish_percent}%
                        <small>{historicalSetup.signal}</small>
                      </strong>
                    </div>
                    <div className="historical-rsi-balance">
                      <div style={{ width: `${historicalSetup.bullish_percent}%` }} />
                      <span>{historicalSetup.bullish_percent}% bullish</span>
                      <span>{historicalSetup.bearish_percent}% bearish</span>
                    </div>
                    <div className="historical-rsi-metrics">
                      <div><span>Similar cases</span><strong>{historicalSetup.similar_cases}</strong></div>
                      <div><span>Average move</span><strong>{historicalSetup.average_move_percent >= 0 ? '+' : ''}{historicalSetup.average_move_percent.toFixed(2)}%</strong></div>
                      <div><span>Median move</span><strong>{historicalSetup.median_move_percent >= 0 ? '+' : ''}{historicalSetup.median_move_percent.toFixed(2)}%</strong></div>
                      <div><span>Forward window</span><strong>{historicalSetup.evaluation_candles} candles</strong></div>
                    </div>
                  </div>
                </div>
              )}
              {aiError && <div className="alert-card mt-4 p-3 text-sm text-red-200">Analysis error: {aiError}</div>}
              {aiResult?.credits_consumed ? <p className="mt-4 font-mono text-[10px] text-emerald-300">Consumed {aiResult.credits_consumed} AI credit on Mantle Sepolia.</p> : null}
              {aiResult?.credit_consume_tx_hash ? (
                <a href={`https://sepolia.mantlescan.xyz/tx/${aiResult.credit_consume_tx_hash}`} target="_blank" rel="noreferrer" className="mt-1 block truncate font-mono text-[10px] text-cyan-300 underline">
                  Credit tx: {aiResult.credit_consume_tx_hash}
                </a>
              ) : null}
              {aiTime && <p className="mt-2 font-mono text-[10px] text-slate-500">Updated: {aiTime}</p>}
              {walletAddress && (credits ?? 0) < creditsRequired && (
                <div className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-xs text-red-200">
                  Need {creditsRequired} credits for a fresh Gemini analysis. Deposit test MNT first.
                </div>
              )}
            </div>}
          </div>
        </section>

        <section className={activeView === 'performance' ? 'performance-view space-y-6' : 'hidden'}>
          <div className="glass-panel performance-hero p-6">
            <span className="mini-badge live">Verifiable intelligence</span>
            <h2 className="mt-4 text-3xl font-semibold text-white">AI Performance</h2>
            <p className="mt-3 max-w-3xl text-sm text-slate-300">A transparent alternative to anonymous signal channels. Every completed BUY and SELL setup will be evaluated against market data and linked to its immutable Mantle record.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="stat-tile"><span>Verified signals</span><strong>-</strong><small>Tracking starts with BUY / SELL</small></div>
            <div className="stat-tile"><span>Win rate</span><strong>-</strong><small>Completed setups only</small></div>
            <div className="stat-tile"><span>Average PnL</span><strong>-</strong><small>After evaluation window</small></div>
            <div className="stat-tile"><span>On-chain proofs</span><strong>{signals.length}</strong><small>Mantle Sepolia records</small></div>
          </div>
          <div className="glass-panel p-5">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">On-chain signal history</div>
                <h3 className="mt-2 text-lg font-semibold text-white">TradeSignalRegistry</h3>
              </div>
              <a href={verifiedContractUrl} target="_blank" rel="noreferrer" className="verified-badge">Verified contract</a>
            </div>
            {txHash && <div className="mb-3 truncate rounded-lg bg-slate-950/70 p-3 text-xs text-cyan-200">Tx: <a href={`https://sepolia.mantlescan.xyz/tx/${txHash}`} target="_blank" rel="noreferrer" className="underline">{txHash}</a></div>}
            {loadingSignals ? (
              <div className="empty-state p-4 text-center text-sm text-slate-400">Loading signals...</div>
            ) : signals.length === 0 ? (
              <div className="empty-state p-4 text-center text-sm text-slate-400">No on-chain signals yet</div>
            ) : (
              <div className="space-y-2">
                {displayedSignals.map((s, idx) => (
                  <div key={`${s.trader}-${idx}`} className="history-row">
                    <span className={`signal-pill ${signalClass(s.action)}`}>{s.action}</span>
                    <span>{s.symbol}</span>
                    <span>conf {s.confidence}%</span>
                    <span>${(s.price / 1e8).toFixed(6)}</span>
                    <span className="truncate text-right text-slate-500">{shorten(s.trader)}</span>
                  </div>
                ))}
                {signals.length > 4 && <button onClick={() => setShowAllSignals((value) => !value)} className="ghost-button mt-2 px-3 py-2 text-xs">{showAllSignals ? 'Show less' : `Show ${signals.length - 4} more`}</button>}
              </div>
            )}
          </div>
          <div className="glass-panel p-6">
            <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-200">Performance pipeline</div>
            <h3 className="mt-2 text-xl font-semibold text-white">Verified results are coming next</h3>
            <p className="mt-3 max-w-3xl text-sm text-slate-400">BUY and SELL decisions are now available. The next release will store evaluation windows, calculate realized outcomes, and publish directional accuracy without counting HOLD decisions as wins.</p>
          </div>
        </section>

        <section className={activeView === 'portfolio' ? 'grid gap-6 lg:grid-cols-[0.8fr_1.4fr]' : 'hidden'}>
          <div className="glass-panel p-5">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-200">Portfolio composition</div>
              <h3 className="mt-2 text-lg font-semibold text-white">Coin Allocation</h3>
            </div>
            {portfolioAllocation.length ? (
              <div className="allocation-layout mt-5">
                <div className="allocation-donut" style={{ background: allocationGradient }}>
                  <div className="allocation-donut-center">
                    <span>{largestAllocation.symbol}</span>
                    <strong>{formatCurrency(largestAllocation.currentValue)}</strong>
                    <small>{largestAllocation.allocationPercent.toFixed(1)}%</small>
                  </div>
                </div>
                <div className="allocation-legend">
                  {portfolioAllocation.map((row) => (
                    <div key={row.assetId} className="allocation-legend-row">
                      <i style={{ background: row.color }} />
                      <span>{row.symbol}</span>
                      <strong>{row.allocationPercent.toFixed(1)}%</strong>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="empty-state mt-5 p-6 text-center text-sm text-slate-400">Add portfolio positions to display coin allocation.</div>
            )}
          </div>

          <div className="glass-panel p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-200">Manual investment portfolio</div>
              <h3 className="mt-2 text-xl font-semibold text-white">Portfolio Intelligence</h3>
              <p className="mt-2 max-w-2xl text-sm text-slate-400">Track positions you bought anywhere. Prices refresh through CoinGecko; quantities and cost basis stay in this browser.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={fetchPortfolioMarkets} disabled={portfolioLoading} className="ghost-button px-3 py-2 text-xs disabled:opacity-50">{portfolioLoading ? 'Refreshing...' : 'Refresh prices'}</button>
              <button disabled className="command-button alt px-3 py-2 text-xs font-bold opacity-60">AI Portfolio Analysis · 3 credits</button>
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-4">
            <div className="stat-tile"><span>Current balance</span><strong>{formatCurrency(portfolioValue)}</strong><small>{portfolioRows.length} tracked assets</small></div>
            <div className="stat-tile"><span>24h portfolio change</span><strong className={portfolio24hChange >= 0 ? 'text-emerald-300' : 'text-red-300'}>{formatSignedCurrency(portfolio24hChange)}</strong><small>{portfolioSource} market prices</small></div>
            <div className="stat-tile"><span>Total profit / loss</span><strong className={portfolioPnl >= 0 ? 'text-emerald-300' : 'text-red-300'}>{formatSignedCurrency(portfolioPnl)}</strong><small>{portfolioPnlPercent >= 0 ? '+' : ''}{portfolioPnlPercent.toFixed(2)}%</small></div>
            <div className="stat-tile"><span>Top performer · 24h</span><strong>{topPortfolioPerformer?.symbol ?? '-'}</strong><small className={topPortfolioPerformer && topPortfolioPerformer.change24hPercent >= 0 ? 'text-emerald-300' : 'text-red-300'}>{topPortfolioPerformer ? `${topPortfolioPerformer.change24hPercent >= 0 ? '+' : ''}${topPortfolioPerformer.change24hPercent.toFixed(2)}%` : 'Add a position'}</small></div>
          </div>

          <div className="portfolio-add-grid mt-5">
            <label><span>Asset</span><select value={portfolioAssetId} onChange={(event) => setPortfolioAssetId(event.target.value)}>{PORTFOLIO_CATALOG.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · {asset.symbol}</option>)}</select></label>
            <label><span>Quantity</span><input value={portfolioQuantity} onChange={(event) => setPortfolioQuantity(event.target.value)} inputMode="decimal" placeholder="261.43" /></label>
            <label><span>Average buy price · USD</span><input value={portfolioBuyPrice} onChange={(event) => setPortfolioBuyPrice(event.target.value)} inputMode="decimal" placeholder="1.00" /></label>
            <button onClick={addPortfolioPosition} className="command-button px-4 py-3 text-sm font-bold">Add position</button>
          </div>
          {portfolioError && <div className="alert-card mt-3 p-3 text-sm text-red-200">{portfolioError}</div>}

          <div className="portfolio-table mt-5">
            <div className="portfolio-row portfolio-header"><span>Asset</span><span>Price / 24h</span><span>Holdings</span><span>Value</span><span>PnL</span><span>Action</span></div>
            {portfolioRows.length ? portfolioRows.map((row) => (
              <div key={row.assetId} className="portfolio-row">
                <div><strong>{row.name}</strong><span>{row.symbol}</span></div>
                <div><strong>{formatCurrency(row.currentPrice)}</strong><span className={row.change24hPercent >= 0 ? 'text-emerald-300' : 'text-red-300'}>{row.change24hPercent >= 0 ? '+' : ''}{row.change24hPercent.toFixed(2)}%</span></div>
                <div><strong>{row.quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })} {row.symbol}</strong><span>Avg {formatCurrency(row.averageBuyPrice)}</span></div>
                <div><strong>{formatCurrency(row.currentValue)}</strong><span>Cost {formatCurrency(row.investedValue)}</span></div>
                <div><strong className={row.pnl >= 0 ? 'text-emerald-300' : 'text-red-300'}>{formatSignedCurrency(row.pnl)}</strong><span>{row.pnlPercent >= 0 ? '+' : ''}{row.pnlPercent.toFixed(2)}%</span></div>
                <button onClick={() => removePortfolioPosition(row.assetId)} className="ghost-button px-3 py-2 text-xs">Remove</button>
              </div>
            )) : <div className="empty-state p-6 text-center text-sm text-slate-400">Add your first position to calculate portfolio value and profit / loss.</div>}
          </div>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App

