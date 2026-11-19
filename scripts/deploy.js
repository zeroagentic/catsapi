const { ethers, network } = require("hardhat");

// Real SPACE ID Agent ID registry — same address on BSC mainnet (56).
// On BSC testnet (97) there is no official registry: deploy contracts/mocks/MockAgentId.sol
// first and put its address in AGENT_ID_REGISTRY in .env.
const MAINNET_REGISTRY = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F";

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  console.log(`Network: ${network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} BNB`);

  const registry = process.env.AGENT_ID_REGISTRY || (chainId === 56 ? MAINNET_REGISTRY : "");
  if (!registry) {
    throw new Error("Set AGENT_ID_REGISTRY in .env (on testnet: deploy MockAgentId first)");
  }

  const name = process.env.NFT_NAME || "CatsApi";
  const symbol = process.env.NFT_SYMBOL || "CATS";
  const baseURI = process.env.BASE_URI || "ipfs://REPLACE_WITH_METADATA_CID/";
  const placeholderURI = process.env.PLACEHOLDER_URI || "ipfs://REPLACE_WITH_METADATA_CID/hidden.json";

  const initialOwner = process.env.INITIAL_OWNER || deployer.address;
  const NFT = await ethers.getContractFactory("AgentGatedNFT");
  const nft = await NFT.deploy(name, symbol, registry, baseURI, placeholderURI, initialOwner);
  await nft.waitForDeployment();
  const address = await nft.getAddress();

  console.log(`\nAgentGatedNFT deployed: ${address}`);
  console.log(`  name/symbol : ${name} / ${symbol}`);
  console.log(`  registry    : ${registry}`);
  console.log(`  MAX_SUPPLY  : ${await nft.MAX_SUPPLY()}`);
  console.log(`  FREE_SUPPLY : ${await nft.FREE_SUPPLY()} (1 free / wallet, Agent ID holders)`);
  console.log(`  PRICE       : ${ethers.formatEther(await nft.PRICE())} BNB`);
  console.log(`  mintOpen    : ${await nft.mintOpen()}  <-- still CLOSED. Open it when ready:`);
  console.log(`\n  await (await nft.setMintOpen(true)) via hardhat console / cast / BscScan write`);
  console.log(`\nVerify on BscScan:`);
  console.log(`  npx hardhat verify --network ${network.name} ${address} "${name}" "${symbol}" "${registry}" "${baseURI}" "${placeholderURI}"`);
  console.log(`\nPut this in frontend/index.html CONFIG.contractAddress: ${address}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
