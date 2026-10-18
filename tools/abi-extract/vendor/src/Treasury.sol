// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TwoStepOwned} from "./base/TwoStepOwned.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

/// @notice Fixed custody for one budget, in any received asset. The launchpad
/// deploys five fee treasuries, a purchased-token cohort reserve and protocol
/// token inventory. Two fee treasuries add fixed staking converters. Only the owner can sweep a named amount
/// to a named recipient. Receipts are not conversions or completed purchases.
/// ProtocolFeesAllocated records fee funding; Swept records custody movement.
/// Direct donations can add custody without fee revenue.
contract Treasury is TwoStepOwned {
    error ZeroRecipient();

    /// @notice Every sweep, on-chain, complementing the fee inflows recorded
    /// by ProtocolFeesAllocated (deep-pass DP-R10, 2026-08-31). Consumer:
    /// the indexer's admin_events and per-asset custody outflow columns.
    event Swept(address indexed token, address indexed to, uint256 amount);

    constructor(address initialOwner) TwoStepOwned(initialOwner) {}

    receive() external payable {}

    function sweep(address token, address to, uint256 amount) external onlyOwner {
        // Custody moves always name a counterparty (custody-rotation doctrine);
        // solmate's transfer does not block the zero address, so this must.
        if (to == address(0) || to == address(0xdead)) revert ZeroRecipient();
        if (token == address(0)) SafeTransferLib.safeTransferETH(to, amount);
        else SafeTransferLib.safeTransfer(ERC20(token), to, amount);
        emit Swept(token, to, amount);
    }
}
