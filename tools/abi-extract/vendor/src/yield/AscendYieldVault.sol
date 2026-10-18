// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
/// @notice Immutable, ownerless kHYPE principal vault with a fixed yield sink.
/// Consumers: wallet and /stake (deposit/redeem/position), fee executor (donate),
/// permissionless keepers (checkpoint/release), ceremony (identities and limits).
/// Organic yield funds manual graded ecosystem buybacks; donations stream into
/// principal over DONATION_VEST_SECONDS (review 2026-09-21; THREAT_MODEL SC-20).
contract AscendYieldVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant YIELD_SCALE = 1e9;
    uint256 internal constant MAX_YIELD_SHARES = 1e45;
    uint256 internal constant EPOCH_SECONDS = 7 days;
    /// @dev A donation vests linearly over this window. Before 2026-09-21 it
    /// landed in one block, so a deposit in the keeper's block that left the
    /// next took the whole donation pro rata (PoC: 900 kHYPE beside 100 took
    /// 90%). One epoch: capital must stand the release cadence to earn it.
    uint256 internal constant DONATION_VEST_SECONDS = 7 days;
    uint256 internal constant RATE_READ_GAS = 100_000;
    uint256 internal constant RATE_CALL_GAS_FLOOR = 210_000;

    struct Limits {
        uint256 maxPrincipalHype;
        uint256 maxEpochReleaseKHYPE;
        uint256 maxRateGrowthBpsPerYear;
        uint256 minDepositKHYPE;
        uint256 initialRateHeadroomBps;
    }

    struct AccountingState {
        uint256 accountedKHYPE;
        uint256 principalReserveKHYPE;
        uint256 yieldBackingKHYPE;
        uint256 unassignedKHYPE;
        uint256 totalPrincipalShares;
        uint256 principalIndex;
        uint256 totalYieldShares;
        uint256 principalGeneration;
        uint256 precisionQuarantinedKHYPE;
        /// @dev Donated kHYPE not yet credited to principal: part of
        /// accountedKHYPE (= reserve + yield backing + this), senior to yield,
        /// junior to the reserve. Appended so earlier tuple slots keep their
        /// positions for readers of `state()`.
        uint256 vestingDonationKHYPE;
        uint256 vestingEndsAt;
        uint256 vestingUpdatedAt;
    }

    struct Position {
        uint256 shares;
        uint256 generation;
    }

    struct PositionView {
        uint256 shares;
        uint256 principalHype;
        uint256 equivalentKHYPE;
        uint256 inKindKHYPE;
        uint256 rate;
        bool rateValid;
        uint256 depositedKHYPE;
        uint256 redeemedKHYPE;
    }

    IERC20 public immutable khype;
    address public immutable accountant;
    address public immutable yieldSink;
    uint256 public immutable rateAtDeployment;
    uint256 public immutable deployedAt;
    Limits public limits;
    AccountingState private _state;
    mapping(address => Position) private _positions;
    mapping(address => uint256) private depositedKHYPE;
    mapping(address => uint256) private redeemedKHYPE;
    uint256 private releaseEpoch;
    uint256 public epochReleasedKHYPE;

    error InvalidConfiguration();
    error InvalidRate();
    error InsufficientRateGas();
    error InvalidAmount();
    error MinimumNotMet();
    error PrincipalLimit();
    error TransferMismatch();

    uint256 public totalDonatedKHYPE;
    uint256 public totalReleasedKHYPE;

    event Checkpoint(uint256 rate, bool valid, AccountingState accounting);
    event Deposited(address indexed wallet, uint256 receivedKHYPE, uint256 principalCreditHype, uint256 shares, uint256 rate);
    event Redeemed(address indexed wallet, uint256 shares, uint256 liabilityReductionHype, uint256 paidKHYPE, bool inKind);
    event YieldDonated(address indexed from, uint256 amountKHYPE);
    event YieldReleased(uint256 amountKHYPE, uint256 burnedYieldShares, uint256 epoch);
    event RoundingQuarantined(uint256 amountKHYPE);

    constructor(address khype_, address accountant_, address yieldSink_, Limits memory limits_) {
        if (
            khype_.code.length == 0 || accountant_.code.length == 0 || yieldSink_.code.length == 0 || yieldSink_ == address(this) || yieldSink_ == khype_
                || IERC20Metadata(khype_).decimals() != 18
                || limits_.maxPrincipalHype == 0 || limits_.maxPrincipalHype > 1e36 || limits_.maxEpochReleaseKHYPE == 0
                || limits_.maxEpochReleaseKHYPE > 1e36 || limits_.minDepositKHYPE == 0
                || limits_.maxRateGrowthBpsPerYear == 0 || limits_.maxRateGrowthBpsPerYear > 10_000
                || limits_.initialRateHeadroomBps > 100
        ) revert InvalidConfiguration();
        khype = IERC20(khype_);
        accountant = accountant_;
        yieldSink = yieldSink_;
        limits = limits_;
        deployedAt = block.timestamp;
        (uint256 initial, bool ok) = _readRate();
        if (!ok || initial == 0 || initial > 1e36) revert InvalidRate();
        uint256 minimumValueHype = Math.mulDiv(limits_.minDepositKHYPE, initial, WAD);
        if (minimumValueHype == 0 || minimumValueHype > limits_.maxPrincipalHype) revert InvalidConfiguration();
        rateAtDeployment = initial;
        _state.principalIndex = RAY;
        _state.principalGeneration = 1;
    }

    /// @dev Fixed-size return buffer and gas ensure a failed dependency cannot
    /// allocate unbounded returndata. Low caller gas REVERTS, never selects an
    /// unvalued exit. The floor includes EIP-150 headroom and post-read work.
    function _readRate() private view returns (uint256 rate, bool ok) {
        if (gasleft() < RATE_CALL_GAS_FLOOR) revert InsufficientRateGas();
        address target = accountant;
        bytes memory input = abi.encodeWithSignature("kHYPEToHYPE(uint256)", WAD);
        assembly ("memory-safe") {
            let output := mload(0x40)
            ok := staticcall(RATE_READ_GAS, target, add(input, 32), mload(input), output, 32)
            ok := and(ok, eq(returndatasize(), 32))
            rate := mload(output)
        }
    }

    /// @notice Observed now; the accountant provides no last-update timestamp.
    function currentRate() public view returns (uint256 rate, bool valid) {
        (rate, valid) = _readRate();
        // Rewards arrive in batches that can include time before deployment.
        // The explicit initial allowance is capped at 1% and never resets;
        // checkpoints cannot ratchet the deployment-anchored envelope upward.
        uint256 ceiling = rateAtDeployment + Math.mulDiv(rateAtDeployment, limits.initialRateHeadroomBps, 10_000)
            + Math.mulDiv(
                rateAtDeployment, limits.maxRateGrowthBpsPerYear * (block.timestamp - deployedAt), 10_000 * 365 days
            );
        valid = valid && rate > 0 && rate <= ceiling && rate <= 1e36;
    }

    function state() external view returns (AccountingState memory) {
        return _state;
    }

    function principalLiabilityHype() external view returns (uint256) {
        return _liability(_state);
    }

    function _project() private view returns (AccountingState memory s, uint256 rate, bool valid) {
        (rate, valid) = currentRate();
        s = _projectState(_state, khype.balanceOf(address(this)), rate, valid, block.timestamp);
    }

    function _checkpoint(bool requireRate) private returns (uint256 rate, bool valid) {
        AccountingState memory s;
        (s, rate, valid) = _project();
        if (requireRate && !valid) revert InvalidRate();
        _state = s;
        emit Checkpoint(rate, valid, s);
    }

    function checkpoint() external nonReentrant {
        _checkpoint(true);
    }

    function _position(address wallet) private view returns (Position memory p) {
        p = _positions[wallet];
        if (p.generation != _state.principalGeneration) {
            p.shares = 0;
            p.generation = _state.principalGeneration;
        }
    }

    function previewDeposit(uint256 amount) external view returns (uint256 shares, uint256 rate, bool valid) {
        AccountingState memory s;
        (s, rate, valid) = _project();
        if (valid) shares = Math.mulDiv(Math.mulDiv(amount, rate, WAD), RAY, s.principalIndex);
    }

    function deposit(uint256 amount, uint256 minPrincipalShares)
        external
        nonReentrant
        returns (uint256 shares)
    {
        if (amount < limits.minDepositKHYPE) revert InvalidAmount();
        (uint256 rate,) = _checkpoint(true);
        Position memory p = _position(msg.sender);
        uint256 beforeBalance = khype.balanceOf(address(this));
        khype.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = khype.balanceOf(address(this)) - beforeBalance;
        if (received < limits.minDepositKHYPE || received > amount) revert TransferMismatch();
        uint256 credit = Math.mulDiv(received, rate, WAD);
        shares = Math.mulDiv(credit, RAY, _state.principalIndex);
        if (shares == 0 || shares < minPrincipalShares) revert MinimumNotMet();
        _state.totalPrincipalShares += shares;
        uint256 liability = _liability(_state);
        // The cap counts the unvested stream as if it had landed at today's rate.
        if (liability + Math.mulDiv(_state.vestingDonationKHYPE, rate, WAD) > limits.maxPrincipalHype) revert PrincipalLimit();
        uint256 reserve = _ceilDiv(liability, WAD, rate);
        uint256 addedReserve = reserve - _state.principalReserveKHYPE;
        if (addedReserve > received) revert TransferMismatch();
        _state.principalReserveKHYPE = reserve;
        _state.accountedKHYPE += addedReserve;
        _quarantine(received - addedReserve);
        p.shares += shares;
        _positions[msg.sender] = p;
        depositedKHYPE[msg.sender] += received;
        emit Deposited(msg.sender, received, credit, shares, rate);
    }

    function _quarantine(uint256 amount) private {
        if (amount == 0) return;
        _state.unassignedKHYPE += amount;
        emit RoundingQuarantined(amount);
    }

    function _payout(AccountingState memory s, uint256 shares, uint256 rate, bool valid)
        private
        pure
        returns (uint256)
    {
        if (shares == 0) return 0;
        return valid
            ? Math.mulDiv(Math.mulDiv(shares, s.principalIndex, RAY), WAD, rate)
            : Math.mulDiv(s.principalReserveKHYPE, shares, s.totalPrincipalShares);
    }

    function previewRedeem(address wallet, uint256 shares) external view returns (uint256 amountKHYPE, bool inKind) {
        (AccountingState memory s, uint256 rate, bool valid) = _project();
        Position memory p = _positions[wallet];
        if (p.generation != s.principalGeneration || shares > p.shares) return (0, !valid);
        return (_payout(s, shares, rate, valid), !valid);
    }

    function position(address wallet) external view returns (PositionView memory v) {
        (AccountingState memory s, uint256 rate, bool valid) = _project();
        Position memory p = _positions[wallet];
        uint256 shares = p.generation == s.principalGeneration ? p.shares : 0;
        v = PositionView({
            shares: shares,
            principalHype: Math.mulDiv(shares, s.principalIndex, RAY),
            equivalentKHYPE: valid ? _payout(s, shares, rate, true) : 0,
            inKindKHYPE: !valid ? _payout(s, shares, rate, false) : 0,
            rate: valid ? rate : 0,
            rateValid: valid,
            depositedKHYPE: depositedKHYPE[wallet],
            redeemedKHYPE: redeemedKHYPE[wallet]
        });
    }

    function redeem(uint256 shares, uint256 minKHYPEOut) external nonReentrant returns (uint256 paid) {
        (uint256 rate, bool valid) = _checkpoint(false);
        Position memory p = _position(msg.sender);
        if (shares == 0 || shares > p.shares) revert InvalidAmount();
        paid = _payout(_state, shares, rate, valid);
        if (paid < minKHYPEOut || (paid == 0 && shares != p.shares)) revert MinimumNotMet();
        uint256 oldLiability = _liability(_state);
        uint256 oldReserve = _state.principalReserveKHYPE;
        _state.totalPrincipalShares -= shares;
        uint256 liability = _liability(_state);
        uint256 reserve = valid ? _ceilDiv(liability, WAD, rate) : oldReserve - paid;
        uint256 released = oldReserve - reserve;
        _state.principalReserveKHYPE = reserve;
        _state.accountedKHYPE -= released;
        _quarantine(released - paid);
        p.shares -= shares;
        _positions[msg.sender] = p;
        if (_state.totalPrincipalShares == 0) {
            _state.principalIndex = RAY;
            ++_state.principalGeneration;
        }
        redeemedKHYPE[msg.sender] += paid;
        emit Redeemed(msg.sender, shares, oldLiability - liability, paid, !valid);
        if (paid != 0) {
            uint256 beforeBalance = khype.balanceOf(address(this));
            uint256 recipientBalance = khype.balanceOf(msg.sender);
            khype.safeTransfer(msg.sender, paid);
            if (
                beforeBalance - khype.balanceOf(address(this)) != paid
                    || khype.balanceOf(msg.sender) - recipientBalance != paid
            ) revert TransferMismatch();
        }
    }

    function releaseRemainingKHYPE() private view returns (uint256) {
        return limits.maxEpochReleaseKHYPE - (releaseEpoch == block.timestamp / EPOCH_SECONDS ? epochReleasedKHYPE : 0);
    }

    /// @notice The fee executor donates converted kHYPE to principal holders.
    /// Checkpoint excludes organic yield first. The amount then streams into
    /// the common principal index linearly over DONATION_VEST_SECONDS, applied
    /// by every later checkpoint: a deposit in this block that leaves the next
    /// earns none of it, and a holder earns exactly the share of each donation
    /// that vests while their shares stand. A new donation re-locks the unvested
    /// remainder over a fresh window. The cap is checked as if the whole stream
    /// had vested at today's rate. Nothing vests while no shares exist; the
    /// window restarts when they return (see _vest).
    function donate(uint256 amountKHYPE) external nonReentrant {
        (uint256 rate,) = _checkpoint(true);
        if (amountKHYPE == 0 || _state.totalPrincipalShares == 0) revert InvalidAmount();
        uint256 beforeBalance = khype.balanceOf(address(this));
        khype.safeTransferFrom(msg.sender, address(this), amountKHYPE);
        uint256 received = khype.balanceOf(address(this)) - beforeBalance;
        if (received == 0 || received > amountKHYPE) revert TransferMismatch();
        uint256 pending = _state.vestingDonationKHYPE + received;
        if (_liability(_state) + Math.mulDiv(pending, rate, WAD) > limits.maxPrincipalHype) revert PrincipalLimit();
        _state.vestingDonationKHYPE = pending;
        _state.accountedKHYPE += received;
        _state.vestingEndsAt = block.timestamp + DONATION_VEST_SECONDS;
        _state.vestingUpdatedAt = block.timestamp;
        totalDonatedKHYPE += received;
        emit YieldDonated(msg.sender, received);
    }

    /// @notice The donation stream: what is still unvested and when it ends.
    /// Consumer: /stake ("vesting to holders over the next N days").
    function vestingDonation() external view returns (uint256 unvestedKHYPE, uint256 endsAt) {
        (AccountingState memory s,,) = _project();
        return (s.vestingDonationKHYPE, s.vestingEndsAt);
    }

    /// @notice Release only surplus to immutable custody, including after all exits.
    function release(uint256 maxAmountKHYPE) external nonReentrant returns (uint256 amount) {
        _checkpoint(true);
        amount = Math.min(maxAmountKHYPE, Math.min(_state.yieldBackingKHYPE, releaseRemainingKHYPE()));
        if (amount == 0) return 0;
        uint256 burned = _ceilDiv(amount, _state.totalYieldShares, _state.yieldBackingKHYPE);
        _state.totalYieldShares -= burned;
        _state.yieldBackingKHYPE -= amount;
        _state.accountedKHYPE -= amount;
        if (_state.yieldBackingKHYPE == 0) {
            _state.totalYieldShares = 0;
        }
        uint256 epoch = block.timestamp / EPOCH_SECONDS;
        if (releaseEpoch != epoch) {
            releaseEpoch = epoch;
            epochReleasedKHYPE = 0;
        }
        epochReleasedKHYPE += amount;
        totalReleasedKHYPE += amount;
        uint256 beforeBalance = khype.balanceOf(address(this));
        uint256 destinationBalance = khype.balanceOf(yieldSink);
        khype.safeTransfer(yieldSink, amount);
        if (beforeBalance - khype.balanceOf(address(this)) != amount
            || khype.balanceOf(yieldSink) - destinationBalance != amount) revert TransferMismatch();
        emit YieldReleased(amount, burned, epoch);
    }

    function _ceilDiv(uint256 a, uint256 b, uint256 d) private pure returns (uint256) {
        return Math.mulDiv(a, b, d, Math.Rounding.Ceil);
    }

    function _liability(AccountingState memory s) private pure returns (uint256) {
        return _ceilDiv(s.totalPrincipalShares, s.principalIndex, RAY);
    }

    /// @dev Saturation preserves exits after repeated almost-total junior
    /// losses. A mathematically overflowing share quotient is capped before
    /// mulDiv can revert; it never authorizes additional spending.
    function _cappedMulDiv(uint256 x, uint256 y, uint256 d, uint256 cap) private pure returns (uint256) {
        uint256 high;
        assembly ("memory-safe") {
            let mm := mulmod(x, y, not(0))
            let low := mul(x, y)
            high := sub(sub(mm, low), lt(mm, low))
        }
        return high >= d ? cap : Math.min(Math.mulDiv(x, y, d), cap);
    }

    function _issueYield(AccountingState memory s, uint256 growth) private pure returns (uint256 assigned) {
        uint256 room = MAX_YIELD_SHARES - s.totalYieldShares;
        uint256 issued = s.totalYieldShares == 0
            ? Math.min(growth, room / YIELD_SCALE) * YIELD_SCALE
            : _cappedMulDiv(growth, s.totalYieldShares, s.yieldBackingKHYPE, room);
        // Precision saturation quarantines growth and never blocks redemption.
        if (issued == 0) return 0;
        assigned = s.totalYieldShares == 0
            ? _ceilDiv(issued, 1, YIELD_SCALE)
            : _ceilDiv(issued, s.yieldBackingKHYPE, s.totalYieldShares);
        s.totalYieldShares += issued;
    }

    function _wipePrincipal(AccountingState memory s) private pure {
        s.totalPrincipalShares = 0;
        s.principalIndex = RAY;
        ++s.principalGeneration;
    }

    function _projectState(AccountingState memory s, uint256 balance, uint256 rate, bool valid, uint256 nowTs)
        private
        pure
        returns (AccountingState memory)
    {
        // Unassigned tokens absorb a custody deficit first, then junior yield,
        // then the unvested donation stream; the principal reserve last.
        uint256 oldReserve = s.principalReserveKHYPE;
        if (balance >= s.accountedKHYPE) {
            s.unassignedKHYPE = balance - s.accountedKHYPE;
        } else {
            s.unassignedKHYPE = 0;
            s.accountedKHYPE = balance;
            s.principalReserveKHYPE = Math.min(oldReserve, balance);
            s.vestingDonationKHYPE = Math.min(s.vestingDonationKHYPE, balance - s.principalReserveKHYPE);
            s.yieldBackingKHYPE = balance - s.principalReserveKHYPE - s.vestingDonationKHYPE;
            if (s.yieldBackingKHYPE == 0) s.totalYieldShares = 0;
        }

        if (!valid) {
            // No fabricated current HYPE valuation. A token deficit nevertheless
            // permanently scales down the recorded principal claim.
            if (s.principalReserveKHYPE < oldReserve && s.totalPrincipalShares != 0) {
                s.principalIndex = Math.mulDiv(s.principalIndex, s.principalReserveKHYPE, oldReserve);
                if (s.principalIndex == 0) {
                    _wipePrincipal(s);
                    s.unassignedKHYPE += s.principalReserveKHYPE;
                    s.accountedKHYPE -= s.principalReserveKHYPE;
                    s.principalReserveKHYPE = 0;
                }
            }
            return s;
        }

        // The stream is not principal yet: value the books without it.
        uint256 backing = s.accountedKHYPE - s.vestingDonationKHYPE;
        uint256 value = Math.mulDiv(backing, rate, WAD);
        if (value < _liability(s)) {
            s.principalIndex = Math.mulDiv(value, RAY, s.totalPrincipalShares);
            if (s.principalIndex == 0) _wipePrincipal(s);
        }
        uint256 reserve = _ceilDiv(_liability(s), WAD, rate);
        uint256 nextYield = backing - reserve;
        if (nextYield > s.yieldBackingKHYPE) {
            uint256 growth = nextYield - s.yieldBackingKHYPE;
            if (s.totalPrincipalShares == 0) {
                // Last-share/wipe rounding is not a new depositor's windfall.
                s.unassignedKHYPE += growth;
                s.accountedKHYPE -= growth;
                nextYield -= growth;
            } else {
                uint256 unrepresented = growth - _issueYield(s, growth);
                s.unassignedKHYPE += unrepresented;
                s.precisionQuarantinedKHYPE += unrepresented;
                s.accountedKHYPE -= unrepresented;
                nextYield -= unrepresented;
            }
        }
        s.principalReserveKHYPE = reserve;
        s.yieldBackingKHYPE = nextYield;
        if (nextYield == 0) s.totalYieldShares = 0;
        _vest(s, rate, nowTs);
        return s;
    }

    /// @dev Move the vested part of the donation stream into principal at
    /// today's rate. Runs after the reserve is current, so the reserve it adds
    /// never exceeds the kHYPE it moves (the deposit lemma); the wei the index
    /// cannot represent are quarantined like a deposit's, never handed to yield.
    function _vest(AccountingState memory s, uint256 rate, uint256 nowTs) private pure {
        uint256 locked = s.vestingDonationKHYPE;
        if (locked == 0) return;
        if (s.totalPrincipalShares == 0) {
            // Nobody to credit: the window restarts for whoever comes next, so a
            // lapsed stream is never one block's windfall.
            s.vestingUpdatedAt = nowTs;
            s.vestingEndsAt = nowTs + DONATION_VEST_SECONDS;
            return;
        }
        if (nowTs <= s.vestingUpdatedAt) return;
        uint256 unlocked = nowTs >= s.vestingEndsAt
            ? locked
            : Math.mulDiv(locked, nowTs - s.vestingUpdatedAt, s.vestingEndsAt - s.vestingUpdatedAt);
        s.vestingUpdatedAt = nowTs;
        if (unlocked == 0) return;
        s.vestingDonationKHYPE = locked - unlocked;
        s.principalIndex += Math.mulDiv(Math.mulDiv(unlocked, rate, WAD), RAY, s.totalPrincipalShares);
        uint256 reserve = _ceilDiv(_liability(s), WAD, rate);
        uint256 dust = unlocked - (reserve - s.principalReserveKHYPE);
        s.principalReserveKHYPE = reserve;
        s.unassignedKHYPE += dust;
        s.accountedKHYPE -= dust;
    }
}
