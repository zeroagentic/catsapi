// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAgentIdRegistry {
    function balanceOf(address owner) external view returns (uint256);
}

/// @title AgentGatedNFT — ERC-721 gated by Binance / SPACE ID Agent ID on BSC
/// @notice Gate registry (BSC mainnet): 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F
///         ("SPACE ID Agent ID", symbol AI). Verified live 2026-11-06:
///         balanceOf(mikaprjkt wallet) = 1.
/// @dev Economics — CatsApi, set by the owner 2026-11-06:
///      - MAX_SUPPLY      2,500
///      - FREE_SUPPLY     first 1,500 mints can use the free slot
///      - FREE_PER_WALLET 1 free mint per wallet (Agent ID holders only)
///      - PRICE           0.001 BNB per paid mint
///      - MAX_PER_WALLET  5 total per wallet
contract AgentGatedNFT is ERC721, ERC2981, Ownable, ReentrancyGuard {
    uint256 public constant MAX_SUPPLY = 2500;
    uint256 public constant FREE_SUPPLY = 1500;
    uint256 public constant FREE_PER_WALLET = 1;
    uint256 public constant MAX_PER_WALLET = 5;
    uint256 public constant PRICE = 0.001 ether;

    IAgentIdRegistry public agentIdRegistry;

    bool public mintOpen;
    bool public requireAgentId = true;
    bool public revealed;

    uint256 public totalMinted;
    uint256 public freeMinted;
    mapping(address => uint256) public mintedBy;
    mapping(address => uint256) public freeUsedBy;

    string private _baseTokenURI;
    string public placeholderURI;

    event Minted(address indexed minter, uint256 firstTokenId, uint256 quantity, uint256 freeQuantity, uint256 paidWei);
    event MintOpenSet(bool open);
    event RequireAgentIdSet(bool required);
    event RegistrySet(address indexed registry);
    event Revealed(string baseURI);

    constructor(
        string memory name_,
        string memory symbol_,
        address registry_,
        string memory baseURI_,
        string memory placeholderURI_,
        address initialOwner_
    ) ERC721(name_, symbol_) Ownable(initialOwner_) {
        require(registry_ != address(0), "registry=0");
        require(initialOwner_ != address(0), "owner=0");
        agentIdRegistry = IAgentIdRegistry(registry_);
        _baseTokenURI = baseURI_;
        placeholderURI = placeholderURI_;
        // 5% default royalty to the owner. Change with setRoyalty() or remove.
        // initialOwner_ is a parameter (not msg.sender) so the contract can be
        // deployed through a CREATE2 factory while the real wallet owns it.
        _setDefaultRoyalty(initialOwner_, 500);
    }

    // ---------- views ----------

    function hasAgentId(address wallet) public view returns (bool) {
        try agentIdRegistry.balanceOf(wallet) returns (uint256 bal) {
            return bal > 0;
        } catch {
            return false;
        }
    }

    /// @return cost total wei required, freeQty how many of `quantity` are free for this wallet right now
    function quote(address wallet, uint256 quantity) public view returns (uint256 cost, uint256 freeQty) {
        uint256 freeLeftForWallet = FREE_PER_WALLET > freeUsedBy[wallet] ? FREE_PER_WALLET - freeUsedBy[wallet] : 0;
        uint256 freeLeftGlobal = FREE_SUPPLY > freeMinted ? FREE_SUPPLY - freeMinted : 0;
        freeQty = quantity;
        if (freeQty > freeLeftForWallet) freeQty = freeLeftForWallet;
        if (freeQty > freeLeftGlobal) freeQty = freeLeftGlobal;
        // Free slot only applies to Agent ID holders (and only while the gate is on).
        if (requireAgentId && !hasAgentId(wallet)) freeQty = 0;
        cost = (quantity - freeQty) * PRICE;
    }

    function costFor(address wallet, uint256 quantity) external view returns (uint256) {
        (uint256 cost, ) = quote(wallet, quantity);
        return cost;
    }

    // ---------- mint ----------

    function mint(uint256 quantity) external payable nonReentrant {
        require(mintOpen, "mint closed");
        require(quantity > 0, "qty=0");
        require(totalMinted + quantity <= MAX_SUPPLY, "sold out");
        require(mintedBy[msg.sender] + quantity <= MAX_PER_WALLET, "max per wallet");
        require(msg.sender == tx.origin, "contracts cannot mint");
        if (requireAgentId) {
            require(hasAgentId(msg.sender), "Agent ID required");
        }

        (uint256 cost, uint256 freeQty) = quote(msg.sender, quantity);
        require(msg.value == cost, "wrong value: use quote()");

        uint256 firstTokenId = totalMinted + 1;
        // Effects before external calls (_safeMint can callback).
        totalMinted += quantity;
        mintedBy[msg.sender] += quantity;
        if (freeQty > 0) {
            freeMinted += freeQty;
            freeUsedBy[msg.sender] += freeQty;
        }

        for (uint256 i = 0; i < quantity; i++) {
            _safeMint(msg.sender, firstTokenId + i);
        }
        emit Minted(msg.sender, firstTokenId, quantity, freeQty, cost);
    }

    // ---------- metadata ----------

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        if (!revealed && bytes(placeholderURI).length > 0) {
            return placeholderURI;
        }
        return string(abi.encodePacked(_baseTokenURI, _toString(tokenId), ".json"));
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    // ---------- owner ----------

    function setMintOpen(bool open_) external onlyOwner {
        mintOpen = open_;
        emit MintOpenSet(open_);
    }

    function setRequireAgentId(bool required_) external onlyOwner {
        requireAgentId = required_;
        emit RequireAgentIdSet(required_);
    }

    function setRegistry(address registry_) external onlyOwner {
        require(registry_ != address(0), "registry=0");
        agentIdRegistry = IAgentIdRegistry(registry_);
        emit RegistrySet(registry_);
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _baseTokenURI = baseURI_;
    }

    function setPlaceholderURI(string calldata placeholderURI_) external onlyOwner {
        placeholderURI = placeholderURI_;
    }

    /// @notice One-way reveal: sets revealed=true permanently (base URI can still be fixed by owner if needed).
    function reveal() external onlyOwner {
        revealed = true;
        emit Revealed(_baseTokenURI);
    }

    function setRoyalty(address receiver, uint96 feeNumerator) external onlyOwner {
        _setDefaultRoyalty(receiver, feeNumerator);
    }

    function withdraw(address payable to) external onlyOwner nonReentrant {
        require(to != address(0), "to=0");
        uint256 bal = address(this).balance;
        require(bal > 0, "no balance");
        (bool ok, ) = to.call{value: bal}("");
        require(ok, "withdraw failed");
    }

    // ---------- interfaces ----------

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
