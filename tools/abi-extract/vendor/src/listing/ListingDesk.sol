// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PoolId, PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solmate/src/utils/ReentrancyGuard.sol";
import {IAscendLaunchpad} from "../interfaces/IAscendLaunchpad.sol";
import {LaunchpadKey} from "../libraries/LaunchpadKey.sol";
import {Treasury} from "../Treasury.sol";

/// @dev The launchpad surface the desk drives. The desk is the launchpad's
/// constructor child, so this is its parent; nothing else may call the two
/// listing setters (the launchpad checks `msg.sender == listingDesk`).
interface IListingLaunchpad is IAscendLaunchpad {
    function owner() external view returns (address);
    function listingDesk() external view returns (ListingDesk);
    function setListing(PoolId poolId, address creator, uint256 cap) external;
    function takeListing(PoolId poolId, address to, uint256 amount) external;
    function routeCoreFees(PoolId poolId, uint256 amount) external;
}

/// @notice Core listing, paid on delivery (DESIGN_core-listing-desk.md). The
/// protocol is the only lister and the HyperCore deployer: it pays the auction,
/// runs the deploy actions with its own key, and is reimbursed here from the
/// creator's optional set-aside only after a HyperEVM contract has read the
/// finished listing from HyperCore and relayed that fact in a retryable ticket.
/// Creator money never leaves Elysium before delivery and never reaches an
/// operator wallet.
///
/// Per pool: the creator role may set aside 20% of its quote fees (the
/// launchpad carves them at collect, `listingElection`) up to a cap; the set-aside
/// stays on the launchpad until paid. The owner may lock part of it for
/// COMMIT_WINDOW; verified delivery pays the locked amount to `listingTreasury`,
/// records the canonical Core listing and ends the election. Unlocked funds
/// belong to the pool's creator role, like every other creator balance on the
/// launchpad (they follow the role through a handoff). After a listing, the
/// deployer's Core trading fees come back here in the token and are split 50/50:
/// half to the creator role, half through the launchpad's five fee legs, like
/// every other token-side protocol fee.
///
/// Consumers: the creator panel (enroll/close/withdraw), the protocol's listing
/// runbook (register/commit), CoreListingVerifier's retryable (onDelivered),
/// the fee-return keeper (splitCoreFees), the indexer and the token page.
contract ListingDesk is ReentrancyGuard {
    using SafeTransferLib for ERC20;
    using PoolIdLibrary for PoolKey;

    /// @notice How long a commitment locks the set-aside before anyone can lapse it.
    uint256 public constant COMMIT_WINDOW = 7 days;
    /// @notice The creator's share of the Core deployer fees returned here.
    uint256 public constant CORE_FEE_CREATOR_BPS = 5_000;
    /// @dev Arbitrum's parent-to-child alias: a HyperEVM contract's retryable
    /// executes on Elysium from its address plus this offset (wrapping).
    uint160 private constant ALIAS_OFFSET = uint160(0x1111000000000000000000000000000000001111);

    IListingLaunchpad public immutable launchpad;
    /// @notice CoreListingVerifier on HyperEVM; zero disables delivery.
    address public immutable verifier;
    /// @notice The only sender `onDelivered` accepts: the verifier's alias.
    address public immutable verifierAlias;
    /// @notice Reimbursements for delivered listings; owner-swept to replenish
    /// the HYPE that paid the auctions.
    Treasury public immutable listingTreasury;
    /// @notice The gas a checkpoint must still hold when it reaches `collect`
    /// (AscendCtoReceiver's per-curve allowance, set by the launchpad), so a
    /// caller cannot skip a healthy checkpoint by starving it.
    uint256 public immutable collectGasFloor;
    /// @notice The desk's own work around a delivery's checkpoint (the registry
    /// lookup, the stop, the payment, the log), with margin.
    uint256 public constant DELIVERY_GAS_OVERHEAD = 300_000;

    struct Pool {
        address token;
        uint40 committedUntil;
        uint40 listedAt; // canonical Core listing delivered; 0 = none
        uint32 coreIndex;
        uint32 spotIndex;
        uint256 locked; // part of launchpad.listingOwed committed to delivery
    }

    mapping(PoolId => Pool) private _pools;
    /// @notice The pool of a registered launched token. Consumers: onDelivered,
    /// splitCoreFees, the token page's listing lookup.
    mapping(address => PoolId) public poolOf;

    error Refused();
    error UnknownPool();
    error Unauthorized();
    error InsufficientCollectGas();

    event Registered(address indexed token, PoolId indexed poolId, address quote);
    event Enrolled(PoolId indexed poolId, address indexed creator, uint256 cap);
    event Closed(PoolId indexed poolId, address indexed by);
    event Committed(PoolId indexed poolId, uint256 amount, uint40 until);
    event Lapsed(PoolId indexed poolId, uint256 released);
    event Withdrawn(PoolId indexed poolId, address indexed to, uint256 amount);
    event Delivered(PoolId indexed poolId, address indexed token, uint32 coreIndex, uint32 spotIndex, uint256 paid);
    event CoreFeesSplit(PoolId indexed poolId, address indexed token, address indexed creator, uint256 toCreator, uint256 toProtocol);

    constructor(address owner_, address verifier_, uint256 collectGasFloor_) {
        collectGasFloor = collectGasFloor_;
        launchpad = IListingLaunchpad(msg.sender);
        verifier = verifier_;
        unchecked {
            verifierAlias = verifier_ == address(0) ? address(0) : address(uint160(verifier_) + ALIAS_OFFSET);
        }
        listingTreasury = new Treasury(owner_);
    }

    // ------------------------------------------------------------------ views

    function pool(PoolId poolId) external view returns (Pool memory) {
        return _pools[poolId];
    }

    /// @notice The least gasLimit a delivery retryable must carry. Below it the
    /// checkpoint refuses and the ticket waits for a manual redeem with more gas
    /// (CL-6). Read it before `CoreListingVerifier.prove`, which takes it as a
    /// parameter; `test/CoreListingEndToEnd.t.sol` executes a ticket at exactly
    /// this gas.
    function deliveryGasFloor() external view returns (uint256) {
        return collectGasFloor + DELIVERY_GAS_OVERHEAD;
    }

    // ------------------------------------------------------------- the creator

    /// @notice Bind a launched token to its pool. Permissionless: the pool id
    /// is derived from the pair and checked against the launchpad.
    function register(address token, address quote) public returns (PoolId poolId) {
        poolId = LaunchpadKey.keyOf(token, quote, address(launchpad), address(launchpad.poolManager())).toId();
        if (launchpad.poolLaunchedAt(poolId) == 0 || launchpad.poolTokenIs0(poolId) != (token < quote)) revert UnknownPool();
        Pool storage p = _pools[poolId];
        if (p.token == address(0)) {
            p.token = token;
            poolOf[token] = poolId;
            emit Registered(token, poolId, quote);
        }
    }

    /// @notice The creator role sets aside 20% of its future quote fees, up to
    /// `cap` more quote wei, toward this token's Core listing. Enrolling again
    /// resets the cap. Fees earned before this call stay entirely the
    /// creator's: the pool is collected first, and a failed collect refuses.
    function enroll(address token, address quote, uint256 cap) external nonReentrant {
        PoolId poolId = register(token, quote);
        address creator = launchpad.poolCreator(poolId);
        if (msg.sender != creator || cap == 0 || cap > type(uint88).max || _pools[poolId].listedAt != 0) revert Refused();
        launchpad.collect(poolId);
        launchpad.setListing(poolId, creator, cap);
        emit Enrolled(poolId, creator, cap);
    }

    /// @notice The creator role stops setting aside. A handoff clears the
    /// election in the launchpad.
    /// A frozen quote may prevent the checkpoint but cannot prevent closing.
    function close(PoolId poolId) external nonReentrant {
        uint256 e = launchpad.listingElection(poolId);
        if (e == 0) revert Refused();
        address creator = launchpad.poolCreator(poolId);
        if (msg.sender != creator) revert Unauthorized();
        _stop(poolId);
        emit Closed(poolId, msg.sender);
    }

    /// @notice Pay the creator role unlocked funds once it no longer sets aside.
    /// Anyone may trigger it; the funds only ever go to the current creator role.
    function withdraw(PoolId poolId, uint256 amount) external nonReentrant {
        Pool storage p = _pools[poolId];
        if (_live(poolId) || amount == 0 || amount > launchpad.listingOwed(poolId) - p.locked) revert Refused();
        address creator = launchpad.poolCreator(poolId);
        launchpad.takeListing(poolId, creator, amount);
        emit Withdrawn(poolId, creator, amount);
    }

    // ------------------------------------------------------------ the protocol

    /// @notice The owner commits to list the pool's token and locks `amount`
    /// of its set-aside as the payment on delivery, for COMMIT_WINDOW. Only a
    /// live election can be committed; the creator may still close it (future
    /// fees stop), but the locked amount stays until delivery or lapse.
    function commit(PoolId poolId, uint256 amount) external nonReentrant {
        if (msg.sender != launchpad.owner()) revert Unauthorized();
        Pool storage p = _pools[poolId];
        if (!_live(poolId) || p.listedAt != 0 || p.locked != 0) revert Refused();
        _checkpoint(poolId);
        if (amount == 0 || amount > launchpad.listingOwed(poolId)) revert Refused();
        p.locked = amount;
        p.committedUntil = uint40(block.timestamp + COMMIT_WINDOW);
        emit Committed(poolId, amount, p.committedUntil);
    }

    /// @notice An undelivered commitment past its window releases. Anyone. A
    /// delivery that lands before this call still pays (late success settles).
    function lapse(PoolId poolId) external {
        Pool storage p = _pools[poolId];
        if (p.locked == 0 || p.listedAt != 0 || block.timestamp <= p.committedUntil) revert Refused();
        uint256 released = p.locked;
        p.locked = 0;
        p.committedUntil = 0;
        emit Lapsed(poolId, released);
    }

    /// @notice Verified delivery from HyperEVM: the protocol's Core listing of
    /// `token` passed CoreListingVerifier. The first delivery is the canonical
    /// listing; later ones are no-ops so a duplicate ticket cannot fail forever.
    /// An unregistered token reverts, and its ticket can be redeemed after
    /// `register`.
    function onDelivered(address token, uint32 coreIndex, uint32 spotIndex) external nonReentrant {
        if (verifierAlias == address(0) || msg.sender != verifierAlias) revert Unauthorized();
        PoolId poolId = poolOf[token];
        Pool storage p = _pools[poolId];
        if (p.token == address(0)) revert UnknownPool();
        if (p.listedAt != 0) return;
        p.listedAt = uint40(block.timestamp);
        p.coreIndex = coreIndex;
        p.spotIndex = spotIndex;
        if (launchpad.listingElection(poolId) != 0) _stop(poolId);
        uint256 paid = p.locked;
        if (paid != 0) {
            p.locked = 0;
            p.committedUntil = 0;
            launchpad.takeListing(poolId, address(listingTreasury), paid);
        }
        emit Delivered(poolId, token, coreIndex, spotIndex, paid);
    }

    /// @notice Split the Core deployer fees returned here in `token`: half to
    /// the pool's creator role, half through the launchpad's fee legs
    /// (`routeCoreFees`). Anyone. The desk holds launched tokens for no other reason.
    function splitCoreFees(address token) external nonReentrant {
        PoolId poolId = poolOf[token];
        if (_pools[poolId].listedAt == 0) revert Refused();
        uint256 amount = ERC20(token).balanceOf(address(this));
        if (amount == 0) revert Refused();
        uint256 toCreator = amount * CORE_FEE_CREATOR_BPS / 10_000;
        uint256 toProtocol = amount - toCreator;
        address creator = launchpad.poolCreator(poolId);
        if (toCreator != 0) ERC20(token).safeTransfer(creator, toCreator);
        ERC20(token).safeTransfer(address(launchpad), toProtocol);
        launchpad.routeCoreFees(poolId, toProtocol);
        emit CoreFeesSplit(poolId, token, creator, toCreator, toProtocol);
    }

    // --------------------------------------------------------------- internals

    function _live(PoolId poolId) private view returns (bool) {
        uint256 e = launchpad.listingElection(poolId);
        return e != 0 && address(uint160(e)) == launchpad.poolCreator(poolId);
    }

    /// @dev Checkpoint fees and end the election; custody stays on the launchpad.
    function _stop(PoolId poolId) private {
        _checkpoint(poolId);
        launchpad.setListing(poolId, address(0), 0);
    }

    /// @dev Use the same per-curve gas allowance as AscendCtoReceiver. A caller
    /// must fund the attempt even when a frozen quote makes it revert.
    function _checkpoint(PoolId poolId) private {
        if (gasleft() < collectGasFloor) revert InsufficientCollectGas();
        try launchpad.collect(poolId) {} catch {}
    }

}
