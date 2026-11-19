const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentGatedNFT", function () {
  let registry, nft, owner, alice, bob, carol;

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockAgentId");
    registry = await Mock.deploy();

    const NFT = await ethers.getContractFactory("AgentGatedNFT");
    nft = await NFT.deploy(
      "CatsApi",
      "CATS",
      await registry.getAddress(),
      "ipfs://REPLACE_WITH_METADATA_CID/",
      "ipfs://REPLACE_WITH_METADATA_CID/hidden.json",
      owner.address
    );

    // alice + bob hold an Agent ID, carol does not
    await registry.connect(alice).mintMock();
    await registry.connect(bob).mintMock();
  });

  it("reports Agent ID ownership correctly", async function () {
    expect(await nft.hasAgentId(alice.address)).to.equal(true);
    expect(await nft.hasAgentId(carol.address)).to.equal(false);
  });

  it("blocks mint while closed, and blocks non-holders when open", async function () {
    await expect(nft.connect(alice).mint(1, { value: 0 })).to.be.revertedWith("mint closed");
    await nft.setMintOpen(true);
    await expect(nft.connect(carol).mint(1, { value: 0 })).to.be.revertedWith("Agent ID required");
  });

  it("first mint is free for Agent ID holders, second costs PRICE", async function () {
    await nft.setMintOpen(true);
    expect(await nft.quote(alice.address, 1)).to.deep.equal([0n, 1n]);

    await nft.connect(alice).mint(1, { value: 0 });
    expect(await nft.ownerOf(1)).to.equal(alice.address);
    expect(await nft.freeUsedBy(alice.address)).to.equal(1n);
    expect(await nft.freeMinted()).to.equal(1n);

    const price = await nft.PRICE();
    expect(await nft.quote(alice.address, 1)).to.deep.equal([price, 0n]);
    await expect(nft.connect(alice).mint(1, { value: 0 })).to.be.revertedWith("wrong value: use quote()");
    await nft.connect(alice).mint(1, { value: price });
    expect(await nft.ownerOf(2)).to.equal(alice.address);
    expect(await nft.balanceOf(alice.address)).to.equal(2n);
  });

  it("mixed batch: mint(3) on a fresh holder = 1 free + 2 paid", async function () {
    await nft.setMintOpen(true);
    const price = await nft.PRICE();
    const [cost, freeQty] = await nft.quote(bob.address, 3);
    expect(freeQty).to.equal(1n);
    expect(cost).to.equal(price * 2n);
    await nft.connect(bob).mint(3, { value: cost });
    expect(await nft.balanceOf(bob.address)).to.equal(3n);
  });

  it("enforces max per wallet (5)", async function () {
    await nft.setMintOpen(true);
    const price = await nft.PRICE();
    await nft.connect(alice).mint(5, { value: price * 4n }); // 1 free + 4 paid
    await expect(nft.connect(alice).mint(1, { value: price })).to.be.revertedWith("max per wallet");
  });

  it("tokenURI is placeholder before reveal, base+id.json after", async function () {
    await nft.setMintOpen(true);
    await nft.connect(alice).mint(1, { value: 0 });
    expect(await nft.tokenURI(1)).to.equal("ipfs://REPLACE_WITH_METADATA_CID/hidden.json");
    await nft.reveal();
    expect(await nft.tokenURI(1)).to.equal("ipfs://REPLACE_WITH_METADATA_CID/1.json");
  });

  it("owner can withdraw paid proceeds, non-owner cannot", async function () {
    await nft.setMintOpen(true);
    const price = await nft.PRICE();
    await nft.connect(alice).mint(2, { value: price }); // 1 free + 1 paid
    const before = await ethers.provider.getBalance(owner.address);
    const tx = await nft.withdraw(owner.address);
    const receipt = await tx.wait();
    const gas = receipt.gasUsed * receipt.gasPrice;
    const after = await ethers.provider.getBalance(owner.address);
    expect(after).to.equal(before + price - gas);
    await expect(nft.connect(alice).withdraw(alice.address)).to.be.reverted;
  });

  it("owner can open the gate to public (requireAgentId=false)", async function () {
    await nft.setMintOpen(true);
    await nft.setRequireAgentId(false);
    // No free slot for non-holders even with the gate off? quote() gives free only
    // while requireAgentId is true-checked against hasAgentId — with the gate off,
    // carol has no history, so her free-per-wallet slot applies via global cap logic
    // only when requireAgentId==false path skips the hasAgentId zeroing.
    const price = await nft.PRICE();
    const [cost] = await nft.quote(carol.address, 1);
    await nft.connect(carol).mint(1, { value: cost });
    expect(await nft.ownerOf(1)).to.equal(carol.address);
    expect(price).to.be.gt(0n);
  });
});
