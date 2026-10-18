// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal two-step ownership: privilege handoffs always name a counterparty
/// and complete only when the new key proves it can act (custody-rotation doctrine).
abstract contract TwoStepOwned {
    address public owner;
    address public pendingOwner;

    event OwnerUpdated(address indexed previousOwner, address indexed newOwner);
    event OwnerProposed(address indexed proposedOwner);

    error Unauthorized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address initialOwner) {
        // A zero owner is unrecoverable by construction (no renounce path exists
        // to abuse, so none exists to fix it either): every onlyOwner entry point
        // would be dead forever and treasuries unsweepable. Refuse at the root so
        // a blank OWNER env var can never produce a green deploy (AUDIT
        // 2026-08-30 AUD-6).
        if (initialOwner == address(0)) revert Unauthorized();
        owner = initialOwner;
        emit OwnerUpdated(address(0), initialOwner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnerProposed(newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        emit OwnerUpdated(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
        _afterOwnershipTransfer();
    }

    /// @dev CTO invalidates approvals on every reviewer rotation, including a
    /// later rotation back to an earlier wallet. Existing owners have no hook.
    function _afterOwnershipTransfer() internal virtual {}
}
