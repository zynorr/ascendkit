// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// @notice The only token the launchpad mints: fixed supply, no owner, no later
/// mint or burn path. Vanilla by construction so pools never contain weird-ERC20 behavior
/// on the token side (THREAT_MODEL SC-4).
contract AscendToken is ERC20 {
    error InvalidRecipient();
    constructor(string memory name_, string memory symbol_, uint256 supply_) ERC20(name_, symbol_, 18) {
        _mint(msg.sender, supply_);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        _checkRecipient(to);
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _checkRecipient(to);
        return super.transferFrom(from, to, amount);
    }

    function _checkRecipient(address to) private pure {
        if (to == address(0) || to == address(0xdead)) revert InvalidRecipient();
    }

}
