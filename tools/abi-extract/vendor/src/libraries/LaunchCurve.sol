// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TickMath} from "../vendor/v4-math/TickMath.sol";
import {LiquidityAmounts} from "../vendor/v4-math/LiquidityAmounts.sol";
import {IAscendLaunchpad} from "../interfaces/IAscendLaunchpad.sol";

/// @notice Curve geometry shared by quote validation, seeding and fee collection.
/// Internal functions execute within the launchpad; positions and custody stay there.
library LaunchCurve {
    function validateShape(IAscendLaunchpad.CurveStep[] memory curve, int24 spacing) internal pure returns (int24 top) {
        uint256 bpsSum;
        for (uint256 i; i < curve.length; i++) {
            IAscendLaunchpad.CurveStep memory s = curve[i];
            if (s.offsetLower < top || s.offsetUpper <= s.offsetLower || s.bps == 0) {
                revert IAscendLaunchpad.BadCurve();
            }
            if (s.offsetLower % spacing != 0 || s.offsetUpper % spacing != 0) {
                revert IAscendLaunchpad.BadCurve();
            }
            top = s.offsetUpper;
            bpsSum += s.bps;
        }
        if (curve.length == 0 || bpsSum != 10_000) revert IAscendLaunchpad.BadCurve();
    }

    function mapBand(bool tokenIs0, int24 startTick, IAscendLaunchpad.CurveStep memory step)
        internal
        pure
        returns (int24 lo, int24 up)
    {
        (lo, up) = (startTick + step.offsetLower, startTick + step.offsetUpper);
        if (!tokenIs0) (lo, up) = (-up, -lo);
    }

    function bandLiquidity(bool tokenIs0, int24 startTick, IAscendLaunchpad.CurveStep memory step, uint256 supply)
        internal
        pure
        returns (int24 lo, int24 up, uint128 liquidity)
    {
        (lo, up) = mapBand(tokenIs0, startTick, step);
        uint160 sqrtLo = TickMath.getSqrtPriceAtTick(lo);
        uint160 sqrtUp = TickMath.getSqrtPriceAtTick(up);
        uint256 amount = (supply * step.bps) / 10_000;
        liquidity = tokenIs0
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtLo, sqrtUp, amount)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtLo, sqrtUp, amount);
    }

    /// @dev The pool manager's cap on gross liquidity referencing one tick —
    /// `Tick.tickSpacingToMaxLiquidityPerTick` in Infinity's CL pool (GPL, so
    /// restated here from its own comment: the usable tick range counted in
    /// spacings, the lowest spacing rounded away from zero, uint128.max divided
    /// by that count). `test/InfinityConformance.t.sol` holds the two equal for
    /// every spacing the launchpad could ship with.
    function maxLiquidityPerTick(int24 spacing) internal pure returns (uint128) {
        int24 minTick = TickMath.MIN_TICK / spacing;
        if (TickMath.MIN_TICK % spacing != 0) minTick--;
        int24 maxTick = TickMath.MAX_TICK / spacing;
        uint24 numTicks = uint24(maxTick - minTick + 1);
        return type(uint128).max / numTicks;
    }

    /// @dev Validate against the SAME liquidity calculation used by the seed.
    /// The pool caps gross liquidity per tick, including both bands at a shared edge.
    /// Sorted, non-overlapping bands mean only adjacent bands can share a tick.
    function validateQuote(IAscendLaunchpad.CurveStep[] storage curve, int24 startTick, int24 spacing, uint256 supply)
        internal
        view
    {
        int256 maxTick = TickMath.maxUsableTick(spacing);
        if (
            startTick % spacing != 0 || int256(startTick) - spacing < -maxTick
                || int256(startTick) + curve[curve.length - 1].offsetUpper > maxTick
        ) revert IAscendLaunchpad.BadQuoteConfig();

        uint128 maxLiquidity = maxLiquidityPerTick(spacing);
        uint128 previous0;
        uint128 previous1;
        int24 previousUpper;
        for (uint256 i; i < curve.length; i++) {
            IAscendLaunchpad.CurveStep memory s = curve[i];
            (,, uint128 liq0) = bandLiquidity(true, startTick, s, supply);
            (,, uint128 liq1) = bandLiquidity(false, startTick, s, supply);
            bool adjacent = i > 0 && s.offsetLower == previousUpper;
            if (
                liq0 == 0 || liq1 == 0 || uint256(liq0) + (adjacent ? previous0 : 0) > maxLiquidity
                    || uint256(liq1) + (adjacent ? previous1 : 0) > maxLiquidity
            ) revert IAscendLaunchpad.BadQuoteConfig();
            previous0 = liq0;
            previous1 = liq1;
            previousUpper = s.offsetUpper;
        }
    }
}
