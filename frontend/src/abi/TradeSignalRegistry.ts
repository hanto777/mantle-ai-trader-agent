export const TradeSignalRegistryABI = [
  {
    "inputs": [
      { "internalType": "string", "name": "symbol", "type": "string" },
      { "internalType": "string", "name": "action", "type": "string" },
      { "internalType": "uint256", "name": "price", "type": "uint256" },
      { "internalType": "uint256", "name": "confidence", "type": "uint256" },
      { "internalType": "string", "name": "reason", "type": "string" }
    ],
    "name": "recordSignal",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getSignalsCount",
    "outputs": [ { "internalType": "uint256", "name": "", "type": "uint256" } ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [ { "internalType": "uint256", "name": "index", "type": "uint256" } ],
    "name": "getSignal",
    "outputs": [
      {
        "components": [
          { "internalType": "address", "name": "trader", "type": "address" },
          { "internalType": "string", "name": "symbol", "type": "string" },
          { "internalType": "string", "name": "action", "type": "string" },
          { "internalType": "uint256", "name": "price", "type": "uint256" },
          { "internalType": "uint256", "name": "confidence", "type": "uint256" },
          { "internalType": "uint256", "name": "timestamp", "type": "uint256" },
          { "internalType": "string", "name": "reason", "type": "string" }
        ],
        "internalType": "struct TradeSignalRegistry.Signal",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "trader", "type": "address" },
      { "indexed": false, "internalType": "string", "name": "symbol", "type": "string" },
      { "indexed": false, "internalType": "string", "name": "action", "type": "string" },
      { "indexed": false, "internalType": "uint256", "name": "price", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "confidence", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "timestamp", "type": "uint256" },
      { "indexed": false, "internalType": "string", "name": "reason", "type": "string" }
    ],
    "name": "SignalRecorded",
    "type": "event"
  }
] as const;

export const TRADE_SIGNAL_REGISTRY_ADDRESS = '0x9Fa694367e58eB96cEB29aCF653d5880f843070D';
export const MANTLE_SEPOLIA_RPC = 'https://rpc.sepolia.mantle.xyz';
export const MANTLE_SEPOLIA_CHAIN_ID_HEX = '0x138B';
export const MANTLE_SEPOLIA_CHAIN_ID = 5003;
