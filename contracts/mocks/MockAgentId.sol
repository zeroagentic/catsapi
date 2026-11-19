// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Local-test stand-in for the SPACE ID Agent ID registry.
///         NEVER deploy this on mainnet as the gate — use the real registry:
///         0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F
contract MockAgentId is ERC721 {
    uint256 private _nextId = 1;

    constructor() ERC721("SPACE ID Agent ID", "AI") {}

    function mintMock() external {
        _mint(msg.sender, _nextId++);
    }
}
