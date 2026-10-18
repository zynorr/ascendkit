// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {BalanceDelta} from "infinity-core/src/types/BalanceDelta.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

/// @notice The two ways this codebase settles with the Vault, written once:
/// paying a currency we owe (sync → transfer → settle), and the exact-input buy of
/// a pool's token with its quote (swap → take the token → pay the quote). Caller:
/// AscendLaunchpad — the seed and the atomic dev-buy (both), and the fill's settle
/// inside beforeSwap (`pay`). Every call runs inside a lock the caller already
/// holds, from the caller's own balance — no ERC-6909 claims, which is why this
/// is a dozen lines. Infinity keeps every pool's tokens in the Vault, so the
/// Vault is what gets paid and what pays out; the pool manager only books.
library VaultPay {
    using SafeTransferLib for ERC20;

    /// @dev Settle `amount` of an ERC-20 `currency` owed to the Vault, from this
    /// contract's balance: sync snapshots the reserve, the transfer raises it,
    /// settle credits the difference. ERC-20 only — every quote is a configured
    /// non-zero ERC-20 and every token an AscendToken, and native HYPE would
    /// settle by `msg.value` instead (the Vault refuses value on an ERC-20 settle,
    /// so a native currency here reverts rather than mis-books).
    function pay(IVault vault, Currency currency, uint256 amount) internal {
        vault.sync(currency);
        ERC20(Currency.unwrap(currency)).safeTransfer(address(vault), amount);
        vault.settle();
    }

    /// @dev Exact-input buy of the pool's token with `quoteIn` of its quote, bounded by
    /// `sqrtLimit`: the token goes to `to`, the quote is paid from this contract.
    /// Returns what the swap actually spent and delivered — a fill that stops at the
    /// limit spends less than `quoteIn`, and the caller decides what that means.
    function buyExactIn(
        IVault vault,
        ICLPoolManager pm,
        PoolKey memory key,
        bool tokenIs0,
        uint256 quoteIn,
        uint160 sqrtLimit,
        address to
    ) internal returns (uint256 spent, uint256 out) {
        // Paying quote for token: token == c0 → paying c1 (price rises, zeroForOne = false);
        // token == c1 → paying c0 (price falls, zeroForOne = true).
        bool zeroForOne = !tokenIs0;
        BalanceDelta delta = pm.swap(
            key,
            ICLPoolManager.SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(quoteIn), sqrtPriceLimitX96: sqrtLimit}),
            ""
        );
        // Negative delta side = we owe (quote in); positive = owed to us (token out).
        (int128 quoteDelta, int128 tokenDelta) =
            zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        spent = uint256(uint128(-quoteDelta));
        out = uint256(uint128(tokenDelta));
        if (out > 0) vault.take(tokenIs0 ? key.currency0 : key.currency1, to, out);
        if (spent > 0) pay(vault, tokenIs0 ? key.currency1 : key.currency0, spent);
    }
}
