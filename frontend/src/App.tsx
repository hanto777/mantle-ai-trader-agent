import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, type CandlestickData, type UTCTimestamp } from 'lightweight-charts'
import { ethers } from 'ethers'
import { TradeSignalRegistryABI, TRADE_SIGNAL_REGISTRY_ADDRESS, MANTLE_SEPOLIA_CHAIN_ID, MANTLE_SEPOLIA_CHAIN_ID_HEX, MANTLE_SEPOLIA_RPC } from './abi/TradeSignalRegistry'
import { AnalysisCreditVaultABI, ANALYSIS_CREDIT_REQUIRED, ANALYSIS_CREDIT_VAULT_ADDRESS } from './abi/AnalysisCreditVault'

const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000'

const MARKETS = [
  { symbol: 'MNT/USDT', label: 'MNT', tone: 'Mantle native' },
  { symbol: 'BTC/USDT', label: 'BTC', tone: 'Macro king' },
  { symbol: 'ETH/USDT', label: 'ETH', tone: 'L1 pulse' },
  { symbol: 'SOL/USDT', label: 'SOL', tone: 'High beta' },
  { symbol: 'ARB/USDT', label: 'ARB', tone: 'L2 watch' },
  { symbol: 'OP/USDT', label: 'OP', tone: 'L2 watch' },
] as const

const ANALYSIS_METHODS = [
  { label: '1H candle structure', value: 'Reading trend direction, swing highs, swing lows, and reversal candles', tone: 'cyan' },
  { label: '1D trend filter', value: 'Checking the broader daily market direction before allowing a long setup', tone: 'violet' },
  { label: 'Support mapping', value: 'Locating demand zones and the nearest invalidation level', tone: 'cyan' },
  { label: 'Resistance mapping', value: 'Locating rejection zones and realistic upside targets', tone: 'amber' },
  { label: 'Volume context', value: 'Comparing price movement with visible trading volume', tone: 'cyan' },
  { label: 'RSI 1H / 1D', value: 'Checking momentum and overbought or oversold conditions on both timeframes', tone: 'violet' },
  { label: 'MACD 1H / 1D', value: 'Comparing trend momentum, signal lines, and histogram direction', tone: 'violet' },
  { label: 'Stochastic 1H / 1D', value: 'Checking where momentum points and whether the asset is overbought or oversold', tone: 'amber' },
  { label: 'Timeframe synthesis', value: 'Resolving conflicts between short-term entry timing and the daily trend', tone: 'cyan' },
  { label: 'Final decision', value: 'Combining every signal into BUY or HOLD with a confidence score', tone: 'green' },
] as const

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

type AIResult = {
  action: 'BUY' | 'HOLD'
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
  indicators?: Record<'1h' | '1d', {
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

type TradesResponse = {
  open_trade: Trade | null
  trades_history: Trade[]
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

function formatCurrency(value: number) {
  return `$${value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

function App() {
  const chartContainerRef = useRef<HTMLDivElement | null>(null)
  const [selectedSymbol, setSelectedSymbol] = useState('MNT/USDT')
  const [candles, setCandles] = useState<Candle[]>([])
  const [latestPrice, setLatestPrice] = useState<number | null>(null)
  const [marketInfo, setMarketInfo] = useState({ symbol: 'MNT/USDT', exchange: 'Loading source...', timeframe: '1H' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiResult, setAiResult] = useState<AIResult | null>(null)
  const [aiTime, setAiTime] = useState<string | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [account, setAccount] = useState<PaperAccount | null>(null)
  const [trades, setTrades] = useState<TradesResponse | null>(null)
  const [controlLoading, setControlLoading] = useState(false)
  // Wallet / on-chain signals
  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [shortAddress, setShortAddress] = useState<string | null>(null)
  const [networkName, setNetworkName] = useState<string | null>(null)
  const [isCorrectNetwork, setIsCorrectNetwork] = useState<boolean>(false)
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

  const creditVaultConfigured = Boolean(ANALYSIS_CREDIT_VAULT_ADDRESS)
  const creditsRequired = billingStatus?.credit_required_for_analysis ?? ANALYSIS_CREDIT_REQUIRED
  const selectedMarket = MARKETS.find((market) => market.symbol === selectedSymbol) ?? MARKETS[0]
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
      const response = await fetch(`${apiBase}/api/market/candles?symbol=${encodeURIComponent(selectedSymbol)}`)
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || 'Failed to fetch candles')
      }
      const data = (await response.json()) as CandlesResponse
      if (!data.candles?.length) {
        throw new Error('No candle data available')
      }
      setMarketInfo({ symbol: data.symbol, exchange: data.exchange, timeframe: data.timeframe })
      setCandles(data.candles)
      setLatestPrice(data.candles[data.candles.length - 1].close)
    } catch (err: any) {
      setError(err?.message || 'Failed to load market candles')
    } finally {
      setLoading(false)
    }
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
      // If server has a last successful analysis, use it to populate UI
      if (data.account?.last_analysis) {
        const la = data.account.last_analysis as any
        setAiResult({
          action: la.action,
          support_price: la.support_price,
          resistance_price: la.resistance_price,
          confidence: la.confidence,
          reason: la.reason,
          analyzed_at: la.analyzed_at,
          model: la.model,
          candles_last_timestamp: la.candles_last_timestamp,
          stale: false,
          indicators: la.indicators,
        })
        if (la.analyzed_at) {
          setAiTime(new Date(la.analyzed_at).toLocaleString())
        } else if (la.candles_last_timestamp) {
          setAiTime(new Date(la.candles_last_timestamp).toLocaleString())
        }
      }
    } catch (err: any) {
      setStatusError(err?.message || 'Failed to load agent status')
    } finally {
      setStatusLoading(false)
    }
  }

  const fetchTrades = async () => {
    try {
      const response = await fetch(`${apiBase}/api/trades`)
      if (!response.ok) {
        return
      }
      const data = (await response.json()) as TradesResponse
      setTrades(data)
    } catch {
      // ignore
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
    await Promise.all([fetchMarketCandles(), fetchAgentStatus(), fetchTrades(), fetchBillingStatus()])
  }

  useEffect(() => {
    setCandles([])
    setLatestPrice(null)
    setAiResult(null)
    setAiTime(null)
    setAiError(null)
    refreshAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSymbol])

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

    if (message.includes('Gemini request limit') || message.includes('429')) {
      return 'Gemini request limit reached. Please try again later.'
    }

    if (message.includes('Gemini temporarily overloaded') || message.includes('503')) {
      return 'Gemini is temporarily overloaded. Try again in a minute.'
    }

    if (message.includes('Failed to fetch Gemini analysis') || message.includes('502')) {
      return 'Failed to fetch Gemini analysis. Please try again later.'
    }

    if (message.length > 120) {
      return 'Analysis failed. Please try again.'
    }

    return message
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
      const response = await fetch(`${apiBase}/api/dex/quotes?symbol=MNT%2FUSDT&amount_in=${encodeURIComponent(amount)}`)
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
        setIsCorrectNetwork(false)
        return
      }
      const provider = new ethers.BrowserProvider(eth)
      const net = await provider.getNetwork()
      setNetworkName(net.name || `chain:${net.chainId}`)
      setIsCorrectNetwork(Number(net.chainId) === Number(MANTLE_SEPOLIA_CHAIN_ID))
    } catch (e) {
      setNetworkName(null)
      setIsCorrectNetwork(false)
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
    loadCreditBalance()
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
  }, [selectedSymbol])

  useEffect(() => {
    if (aiResult?.action === 'BUY' && selectedSymbol === 'MNT/USDT') {
      fetchDexQuotes()
    }
    // Quote preview follows a new BUY decision; amount changes remain manual.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiResult])

  const confidencePercent = aiResult ? Math.round(aiResult.confidence * 100) : 0
  const supportLevel = aiResult?.support_price ?? null
  const resistanceLevel = aiResult?.resistance_price ?? null
  const hourlyIndicators = aiResult?.indicators?.['1h']
  const dailyIndicators = aiResult?.indicators?.['1d']
  const openTrade = trades?.open_trade ?? account?.open_trade ?? null
  const totalVolume = candles.reduce((sum, candle) => sum + candle.volume, 0)
  const firstClose = candles[0]?.close ?? latestPrice ?? 0
  const marketChange = latestPrice && firstClose ? ((latestPrice - firstClose) / firstClose) * 100 : 0
  const latestHigh = candles.length ? Math.max(...candles.slice(-24).map((c) => c.high)) : null
  const latestLow = candles.length ? Math.min(...candles.slice(-24).map((c) => c.low)) : null
  const canAnalyze = Boolean(walletAddress && isCorrectNetwork && (credits ?? 0) >= creditsRequired && !aiLoading)
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

  return (
    <div className="terminal-shell min-h-screen text-slate-100">
      <div className="starfield" />
      <header className="terminal-topbar relative z-10 flex flex-col gap-4 border-b border-cyan-400/20 px-4 py-4 backdrop-blur-xl lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-3">
            <div className="brand-orb">M</div>
            <div>
              <div className="text-sm font-semibold tracking-tight text-white">Mantle AI Trader</div>
              <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-400">Signal Intelligence v0.5</div>
            </div>
          </div>
          <nav className="hidden items-center gap-2 text-sm md:flex">
            <span className="nav-pill active">Terminal</span>
            <span className="nav-pill">Signals</span>
            <span className="nav-pill">Vaults</span>
            <span className="nav-pill">Docs</span>
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
        <section className="market-workspace grid gap-6 xl:grid-cols-[0.95fr_1.45fr]">
          <div className="market-left-panel glass-panel p-4">
            <div className="mb-3 flex items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="asset-dot">{selectedMarket.label.slice(0, 1)}</div>
                  <h1 className="text-2xl font-semibold text-white">{marketInfo.symbol}</h1>
                  <span className="mini-badge">{marketInfo.exchange}</span>
                  <span className="mini-badge">{marketInfo.timeframe}</span>
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
                <span className="mini-badge violet">Paper trading</span>
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
              <div className="stat-tile"><span>24h high</span><strong>{latestHigh ? `$${latestHigh.toFixed(4)}` : '-'}</strong></div>
              <div className="stat-tile"><span>24h low</span><strong>{latestLow ? `$${latestLow.toFixed(4)}` : '-'}</strong></div>
              <div className="stat-tile"><span>Volume</span><strong>{Math.round(totalVolume).toLocaleString()}</strong></div>
              <div className="stat-tile"><span>Source</span><strong>{marketInfo.exchange || '-'}</strong></div>
            </div>

            <div className="dex-terminal mt-3">
              <div className="dex-terminal-head">
                <div>
                  <div className="font-mono text-xs uppercase tracking-[0.2em] text-cyan-300">DEX route terminal</div>
                  <h3 className="mt-1 text-base font-semibold text-white">Mantle mainnet quote preview</h3>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-slate-400">Bridged legacy USDT to native MNT</div>
                </div>
                <span className="mini-badge live">Read only</span>
              </div>

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
                ] as DexQuote[]).map((quote) => (
                  <div key={quote.provider} className={`dex-route-row ${dexQuotes?.best_provider === quote.provider ? 'best' : ''}`}>
                    <div>
                      <div className="flex items-center gap-2">
                        <strong>{quote.provider}</strong>
                        {dexQuotes?.best_provider === quote.provider && <span className="dex-best-tag">best</span>}
                      </div>
                      <span className="dex-route-path">{quote.route || quote.note}</span>
                    </div>
                    <div className="text-right">
                      <strong>{quote.amount_out ? `${quote.amount_out.toFixed(4)} MNT` : quote.status}</strong>
                      <span>
                        {quote.amount_out
                          ? quote.difference_from_best_percent === 0
                            ? `${quote.amount_in?.toFixed(2)} USDT in`
                            : `${quote.difference_from_best_percent?.toFixed(2)}% vs best`
                          : quote.kind}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {dexQuotesError && <div className="mt-3 font-mono text-[10px] text-red-300">{dexQuotesError}</div>}
              <div className="dex-safety-line">
                <span>No approval</span><span>No calldata</span><span>No signature</span><span>No transaction</span>
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
                <div className="mt-1 text-xs text-slate-400">{creditsRequired} credit · 1H + 1D · RSI · MACD · Stochastic</div>
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
                  <div className={`signal-pill ${aiResult.action === 'BUY' ? 'buy' : 'hold'}`}>{confidencePercent}% confidence</div>
                </div>
                <p className="mt-4 text-sm leading-7 text-slate-200">{aiResult.reason}</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div className="explanation-fact"><span>Timeframes</span><strong>1H entry + 1D trend</strong></div>
                  <div className="explanation-fact"><span>Risk boundary</span><strong>{supportLevel ? `$${supportLevel.toFixed(6)}` : '-'}</strong></div>
                  <div className="explanation-fact"><span>Upside reference</span><strong>{resistanceLevel ? `$${resistanceLevel.toFixed(6)}` : '-'}</strong></div>
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
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-400">Signal</span>
                  <span className={`signal-pill ${aiResult?.action === 'BUY' ? 'buy' : 'hold'}`}>{aiResult?.action || 'WAIT'}</span>
                  {aiResult?.stale && <span className="signal-pill stale">Cached</span>}
                </div>
                <div className="font-mono text-[10px] text-slate-400">Confidence <span className="text-white">{aiResult ? `${confidencePercent}%` : '-'}</span></div>
              </div>
              <div className="mt-3 h-1 rounded-full bg-white/5">
                <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-cyan-300" style={{ width: `${Math.min(confidencePercent || 8, 100)}%` }} />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 font-mono text-xs">
                <div><div className="text-[10px] uppercase text-slate-500">Support</div><div className="text-emerald-300">{supportLevel ? `$${supportLevel.toFixed(6)}` : '-'}</div></div>
                <div><div className="text-[10px] uppercase text-slate-500">Resistance</div><div className="text-red-300">{resistanceLevel ? `$${resistanceLevel.toFixed(6)}` : '-'}</div></div>
              </div>
              {(hourlyIndicators || dailyIndicators) && (
                <div className="indicator-grid mt-4">
                  {[
                    { label: '1H entry timing', values: hourlyIndicators },
                    { label: '1D trend filter', values: dailyIndicators },
                  ].map(({ label, values }) => values && (
                    <div key={label} className="indicator-card">
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
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-4 rounded-lg border border-cyan-300/10 bg-slate-950/35 p-3">
                <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-200">Decision trace</div>
                <p className="text-sm leading-6 text-slate-300">
                  {aiError
                    ? `Analysis error: ${aiError}`
                    : aiLoading
                      ? 'Gemini is comparing trend, support, resistance, and volume. The credit will be consumed only if a valid analysis comes back.'
                      : aiResult?.reason || 'Press Analyze Now to send the current chart to Gemini and receive an explainable trading signal.'}
                </p>
                {aiResult?.credits_consumed ? (
                  <p className="mt-2 font-mono text-[10px] text-emerald-300">Consumed {aiResult.credits_consumed} AI credit on Mantle Sepolia.</p>
                ) : null}
                {aiResult?.credit_consume_tx_hash ? (
                  <a href={`https://sepolia.mantlescan.xyz/tx/${aiResult.credit_consume_tx_hash}`} target="_blank" rel="noreferrer" className="mt-1 block truncate font-mono text-[10px] text-cyan-300 underline">
                    Credit tx: {aiResult.credit_consume_tx_hash}
                  </a>
                ) : null}
              </div>
              {aiTime && <p className="mt-2 font-mono text-[10px] text-slate-500">Updated: {aiTime}</p>}
              {walletAddress && (credits ?? 0) < creditsRequired && (
                <div className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-xs text-red-200">
                  Need {creditsRequired} credits for a fresh Gemini analysis. Deposit test MNT first.
                </div>
              )}
            </div>}
          </div>
        </section>

        <section className="glass-panel p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Paper Trading Account</h3>
            <span className="mini-badge violet">Simulated</span>
          </div>
          <div className="grid gap-3 md:grid-cols-5">
            <div className="stat-tile"><span>Balance</span><strong>{account ? formatCurrency(account.usdt_balance) : '-'}</strong><small>USDT</small></div>
            <div className="stat-tile"><span>Equity</span><strong>{account ? formatCurrency(account.equity) : '-'}</strong><small>{latestPrice ? `$${latestPrice.toFixed(4)} spot` : '-'}</small></div>
            <div className="stat-tile"><span>Position</span><strong>{openTrade ? 'LONG MNT' : 'No position'}</strong><small>{openTrade ? `Entry $${openTrade.entry_price.toFixed(4)}` : 'idle'}</small></div>
            <div className="stat-tile"><span>Unrealized PnL</span><strong>{openTrade?.pnl_usdt ? formatCurrency(openTrade.pnl_usdt) : '$0.00'}</strong><small>{openTrade?.pnl_percent ? `${openTrade.pnl_percent.toFixed(2)}%` : '-'}</small></div>
            <div className="stat-tile"><span>MNT held</span><strong>{account ? account.mnt_held.toFixed(4) : '-'}</strong><small>{account && latestPrice ? formatCurrency(account.mnt_held * latestPrice) : '-'}</small></div>
          </div>
          <div className="risk-panel mt-4">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-300">Risk Rules</div>
            <div className="grid gap-2 font-mono text-[10px] text-slate-400 md:grid-cols-6">
              <span>Mode: <b>Paper trading</b></span>
              <span>Timeframe: <b>1H</b></span>
              <span>Take profit: <b>+3%</b></span>
              <span>Stop: <b>below AI support</b></span>
              <span>Max positions: <b>1</b></span>
              <span>Cooldown: <b>{account?.cooldown_remaining ?? 0} candles</b></span>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
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
                    <span className={`signal-pill ${s.action === 'BUY' ? 'buy' : 'hold'}`}>{s.action}</span>
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

          <div className="glass-panel p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">Trade History</h3>
              <button onClick={fetchTrades} className="ghost-button px-3 py-2 text-xs">Refresh</button>
            </div>
            <div className="space-y-4">
              <div className="sub-panel p-4">
                <div className="mb-3 font-mono text-[10px] uppercase tracking-wider text-slate-400">Open trade</div>
                {openTrade ? (
                  <div className="grid gap-2 text-sm text-slate-300 sm:grid-cols-2">
                    <span>Entry ${openTrade.entry_price.toFixed(6)}</span>
                    <span>Qty {openTrade.quantity.toFixed(4)} MNT</span>
                    <span>Take profit ${openTrade.take_profit_price.toFixed(6)}</span>
                    <span>Stop loss ${openTrade.stop_loss_price.toFixed(6)}</span>
                  </div>
                ) : <div className="empty-state p-3 text-sm text-slate-400">No open trade</div>}
              </div>
              <div className="sub-panel p-4">
                <div className="mb-3 font-mono text-[10px] uppercase tracking-wider text-slate-400">Recent closes</div>
                {trades?.trades_history?.length ? trades.trades_history.slice(-5).reverse().map((trade) => (
                  <div key={trade.id} className="history-row">
                    <span>#{trade.id}</span><span>{trade.status}</span><span>{trade.entry_price.toFixed(4)}</span><span>{trade.close_price?.toFixed(4) ?? '-'}</span><span>{trade.pnl_usdt?.toFixed(2) ?? '-'}</span>
                  </div>
                )) : <div className="empty-state p-3 text-sm text-slate-400">No closed trades yet</div>}
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1fr_0.8fr]">
          <div className="glass-panel p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">Agent Controls</h3>
              <span className={account?.agent_running ? 'signal-pill buy' : 'signal-pill hold'}>{account?.agent_running ? 'Running' : 'Stopped'}</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <button onClick={() => handleAgentAction('start')} disabled={controlLoading || account?.agent_running} className="command-button alt px-4 py-3 text-sm font-bold disabled:opacity-50">Start Agent</button>
              <button onClick={() => handleAgentAction('stop')} disabled={controlLoading || !account?.agent_running} className="ghost-button px-4 py-3 text-sm font-semibold disabled:opacity-50">Stop Agent</button>
              <button onClick={handleReset} disabled={controlLoading} className="ghost-button px-4 py-3 text-sm font-semibold disabled:opacity-50">Reset Account</button>
            </div>
            {statusError && <div className="alert-card mt-4 p-3 text-sm text-red-200">{statusError}</div>}
          </div>
          <div className="glass-panel p-5">
            <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">Analysis logs</div>
            <div className="result-card mt-4 space-y-3 p-4 text-sm text-slate-300">
              <div className="flex justify-between border-b border-slate-800 pb-3"><span>Last analysis</span><span>{aiTime || '-'}</span></div>
              <div><p className="text-slate-500">Signal</p><p className="text-white">{aiResult?.action || '-'}</p></div>
              <div><p className="text-slate-500">Reason</p><p>{aiResult?.reason || account?.last_hold_reason || '-'}</p></div>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App

