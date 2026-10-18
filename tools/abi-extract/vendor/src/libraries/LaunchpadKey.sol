// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IHooks} from "infinity-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "infinity-core/src/interfaces/IPoolManager.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";

// The pool geometry every launchpad pool shares, file-level so the suites,
// `LaunchParams.toJson` and the shared mirror (`packages/shared`, asserted
// against this file's AST on every `npm run check`) import the one value the
// contracts inline.
int24 constant TICK_SPACING = 200;

/// @dev PancakeSwap Infinity's LP-fee flags (`LPFeeLibrary`, GPL — the two
/// values are declared here so Layer 1 inlines no GPL code): a pool key whose
/// `fee` is DYNAMIC_FEE_FLAG has a hook-set fee; a `beforeSwap` return carrying
/// OVERRIDE_FEE_FLAG replaces the stored fee for that swap; MAX_LP_FEE is 100%
/// in pips. `test/InfinityConformance.t.sol` pins all three against the library
/// the pool manager runs.
uint24 constant DYNAMIC_FEE_FLAG = 0x800000;
uint24 constant OVERRIDE_FEE_FLAG = 0x400000;
uint24 constant MAX_LP_FEE = 1_000_000;

/// @dev The launchpad's hook registration: Infinity reads a hook's permissions
/// from the low 16 bits of `PoolKey.parameters` (checked against
/// `getHooksRegistrationBitmap()` at initialize), not from its address — so
/// nothing is mined and the launchpad is a plain deploy. beforeInitialize (bit
/// 0) + beforeAddLiquidity (2) + beforeSwap (6) + beforeSwapReturnsDelta (10).
/// `AscendLaunchpad.getHookPermissions` is the readable form; the suites hold
/// the two equal.
uint16 constant HOOK_BITMAP = 0x0445;

/// @dev `PoolKey.parameters` for every launchpad pool: the bitmap in the low
/// 16 bits, the tick spacing in bits 16–39 (`CLPoolParametersHelper`), nothing
/// above (the pool manager refuses a set unused bit). 0xC80445.
bytes32 constant POOL_PARAMETERS = bytes32(uint256(HOOK_BITMAP) | (uint256(uint24(TICK_SPACING)) << 16));

/// @notice Every launchpad pool's key is a pure function of its pair — same
/// fee flag, spacing and hook, on one pool manager — derived, never stored.
/// Consumers: the launchpad (initialize, seed, collect, the fill), the
/// community vault and the CTO registry (a pool's identity from its pair), the
/// suites' `PoolKeys`, and the web's `poolKeyOf` mirror (`web/src/lib/trade.ts`).
library LaunchpadKey {
    function keyOf(address token, address quote, address hook, address poolManager)
        internal
        pure
        returns (PoolKey memory)
    {
        bool tokenIs0 = token < quote;
        return PoolKey({
            currency0: Currency.wrap(tokenIs0 ? token : quote),
            currency1: Currency.wrap(tokenIs0 ? quote : token),
            hooks: IHooks(hook),
            poolManager: IPoolManager(poolManager),
            fee: DYNAMIC_FEE_FLAG,
            parameters: POOL_PARAMETERS
        });
    }
}
