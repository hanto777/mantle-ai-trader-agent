export const AnalysisCreditVaultABI = [
  {
    inputs: [],
    name: 'deposit',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'user', type: 'address' }],
    name: 'creditsOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'creditsPerMnt',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'paused',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export const ANALYSIS_CREDIT_VAULT_ADDRESS =
  (import.meta.env.VITE_ANALYSIS_CREDIT_VAULT_ADDRESS as string | undefined) ||
  '0x58423C0BEF508aDD4F7C9CaaE34366780FD3A28d'

export const ANALYSIS_CREDIT_REQUIRED = 1
export const ANALYSIS_CREDIT_DEPOSIT_AMOUNT_MNT = '0.01'
