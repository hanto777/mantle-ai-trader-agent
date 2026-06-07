import { Contract, Interface, JsonRpcProvider, getAddress } from "ethers";

const CHAIN_ID = 5003n;
const NETWORK_NAME = "Mantle Sepolia";
const RPC_URL = process.env.MANTLE_SEPOLIA_RPC_URL ?? "https://rpc.sepolia.mantle.xyz";
const IDENTITY_REGISTRY = getAddress("0x8004A818BFB912233c491871b3d84c89A494BD9e");
const DEFAULT_AGENT_URI =
  "https://raw.githubusercontent.com/hanto777/mantle-ai-trader-agent/main/frontend/public/erc-8004-agent.json";
const agentURI = process.env.ERC8004_AGENT_URI ?? DEFAULT_AGENT_URI;
const owner = process.env.ERC8004_OWNER_ADDRESS
  ? getAddress(process.env.ERC8004_OWNER_ADDRESS)
  : null;

const abi = [
  "function register(string agentURI) returns (uint256 agentId)",
];

if (!owner) {
  throw new Error(
    "Set ERC8004_OWNER_ADDRESS to the testnet wallet that would own the Identity NFT.",
  );
}

const provider = new JsonRpcProvider(RPC_URL);
const network = await provider.getNetwork();

if (network.chainId !== CHAIN_ID) {
  throw new Error(`Refusing chain ${network.chainId}; expected ${NETWORK_NAME} (${CHAIN_ID}).`);
}

const code = await provider.getCode(IDENTITY_REGISTRY);
if (code === "0x") {
  throw new Error(`No contract bytecode at ${IDENTITY_REGISTRY} on ${NETWORK_NAME}.`);
}

const registry = new Contract(IDENTITY_REGISTRY, abi, provider);
const agentId = await registry.register.staticCall(agentURI, { from: owner });
const gasEstimate = await registry.register.estimateGas(agentURI, { from: owner });
const data = new Interface(abi).encodeFunctionData("register", [agentURI]);

console.log(
  JSON.stringify(
    {
      safety: "READ_ONLY_SIMULATION_NO_TRANSACTION_SENT",
      network: NETWORK_NAME,
      chainId: network.chainId.toString(),
      from: owner,
      to: IDENTITY_REGISTRY,
      value: "0",
      agentURI,
      simulatedAgentId: agentId.toString(),
      gasEstimate: gasEstimate.toString(),
      data,
      nextStep:
        "After organizer confirmation, submit this transaction request from the owner wallet, then add the minted agentId to registrations in the JSON.",
    },
    null,
    2,
  ),
);
