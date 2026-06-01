import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, type CandlestickData, type UTCTimestamp } from 'lightweight-charts'
import { ethers } from 'ethers'
import { TradeSignalRegistryABI, TRADE_SIGNAL_REGISTRY_ADDRESS, MANTLE_SEPOLIA_CHAIN_ID, MANTLE_SEPOLIA_CHAIN_ID_HEX, MANTLE_SEPOLIA_RPC } from './abi/TradeSignalRegistry'

const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000'

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

function formatCurrency(value: number) {
  return `$${value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

function App() {
  const chartContainerRef = useRef<HTMLDivElement | null>(null)
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

  const stats = useMemo(() => {
    if (!account) {
      return [
        { label: 'Balance', value: '$0.00', trend: '—' },
        { label: 'Equity', value: '$0.00', trend: '—' },
        { label: 'Position', value: 'No position', trend: '—' },
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
      const response = await fetch(`${apiBase}/api/market/candles`)
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

  const refreshAll = async () => {
    await Promise.all([fetchMarketCandles(), fetchAgentStatus(), fetchTrades()])
  }

  useEffect(() => {
    refreshAll()
  }, [])

  useEffect(() => {
    if (!chartContainerRef.current) return

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: 360,
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
      chart.applyOptions({ width: chartContainerRef.current?.clientWidth ?? 0 })
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

  const analyzeNow = async () => {
    setAiLoading(true)
    setAiError(null)
    setAiResult(null)
    try {
      const res = await fetch(`${apiBase}/api/ai/analyze`, { method: 'POST' })
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(txt || 'AI analyze failed')
      }
      const data = (await res.json()) as AIResult
      setAiResult(data)
      setAiTime(new Date().toLocaleString())
    } catch (e: any) {
      setAiError(e?.message || 'Failed to run analysis')
    } finally {
      setAiLoading(false)
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
              nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
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

  // --- Contract interaction ---
  const recordAiSignalOnChain = async () => {
    if (!aiResult) return
    if (!walletAddress) return alert('Connect your wallet first')
    if (!isCorrectNetwork) return alert('Switch to Mantle Sepolia network')

    try {
      const eth = (window as any).ethereum
      const provider = new ethers.BrowserProvider(eth)
      const signer = await provider.getSigner()
      const contract = new ethers.Contract(TRADE_SIGNAL_REGISTRY_ADDRESS, TradeSignalRegistryABI as any, signer) as any

      const symbol = 'MNT/USDT'
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

  return (
    <div className="min-h-screen bg-bg text-slate-100 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.35em] text-slate-400">MANTLE AI TRADER</p>
            <h1 className="mt-3 text-4xl font-semibold text-white tracking-tight">Crypto Trading Dashboard</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
              Live Bybit spot candles for MNT/USDT with a clean trading dashboard.
            </p>
          </div>
          <div className="inline-flex items-center gap-3 rounded-full bg-slate-900/80 px-4 py-2 text-sm text-slate-200 ring-1 ring-white/10 shadow-sm">
            <span className="inline-flex h-7 items-center rounded-full bg-violet-500/20 px-3 text-violet-200">PAPER TRADING</span>
            <div className="ml-3 flex items-center gap-3">
              {walletAddress ? (
                <div className="flex items-center gap-3">
                  <div className="text-sm text-slate-300">{shortAddress}</div>
                  <div className="text-xs text-slate-400">{networkName || '-'}</div>
                </div>
              ) : (
                <button onClick={connectWallet} className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold">Connect Wallet</button>
              )}
              {!isCorrectNetwork && (
                <button onClick={switchToMantleSepolia} className="rounded-md bg-yellow-600 px-3 py-1 text-xs font-semibold">Switch to Mantle Sepolia</button>
              )}
            </div>
          </div>
        </header>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {stats.map((card) => (
            <div key={card.label} className="rounded-3xl border border-border/70 bg-panel/80 p-5 shadow-glow backdrop-blur">
              <p className="text-sm text-slate-400">{card.label}</p>
              <p className="mt-4 text-3xl font-semibold text-white">{card.value}</p>
              <p className="mt-2 text-sm text-slate-400">{card.trend}</p>
            </div>
          ))}
        </section>
        <section className="mt-6 rounded-3xl border border-border/70 bg-panel/80 p-6 shadow-glow backdrop-blur">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.35em] text-slate-400">On-chain Signals</p>
              <h2 className="mt-2 text-2xl font-semibold text-white">TradeSignalRegistry (Mantle Sepolia)</h2>
            </div>
            <div className="flex items-center gap-3">
              <a href={`https://explorer.sepolia.mantle.xyz/address/${TRADE_SIGNAL_REGISTRY_ADDRESS}`} target="_blank" rel="noreferrer" className="text-sm text-slate-400 underline">View contract</a>
              <button onClick={loadSignals} className="rounded-2xl bg-slate-900/90 px-4 py-2 text-sm font-semibold text-slate-100">Refresh</button>
            </div>
          </div>

          <div className="mt-4">
            {txHash && (
              <div className="mb-3 rounded-md bg-slate-900/80 p-3 text-sm">
                Tx: <a className="underline text-emerald-300" href={`https://explorer.sepolia.mantle.xyz/tx/${txHash}`} target="_blank" rel="noreferrer">{txHash}</a>
              </div>
            )}

            {loadingSignals ? (
              <div className="py-6 text-center text-slate-400">Loading signals…</div>
            ) : signals.length === 0 ? (
              <div className="py-6 text-center text-slate-400">No on-chain signals yet</div>
            ) : (
              <div className="space-y-3">
                {signals.map((s, idx) => (
                  <div key={`${s.trader}-${idx}`} className="rounded-2xl border border-slate-800 bg-slate-950/80 p-3 text-sm text-slate-300">
                    <div className="flex justify-between text-slate-400">
                      <span>{shorten(s.trader)}</span>
                      <span>{new Date(s.timestamp * 1000).toLocaleString()}</span>
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      <div>Pair {s.symbol}</div>
                      <div>Action {s.action}</div>
                      <div>Price {(s.price / 1e8).toFixed(6)}</div>
                    </div>
                    <div className="mt-2 text-slate-400">Confidence: {s.confidence}%</div>
                    <div className="mt-2 text-slate-300">{s.reason}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-[2fr_1fr]">
          <div className="rounded-3xl border border-border/70 bg-panel/80 p-6 shadow-glow backdrop-blur">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm uppercase tracking-[0.35em] text-slate-400">Market view</p>
                <h2 className="mt-2 text-2xl font-semibold text-white">{marketInfo.symbol}</h2>
                <p className="mt-1 text-sm text-slate-400">{marketInfo.exchange} • {marketInfo.timeframe}</p>
              </div>
              <div className="rounded-2xl bg-slate-900/80 px-3 py-1 text-sm text-slate-300">
                {loading ? 'Loading...' : latestPrice ? `$${latestPrice.toFixed(6)}` : 'Price unavailable'}
              </div>
            </div>
            {error ? (
              <div className="mt-8 rounded-3xl border border-red-500/30 bg-red-500/10 p-5 text-sm text-red-200">
                Error loading candles: {error}
              </div>
            ) : (
              <div className="mt-8 overflow-hidden rounded-[2rem] border border-border/60 bg-slate-950/70 p-4">
                <div ref={chartContainerRef} className="h-[360px] w-full" />
              </div>
            )}
            <div className="mt-5 flex flex-wrap gap-3 text-sm text-slate-400">
              <span className="rounded-full border border-slate-700 px-3 py-1">1H</span>
              <span className="rounded-full border border-slate-700 px-3 py-1">{marketInfo.exchange}</span>
              <span className="rounded-full border border-slate-700 px-3 py-1">MNT/USDT</span>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-3xl border border-border/70 bg-panel/80 p-6 shadow-glow backdrop-blur">
              <p className="text-sm uppercase tracking-[0.35em] text-slate-400">Market analysis</p>
              <h2 className="mt-3 text-2xl font-semibold text-white">Price momentum overview</h2>
              <p className="mt-4 text-sm leading-6 text-slate-300">
                Live {marketInfo.exchange} candlestick data for the selected spot pair in an easy-to-read trading interface.
              </p>
              <div className="mt-6 space-y-3 rounded-3xl bg-slate-900/80 p-4 text-sm text-slate-300">
                {aiLoading ? (
                  <div className="py-4 text-center">Analysis running...</div>
                ) : aiError ? (
                  <div className="py-4 text-center text-red-300">Analysis error: {aiError}</div>
                ) : aiResult ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">Signal</span>
                      <span className={aiResult.action === 'BUY' ? 'text-emerald-400' : 'text-slate-300'}>{aiResult.action}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Confidence</span>
                      <span>{Math.round(aiResult.confidence * 100)}%</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Support</span>
                      <span>${aiResult.support_price.toFixed(6)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Resistance</span>
                      <span>${aiResult.resistance_price.toFixed(6)}</span>
                    </div>
                    <div>
                      <p className="text-sm text-slate-300">{aiResult.reason}</p>
                      {aiTime && <p className="mt-2 text-xs text-slate-400">Updated: {aiTime}</p>}
                    </div>
                  </div>
                ) : (
                  <div className="py-4 text-center text-slate-300">Press "Analyze Now" to run Gemini analysis.</div>
                )}
              </div>
              <div className="mt-4 flex items-center justify-end">
                {aiResult && (
                  <button
                    onClick={recordAiSignalOnChain}
                    disabled={!walletAddress || !isCorrectNetwork}
                    className="mr-3 rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white transition disabled:opacity-60"
                  >
                    Record AI Signal On-chain
                  </button>
                )}
                <button
                  onClick={analyzeNow}
                  disabled={aiLoading}
                  className="rounded-2xl bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-100 transition disabled:opacity-60"
                >
                  {aiLoading ? 'Analyzing…' : 'Analyze Now'}
                </button>
              </div>
            </div>

            <div className="rounded-3xl border border-border/70 bg-panel/80 p-6 shadow-glow backdrop-blur">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm uppercase tracking-[0.35em] text-slate-400">Agent controls</p>
                  <h2 className="mt-2 text-2xl font-semibold text-white">Live trading agent</h2>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${account?.agent_running ? 'bg-emerald-500/20 text-emerald-200' : 'bg-slate-700/80 text-slate-300'}`}>
                  {account?.agent_running ? 'Running' : 'Stopped'}
                </span>
              </div>
              <div className="mt-6 grid gap-3">
                <button
                  onClick={() => handleAgentAction('start')}
                  disabled={controlLoading || account?.agent_running}
                  className="rounded-2xl bg-accent px-4 py-3 text-sm font-semibold text-white transition disabled:opacity-60"
                >
                  Start Agent
                </button>
                <button
                  onClick={() => handleAgentAction('stop')}
                  disabled={controlLoading || !account?.agent_running}
                  className="rounded-2xl bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-100 transition disabled:opacity-60"
                >
                  Stop Agent
                </button>
                <button
                  onClick={handleReset}
                  disabled={controlLoading}
                  className="rounded-2xl border border-slate-700 bg-slate-900/90 px-4 py-3 text-sm font-semibold text-slate-100 transition disabled:opacity-60"
                >
                  Reset Account
                </button>
              </div>
              {statusError && (
                <div className="mt-4 rounded-3xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
                  {statusError}
                </div>
              )}
            </div>

            <div className="rounded-3xl border border-border/70 bg-panel/80 p-6 shadow-glow backdrop-blur">
              <p className="text-sm uppercase tracking-[0.35em] text-slate-400">Account snapshot</p>
              <div className="mt-4 space-y-3 text-sm text-slate-300">
                <div className="flex items-center justify-between">
                  <span>Available USDT</span>
                  <span>{account ? formatCurrency(account.usdt_balance) : '-'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>MNT held</span>
                  <span>{account ? account.mnt_held.toFixed(4) : '-'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Equity</span>
                  <span>{account ? formatCurrency(account.equity) : '-'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Cooldown</span>
                  <span>{account ? `${account.cooldown_remaining} candles` : '-'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Last hold reason</span>
                  <span className="max-w-[12rem] truncate text-right text-slate-400">{account?.last_hold_reason || '-'}</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-[2fr_1fr]">
          <div className="rounded-3xl border border-border/70 bg-panel/80 p-6 shadow-glow backdrop-blur">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm uppercase tracking-[0.35em] text-slate-400">Trade history</p>
                <h2 className="mt-2 text-2xl font-semibold text-white">Open position & closed trades</h2>
              </div>
              <button
                onClick={fetchTrades}
                className="rounded-2xl bg-slate-900/90 px-4 py-2 text-sm font-semibold text-slate-100 transition hover:bg-slate-800"
              >
                Refresh
              </button>
            </div>

            <div className="mt-6 space-y-6">
              <div className="rounded-3xl border border-border/70 bg-slate-950/80 p-4">
                <p className="text-sm uppercase tracking-[0.35em] text-slate-400">Open trade</p>
                {trades?.open_trade ? (
                  <div className="mt-4 space-y-3 text-sm text-slate-300">
                    <div className="flex justify-between">
                      <span>Entry price</span>
                      <span>${trades.open_trade.entry_price.toFixed(6)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Quantity</span>
                      <span>{trades.open_trade.quantity.toFixed(4)} MNT</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Take profit</span>
                      <span>${trades.open_trade.take_profit_price.toFixed(6)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Stop loss</span>
                      <span>${trades.open_trade.stop_loss_price.toFixed(6)}</span>
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 rounded-2xl bg-slate-900/80 p-4 text-sm text-slate-400">No open trade</div>
                )}
              </div>

              <div className="rounded-3xl border border-border/70 bg-slate-950/80 p-4">
                <p className="text-sm uppercase tracking-[0.35em] text-slate-400">Recent closes</p>
                {trades?.trades_history?.length ? (
                  <div className="mt-4 space-y-3 text-sm text-slate-300">
                    {trades.trades_history.slice(-4).reverse().map((trade) => (
                      <div key={trade.id} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3">
                        <div className="flex justify-between text-slate-400">
                          <span>#{trade.id}</span>
                          <span>{trade.status}</span>
                        </div>
                        <div className="mt-2 grid gap-2 text-sm text-slate-300 sm:grid-cols-2">
                          <div>Entry {trade.entry_price.toFixed(6)}</div>
                          <div>Close {trade.close_price?.toFixed(6) ?? '—'}</div>
                          <div>PnL {trade.pnl_usdt?.toFixed(2) ?? '—'}</div>
                          <div>{trade.close_reason ?? '—'}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-4 rounded-2xl bg-slate-900/80 p-4 text-sm text-slate-400">No closed trades yet</div>
                )}
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-border/70 bg-panel/80 p-6 shadow-glow backdrop-blur">
            <p className="text-sm uppercase tracking-[0.35em] text-slate-400">Analysis & logs</p>
            <div className="mt-4 space-y-3 rounded-3xl bg-slate-950/80 p-4 text-sm text-slate-300">
              <div className="flex justify-between border-b border-slate-800 pb-3">
                <span>Last analysis</span>
                <span className="text-slate-400">{aiTime || '-'}</span>
              </div>
              <div>
                <p className="text-slate-400">Signal:</p>
                <p className="text-white">{aiResult ? aiResult.action : '-'}</p>
              </div>
              <div>
                <p className="text-slate-400">Reason:</p>
                <p className="text-slate-300">{aiResult?.reason || account?.last_hold_reason || '-'}</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

export default App
