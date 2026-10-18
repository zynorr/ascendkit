// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICLHooks} from "infinity-core/src/pool-cl/interfaces/ICLHooks.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {ILockCallback} from "infinity-core/src/interfaces/ILockCallback.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {BalanceDelta} from "infinity-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "infinity-core/src/types/BeforeSwapDelta.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

import {TickMath} from "./vendor/v4-math/TickMath.sol";
import {FullMath} from "./vendor/v4-math/FullMath.sol";
import {FixedPoint96} from "./vendor/v4-math/FixedPoint96.sol";
import {AscendToken} from "./AscendToken.sol";
import {VaultPay} from "./libraries/VaultPay.sol";
import {LaunchCurve} from "./libraries/LaunchCurve.sol";
import {LaunchpadKey, TICK_SPACING, HOOK_BITMAP, OVERRIDE_FEE_FLAG, MAX_LP_FEE} from "./libraries/LaunchpadKey.sol";
import {TwoStepOwned} from "./base/TwoStepOwned.sol";
import {IAscendLaunchpad} from "./interfaces/IAscendLaunchpad.sol";
import {StakingFeeTreasury, StakingFeeConverter} from "./yield/StakingFeeConverter.sol";
import {Treasury} from "./Treasury.sol";
import {ListingDesk} from "./listing/ListingDesk.sol";

// The protocol constants nothing on chain reads through a getter — file-level,
// so the suites, `LaunchParams.toJson` and the shared mirror (`packages/shared`,
// asserted against this file's AST on every `npm run check`) import the one
// value the contract inlines. A `public constant` is an ABI promise plus a
// getter (~35 B each); the four split shares in the contract keep theirs for
// the indexer's every-tick probe (THREAT_MODEL IX-2).
uint256 constant TOTAL_SUPPLY = 1_000_000_000e18;
// TICK_SPACING and the pool's fee flags live in libraries/LaunchpadKey.sol, beside the key they shape.
uint24 constant BASE_FEE = 10_000; // 1% for the life of the pool once the launch window ends
uint24 constant START_FEE = 900_000; // 90% sniper tax at t=0 (was 50% over 7s until 2026-09-03 — CG-3)…
uint256 constant FEE_DECAY_SECONDS = 5; // …decaying linearly to the base fee, for life (F1 rescinded 2026-08-29)
uint256 constant EMA_TAU = 600;
uint256 constant EMA_MAX_DT = 600; // caps post-quiet single-update weight at 50%
/// @dev The fill's price band, in bps of price: spot must sit within this
/// of the STORED EMA or no fill happens at all. Same band the recycler used
/// (THREAT_MODEL SC-3) and for the same reason — a price that has stood for
/// 0 s moves the EMA by nothing, so an unobserved pump cannot make us pay
/// for it. Outside the band we simply do not fill and the AMM takes the
/// whole swap: fail open, never revert.
uint256 constant FILL_BAND_BPS = 500; // 5%
/// @dev Per-pool ceiling on quote spent filling, per FILL_WINDOW: the
/// quote's `maxClip` snapshotted at launch. This is the recycler's clip cap doing the same job
/// in a new place. Without it an attacker who has patiently converged the
/// EMA drains a pool's whole inventory in ONE transaction instead of one
/// clip per window — strictly worse than the crank it replaces.
uint256 constant FILL_WINDOW = 10 minutes;
/// @notice Immutable factory, PancakeSwap Infinity hook, position owner and fee
/// collector. The hook registration (`HOOK_BITMAP`, carried in every pool
/// key's `parameters`) enables initialization/liquidity gates and pre-swap
/// accounting. External creation and liquidity additions are refused; Infinity
/// skips callbacks when the hook is the caller (`Hooks.shouldCall`), so this
/// hook's own initialization, seed, collection and fee-exempt atomic dev-buy run
/// without them.
/// No function removes principal. Trading charges the lifecycle fee and may fill
/// exact-input sells from the pool's bid, subject to its fixed cap and EMA band.
/// The creator alone can hand off the fee role. Owner powers affect future launches
/// and the separate treasury balances, never live pools or their accrued claims.
contract AscendLaunchpad is TwoStepOwned, IAscendLaunchpad, ILockCallback {
    using PoolIdLibrary for PoolKey;
    using VaultPay for IVault;
    using SafeTransferLib for ERC20;

    error NotPoolManager();
    ICLPoolManager public immutable override poolManager;
    IVault public immutable override vault;

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    // ---------------------------------------------------------------- constants

    // Public: the indexer re-probes these fee and reserve constants from the chain every tick and
    // refuses to run if they differ from its mirror (THREAT_MODEL IX-2).
    uint256 public constant CREATOR_BPS = 5_000; // 50% of fees to the creator
    uint256 public constant ECO_BPS = 1_500; // 15% graded ecosystem buybacks
    uint256 public constant TREASURY_BPS = 2_000; // 20% HYPE bought and staked on Ascend
    /// @dev Share of net purchased tokens reserved for later cohort distribution; excludes fees.
    uint256 public constant STAKERS_BPS = 2_000;
    uint256 public constant STAKER_YIELD_BPS = 500; // 5% extra yield donated to stakers
    uint256 public constant KNTQ_BPS = 5_000; // 50% KNTQ purchases
    uint256 public constant OPEX_BPS = 1_000; // 10% operations, including rounding remainder

    uint8 private constant OP_SEED = 1;
    uint8 private constant OP_COLLECT = 2;
    /// @dev The largest amount a BeforeSwapDelta can carry (int128), and the
    /// bound the fill holds every amount to before any price arithmetic.
    uint256 private constant MAX_DELTA = uint256(uint128(type(int128).max));

    // ---------------------------------------------------------------- immutables

    Treasury public immutable treasury;
    Treasury public immutable opexTreasury;
    /// @dev Fixed custody for the distributor's graded ecosystem budget.
    /// Selection, conversion and bid funding happen outside swaps and collection.
    Treasury public immutable ecosystemTreasury;
    /// @dev Received assets awaiting manual conversion and vault donation.
    Treasury public immutable stakerYieldTreasury;
    /// @dev Received assets awaiting manual KNTQ purchases.
    Treasury public immutable kntqTreasury;
    /// @dev Owner-controlled custody for the net purchased-token reserve.
    Treasury public immutable cohortTreasury;
    /// @notice Unallocated protocol inventory for later listing, distribution or
    /// treasury-funded liquidity. Separate from fees, reserve and creator claims.
    /// The protocol owner chooses recipients and amounts through Treasury.sweep;
    /// custody is not a funded user entitlement or proof of native listing.
    Treasury public immutable inventoryTreasury;
    /// @notice Core listing, paid on delivery: the creator's optional quote
    /// set-aside, the owner's commitments, verified delivery and Core fee
    /// returns (DESIGN_core-listing-desk.md). The only caller of the two
    /// listing setters below.
    ListingDesk public immutable listingDesk;
    /// @dev The top band's far edge, in canonical ticks above startTick — the
    /// ceiling of every pool's curve, kept here so `_curveBounds` costs no
    /// storage read on the swap path.
    int24 private immutable _curveTop;

    // ---------------------------------------------------------------- storage

    // CurveStep lives on IAscendLaunchpad (inherited here, so bare `CurveStep`
    // resolves; its qualified name is `IAscendLaunchpad.CurveStep`): `curve()`
    // is part of the published surface, and a published getter whose return
    // type is declared on the implementation forces every reader to import the
    // implementation.

    struct PoolData {
        AscendToken token;
        address quote;
        address creator;
        bool tokenIs0;
        uint40 launchedAt;
        int24 startTick;
        uint160 emaSqrtPriceX96;
        uint40 emaUpdatedAt;
    }

    /// @dev An explicitly funded bid, held here because the
    /// fill settles it from THIS contract's balance inside the swap. `inventory`
    /// is what is left to spend on `poolId`; the window pair is the rate limit.
    /// The window pair has no getter: it is exact off-chain from `Filled` logs
    /// (each carries `quotePaid`; the window is FILL_WINDOW), and the one it had
    /// was read by nothing but the suites (removed 2026-09-03).
    struct Bid {
        uint256 inventory;
        uint256 filledInWindow;
        uint40 windowStart;
        uint128 maxClip;
    }

    CurveStep[] private _curve;
    mapping(PoolId => Bid) private _bid;
    mapping(address => QuoteConfig) private _quoteConfig;
    mapping(PoolId => PoolData) private _pools;
    mapping(PoolId => uint256) public creatorOwedToken;
    mapping(PoolId => uint256) public creatorOwedQuote;
    /// @notice A creator handoff in flight: the wallet `transferCreator` named,
    /// which completes it with `acceptCreator`; address(0) when none. Its own
    /// mapping rather than a PoolData field — PoolData's four slots have no
    /// room for an address, and a fifth slot would put a cold read on the
    /// fill's hot path for every sell. Consumers: the web's creator panel (the
    /// accept button lands with the right wallet), the indexer's
    /// `pool_stats.pending_creator`.
    mapping(PoolId => address) public pendingCreator;
    /// @notice A pool's Core-listing election, packed: the creator role that
    /// enrolled (low 160 bits) | the carry below one unit (8) | the cap left in
    /// quote wei (88). Zero when not enrolled. Written by the desk; read once per
    /// collect. Consumers: collect, the desk, the creator panel.
    mapping(PoolId => uint256) public listingElection;
    /// @notice Unspent quote set aside for a Core listing, held here until the
    /// desk authorizes a creator withdrawal or a verified delivery payment.
    mapping(PoolId => uint256) public listingOwed;
    bool public paused;
    /// @notice USDC on this chain. Verify, StackChecks and the web read this identity.
    address public immutable baseQuote;

    // ---------------------------------------------------------------- construction

    constructor(
        ICLPoolManager poolManager_,
        address owner_,
        CurveStep[] memory curve_,
        address baseQuote_,
        QuoteConfig memory baseConfig,
        address[2] memory feeConverters_,
        address listingVerifier_
    )
        TwoStepOwned(owner_)
    {
        poolManager = poolManager_;
        vault = poolManager_.vault();
        _curveTop = LaunchCurve.validateShape(curve_, TICK_SPACING);
        _curve = curve_;

        StakingFeeConverter stakeConverter = StakingFeeConverter(payable(feeConverters_[0]));
        StakingFeeConverter yieldConverter = StakingFeeConverter(payable(feeConverters_[1]));
        if (stakeConverter.extraYield() || !yieldConverter.extraYield()
            || address(stakeConverter.vault()) != address(yieldConverter.vault())) revert BadQuoteConfig();
        treasury = new StakingFeeTreasury(owner_, stakeConverter);
        opexTreasury = new Treasury(owner_);
        ecosystemTreasury = new Treasury(owner_);
        stakerYieldTreasury = new StakingFeeTreasury(owner_, yieldConverter);
        kntqTreasury = new Treasury(owner_);
        cohortTreasury = new Treasury(owner_);
        inventoryTreasury = new Treasury(owner_);
        listingDesk = new ListingDesk(owner_, listingVerifier_, 500_000 + 100_000 * curve_.length);

        // The default pair is an explicitly configured ERC-20; native HYPE is gas.
        if (baseQuote_ == address(0) || !baseConfig.allowed) revert BadQuoteConfig();
        baseQuote = baseQuote_;
        _setQuoteConfig(baseQuote_, baseConfig);
    }

    // The hook registration is `HOOK_BITMAP` (0x0445): beforeInitialize
    // and beforeAddLiquidity (the lock, SC-9 — a position that can never be added
    // needs no beforeRemoveLiquidity; the launchpad's own are removed by no code
    // path), beforeSwap and its return delta (the internal fill). afterSwap stays
    // OFF and is not needed: CLPoolManager.swap calls CLHooks.afterSwap
    // unconditionally and it folds the beforeSwap delta into the hook's own
    // balance delta whether or not the afterSwap bit is set (infinity-core
    // pool-cl/libraries/CLHooks.sol, afterSwap) — so the swap path gains a return
    // value, not a second callback.

    // ---------------------------------------------------------------- launch

    // LaunchParams lives on IAscendLaunchpad beside CurveStep and QuoteConfig
    // (`IAscendLaunchpad.LaunchParams` is its one name — a struct declared on
    // a base is not reachable through the derived contract's name): launch()
    // is on the interface, so a contract launching on a user's behalf (CG-1)
    // binds to that file, not to this one.

    /// @dev The one payload every lock carries — encoded once, decoded once.
    /// `op` picks the callback; the pool fields serve both; the dev-buy fields
    /// are read by the seed only (a collect sends them zeroed).
    struct LockData {
        uint8 op; // OP_SEED | OP_COLLECT
        PoolKey key;
        bool tokenIs0;
        int24 startTick;
        uint256 devBuyQuote; // seed only
        address devBuyRecipient; // seed only
    }

    function launch(LaunchParams calldata p) external returns (address tokenAddr, PoolId poolId) {
        if (paused) revert LaunchesArePaused();
        // A zero creator would strand the pool's fee share forever: claim()
        // pays p.creator and nothing can rotate a role nobody holds.
        if (p.creator == address(0)) revert ZeroCreator();
        QuoteConfig memory qc = _quoteConfig[p.quote];
        if (!qc.allowed) revert QuoteNotAllowed();

        // Keyed on the SENDER, not the creator role: the token address stays a
        // function of who called, so a third party cannot pre-grief a
        // creator's chosen salt by launching under their name first.
        AscendToken token =
            new AscendToken{salt: keccak256(abi.encode(msg.sender, p.salt))}(p.name, p.symbol, TOTAL_SUPPLY);
        tokenAddr = address(token);
        bool tokenIs0 = tokenAddr < p.quote;

        PoolKey memory key = _keyOf(tokenAddr, p.quote);

        // Start one spacing outside the first band so every band is purely
        // single-sided token liquidity (canonical space: price rises through the
        // curve; pool space mirrors when the token sorts as currency1).
        int24 startPoolTick = tokenIs0 ? qc.startTick - TICK_SPACING : -qc.startTick + TICK_SPACING;
        uint160 startSqrt = TickMath.getSqrtPriceAtTick(startPoolTick);

        // Infinity skips every hook callback when the hook is the caller
        // (Hooks.shouldCall: `address(hook) != msg.sender`), so beforeInitialize
        // never runs for our own launches — the gate exists for everyone else
        // (test_hostile_pool_init_blocked); our key is built above.
        poolManager.initialize(key, startSqrt);
        poolId = key.toId();

        _pools[poolId] = PoolData({
            token: token,
            quote: p.quote,
            creator: p.creator,
            tokenIs0: tokenIs0,
            launchedAt: uint40(block.timestamp),
            startTick: qc.startTick,
            emaSqrtPriceX96: startSqrt,
            emaUpdatedAt: uint40(block.timestamp)
        });
        _bid[poolId].maxClip = qc.maxClip;

        // Pull the quote from the payer; the named creator receives the tokens.
        if (p.devBuyQuote > 0) ERC20(p.quote).safeTransferFrom(msg.sender, address(this), p.devBuyQuote);

        bytes memory result = vault.lock(
            abi.encode(
                LockData({
                    op: OP_SEED,
                    key: key,
                    tokenIs0: tokenIs0,
                    startTick: qc.startTick,
                    devBuyQuote: p.devBuyQuote,
                    // The tokens land with the ROLE: a bot launching for a user
                    // must not end up holding the user's dev-buy (CG-1).
                    devBuyRecipient: p.creator
                })
            )
        );
        (uint256 devTokensOut, uint256 devQuoteSpent) = abi.decode(result, (uint256, uint256));
        if (devTokensOut < p.minDevOut) revert DevBuySlippage();

        // The pool's STORED dynamic fee. Infinity initialises a dynamic-fee pool
        // at lpFee 0 and only its hook may change it (updateDynamicLPFee); no
        // routed swap ever reads it, because beforeSwap returns the lifecycle
        // fee as an override — but it IS the fee a state-reading integrator
        // sees (an aggregator quoting off getSlot0, an analytics table), and
        // 0 reads as a fee-free pool: a quote short by the whole fee that then
        // fails its own slippage check on-chain. So mirror the steady-state fee
        // into storage, and do it AFTER the dev-buy above — which is fee-exempt
        // precisely because Infinity skips the hook for the hook's own swap and
        // charges the stored fee instead (still 0 at that moment).
        poolManager.updateDynamicLPFee(key, BASE_FEE);

        // Keep the rounding remainder in protocol inventory. Supply is constant.
        uint256 residual = token.balanceOf(address(this));
        if (residual > 0) {
            ERC20(tokenAddr).safeTransfer(address(inventoryTreasury), residual);
            emit TokensAccumulated(poolId, tokenAddr, InventorySource.Seed, residual);
        }

        emit Launched(poolId, tokenAddr, p.creator, p.quote, TOTAL_SUPPLY - residual - devTokensOut, devTokensOut);

        // Partial dev-buy fill (the curve ran out): refund the PAYER — the
        // quote was theirs, whoever the role names — and refund LAST.
        if (p.devBuyQuote > devQuoteSpent) {
            ERC20(p.quote).safeTransfer(msg.sender, p.devBuyQuote - devQuoteSpent);
        }
    }

    // ---------------------------------------------------------------- collect & claim

    /// @notice Contribute this pool's original token inventory. Consumers: the
    /// community vault and explicit donations. Contributions confer no claim.
    function accumulate(PoolId poolId, uint256 amount) external {
        PoolData storage p = _pools[poolId];
        if (p.launchedAt == 0) revert UnknownPool();
        ERC20(address(p.token)).safeTransferFrom(msg.sender, address(inventoryTreasury), amount);
        emit TokensAccumulated(poolId, address(p.token), InventorySource.Contribution, amount);
    }

    /// @notice Harvest locked-position fees and split creator/protocol shares.
    /// Every protocol fee asset goes to the four fixed fee-budget treasuries.
    /// Permissionless and unpaid. Consumers: creator claim flows and the operator
    /// crank for idle pools (E19). Returns the flywheel's quote share.
    function collect(PoolId poolId) external returns (uint256 flywheelQuote) {
        PoolData storage p = _pools[poolId];
        if (p.launchedAt == 0) revert UnknownPool();

        bytes memory result = vault.lock(
            abi.encode(
                LockData({
                    op: OP_COLLECT,
                    key: _keyOf(address(p.token), p.quote),
                    tokenIs0: p.tokenIs0,
                    startTick: p.startTick,
                    devBuyQuote: 0,
                    devBuyRecipient: address(0)
                })
            )
        );
        (uint256 fees0, uint256 fees1) = abi.decode(result, (uint256, uint256));
        (uint256 tokenFees, uint256 quoteFees) = p.tokenIs0 ? (fees0, fees1) : (fees1, fees0);

        uint256 creatorT = (tokenFees * CREATOR_BPS) / 10_000;
        uint256 creatorQ = (quoteFees * CREATOR_BPS) / 10_000;
        creatorOwedToken[poolId] += creatorT;
        creatorOwedQuote[poolId] += creatorQ - _setAside(poolId, p.creator, creatorQ);

        uint256 flywheelToken = tokenFees - creatorT;
        flywheelQuote = quoteFees - creatorQ;

        _routeProtocolFees(poolId, address(p.token), flywheelToken);
        _routeProtocolFees(poolId, p.quote, flywheelQuote);

        emit Collected(poolId, tokenFees, quoteFees, 0, flywheelQuote);
    }

    /// @dev The Core-listing set-aside: 20% of the creator's quote fees while the
    /// wallet that enrolled still holds the role, until the cap is spent. A
    /// handoff clears the election (the successor never consented). The
    /// running floor keeps the total exactly floor(C / 5), capped, however the
    /// fees arrive. Quote side only: bid fills credit the token side, so no swap
    /// path reads this; collect pays one read for it.
    function _setAside(PoolId poolId, address creator, uint256 gross) private returns (uint256 amount) {
        uint256 e = listingElection[poolId];
        if (gross == 0 || address(uint160(e)) != creator) return 0;
        uint256 remaining = e >> 168;
        if (remaining == 0) return 0;
        uint256 carry = gross % 5 + ((e >> 160) & 0xff);
        amount = gross / 5 + carry / 5;
        carry %= 5;
        if (amount >= remaining) {
            amount = remaining;
            carry = 0;
        }
        listingElection[poolId] = ((remaining - amount) << 168) | (carry << 160) | uint160(creator);
        if (amount != 0) {
            listingOwed[poolId] += amount;
            emit ListingSetAside(poolId, amount);
        }
    }

    /// @notice Desk only: start (cap > 0 for `creator`) or end (zero) a pool's
    /// election. Enrolling resets the carry; the desk checkpoints before it.
    function setListing(PoolId poolId, address creator, uint256 cap) external {
        if (msg.sender != address(listingDesk)) revert Unauthorized();
        listingElection[poolId] = creator == address(0) ? 0 : (cap << 168) | uint160(creator);
    }

    /// @notice Desk only: pay a withdrawal or reimbursement from this pool's set-aside.
    function takeListing(PoolId poolId, address to, uint256 amount) external {
        if (msg.sender != address(listingDesk)) revert Unauthorized();
        listingOwed[poolId] -= amount;
        ERC20(_pools[poolId].quote).safeTransfer(to, amount);
    }

    /// @notice Desk only: allocate its already-transferred Core fee share
    /// through the same five protocol legs as collect.
    function routeCoreFees(PoolId poolId, uint256 amount) external {
        if (msg.sender != address(listingDesk)) revert Unauthorized();
        _routeProtocolFees(poolId, address(_pools[poolId].token), amount);
    }

    /// @dev The same allocation for every fee asset, including the fee on a bid
    /// fill. Each destination is immutable and all creator/bid accounting is
    /// complete before transfers. Treasury receipts are funding, not purchases.
    function _routeProtocolFees(PoolId poolId, address asset, uint256 amount) internal {
        if (amount == 0) return;
        uint256 treasuryAmt = (amount * TREASURY_BPS) / 10_000;
        uint256 ecoAmt = (amount * ECO_BPS) / 10_000;
        uint256 stakerYieldAmt = (amount * STAKER_YIELD_BPS) / 10_000;
        uint256 kntqAmt = (amount * KNTQ_BPS) / 10_000;
        uint256 opexAmt = amount - stakerYieldAmt - treasuryAmt - ecoAmt - kntqAmt;
        ERC20(asset).safeTransfer(address(treasury), treasuryAmt);
        ERC20(asset).safeTransfer(address(ecosystemTreasury), ecoAmt);
        ERC20(asset).safeTransfer(address(stakerYieldTreasury), stakerYieldAmt);
        ERC20(asset).safeTransfer(address(kntqTreasury), kntqAmt);
        ERC20(asset).safeTransfer(address(opexTreasury), opexAmt);
        emit ProtocolFeesAllocated(poolId, asset, stakerYieldAmt, treasuryAmt, ecoAmt, opexAmt, kntqAmt);
    }

    /// @notice Anyone can crank; funds only ever move to the creator.
    function claim(PoolId poolId) external {
        _claim(poolId, true, true);
    }

    /// @notice Per-side claims: a quote that freezes transfers (a blacklistable
    /// quote, THREAT_MODEL SC-4) must never strand the token side of the payout
    /// in the same transaction — each leg zeroes and pays only its own owed
    /// balance (AUDIT 2026-08-30 AUD-5). Consumer: the creator, whenever one
    /// leg's transfer reverts.
    function claimToken(PoolId poolId) external {
        _claim(poolId, true, false);
    }

    function claimQuote(PoolId poolId) external {
        _claim(poolId, false, true);
    }

    // ---------------------------------------------------------------- funding a bid

    /// @notice Add this pool's quote to its irreversible bid inventory.
    /// Anyone can fund it through an ERC-20 allowance.
    /// Consumers: community funding and distributor-selected ecosystem buybacks.
    /// Funding neither changes the pool's spending cap nor creates withdrawal rights.
    function fundBid(PoolId poolId, uint256 amount) external {
        PoolData storage p = _pools[poolId];
        if (p.launchedAt == 0) revert UnknownPool();
        ERC20(p.quote).safeTransferFrom(msg.sender, address(this), amount);
        _bid[poolId].inventory += amount;
        emit BidFunded(poolId, msg.sender, amount);
    }

    // ---------------------------------------------------------------- the creator handoff (CG-2)

    /// @notice Propose a successor to the payout role; only the creator may call.
    /// Accrued balances belong to the pool and follow the accepted role.
    /// Zero cancels a proposal. The launchpad owner has no override.
    function transferCreator(PoolId poolId, address next) external {
        PoolData storage p = _pools[poolId];
        // An unknown pool has no creator, so this one check refuses it too.
        if (msg.sender != p.creator) revert Unauthorized();
        pendingCreator[poolId] = next;
        emit CreatorTransferStarted(poolId, next);
    }

    /// @notice The pending creator takes the role. From here claim() pays
    /// msg.sender; nothing is re-booked, because the owed balances are the
    /// pool's. Anyone else, and a pool with no handoff pending, is refused.
    function acceptCreator(PoolId poolId) external {
        if (msg.sender != pendingCreator[poolId]) revert Unauthorized();
        PoolData storage p = _pools[poolId];
        emit CreatorTransferred(poolId, msg.sender);
        p.creator = msg.sender;
        delete pendingCreator[poolId];
        delete listingElection[poolId];
    }

    function _claim(PoolId poolId, bool doToken, bool doQuote) internal {
        PoolData storage p = _pools[poolId];
        if (p.launchedAt == 0) revert UnknownPool();
        // Both transfers and the log must name the recipient of THIS payout.
        address recipient = p.creator;
        uint256 t;
        uint256 q;
        if (doToken) {
            t = creatorOwedToken[poolId];
            creatorOwedToken[poolId] = 0;
            if (t > 0) ERC20(address(p.token)).safeTransfer(recipient, t);
        }
        if (doQuote) {
            q = creatorOwedQuote[poolId];
            creatorOwedQuote[poolId] = 0;
            // Clear the claim before interacting with the quote.
            if (q > 0) ERC20(p.quote).safeTransfer(recipient, q);
        }
        emit CreatorClaimed(poolId, recipient, t, q);
    }

    // ---------------------------------------------------------------- lock callback

    /// @dev The Vault's callback for the launchpad's own locks (the seed, the
    /// collect). A hook callback from the pool manager is a different surface
    /// (onlyPoolManager); this one takes the Vault and nothing else.
    function lockAcquired(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != address(vault)) revert NotVault();
        LockData memory d = abi.decode(rawData, (LockData));
        if (d.op == OP_SEED) return _seedCallback(d);
        if (d.op == OP_COLLECT) return _collectCallback(d);
        // Both encoders live in this contract, so this is unreachable today; it
        // exists so an op added to one side and not the other fails loudly
        // instead of decoding as a collect (AUDIT 2026-08-30 AU-4).
        revert UnknownLockOp(d.op);
    }

    function _seedCallback(LockData memory d) internal returns (bytes memory) {
        Currency tokenCurrency = d.tokenIs0 ? d.key.currency0 : d.key.currency1;
        uint256 owedToken;

        uint256 steps = _curve.length;
        for (uint256 i = 0; i < steps; i++) {
            (int24 lo, int24 up, uint128 liquidity) =
                LaunchCurve.bandLiquidity(d.tokenIs0, d.startTick, _curve[i], TOTAL_SUPPLY);
            (BalanceDelta cd,) = poolManager.modifyLiquidity(
                d.key,
                ICLPoolManager.ModifyLiquidityParams({
                    tickLower: lo, tickUpper: up, liquidityDelta: int256(uint256(liquidity)), salt: 0
                }),
                ""
            );
            int128 owed = d.tokenIs0 ? cd.amount0() : cd.amount1();
            owedToken += uint256(uint128(-owed));
        }

        vault.pay(tokenCurrency, owedToken);

        uint256 devTokensOut;
        uint256 devQuoteSpent;
        if (d.devBuyQuote > 0) {
            // No price limit but the curve's end: the dev-buy walks as far as its
            // quote reaches, and launch() refunds whatever the curve could not
            // absorb (defense in depth: draining the whole curve costs ~1.1e7
            // HYPE at the default anchor — measured on a fork of 998, 2026-09-09:
            // a 2e8 HYPE dev-buy spent 10.97M for 99.9999999% of supply and was
            // refunded the rest — AUDIT 2026-08-30 AU-6 still holds).
            (devQuoteSpent, devTokensOut) = vault.buyExactIn(
                poolManager,
                d.key,
                d.tokenIs0,
                d.devBuyQuote,
                d.tokenIs0 ? TickMath.MAX_SQRT_PRICE - 1 : TickMath.MIN_SQRT_PRICE + 1,
                d.devBuyRecipient
            );
        }
        return abi.encode(devTokensOut, devQuoteSpent);
    }

    function _collectCallback(LockData memory d) internal returns (bytes memory) {
        uint256 fees0;
        uint256 fees1;
        uint256 steps = _curve.length;
        for (uint256 i = 0; i < steps; i++) {
            (int24 lo, int24 up) = LaunchCurve.mapBand(d.tokenIs0, d.startTick, _curve[i]);
            (BalanceDelta cd,) = poolManager.modifyLiquidity(
                d.key,
                ICLPoolManager.ModifyLiquidityParams({tickLower: lo, tickUpper: up, liquidityDelta: 0, salt: 0}),
                ""
            );
            // With liquidityDelta == 0 the caller delta IS the accrued fees (≥ 0).
            fees0 += uint256(uint128(cd.amount0()));
            fees1 += uint256(uint128(cd.amount1()));
        }
        if (fees0 > 0) vault.take(d.key.currency0, address(this), fees0);
        if (fees1 > 0) vault.take(d.key.currency1, address(this), fees1);
        return abi.encode(fees0, fees1);
    }

    /// @dev Every launchpad pool has the same fee flag, parameters and hook on
    /// this pool manager, so its key is a pure function of the pair — derived,
    /// never stored (`LaunchpadKey`, the one definition the community vault,
    /// the CTO registry, the suites and the web all mirror). launch()
    /// initialises with exactly this key, so the two cannot disagree.
    function _keyOf(address token, address quote) internal view returns (PoolKey memory) {
        return LaunchpadKey.keyOf(token, quote, address(this), address(poolManager));
    }

    // ---------------------------------------------------------------- hook callbacks

    /// @notice Registration checked against each pool key at initialization.
    function getHooksRegistrationBitmap() external pure returns (uint16) {
        return HOOK_BITMAP;
    }

    /// @dev Pools exist only via launch(): Infinity never calls this for the
    /// launchpad's own initialize (`Hooks.shouldCall` skips the hook when it is
    /// the caller), so every call that arrives is refused.
    function beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        external
        onlyPoolManager
        returns (bytes4)
    {
        revert OnlyLaunchpadPools();
    }

    /// @dev The lock's other half (SC-9, folded 2026-09-06): nobody but the
    /// launchpad adds liquidity. Infinity never calls this for the launchpad's
    /// own seed and pokes (`shouldCall` skips the caller), so every call that
    /// arrives is refused.
    function beforeAddLiquidity(
        address sender,
        PoolKey calldata key,
        ICLPoolManager.ModifyLiquidityParams calldata params,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4) {
        revert OnlyLaunchpadLiquidity();
    }

    function beforeSwap(address sender, PoolKey calldata key, ICLPoolManager.SwapParams calldata params, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId poolId = key.toId();
        PoolData storage p = _pools[poolId];
        _observe(p, poolId);

        // Everyone who reaches this code pays the lifecycle fee: decaying sniper
        // tax → 1%, for the life of the pool. The launchpad's own dev-buy never
        // does: Infinity skips every hook callback when the hook itself is the
        // swap caller (CLHooks.beforeSwap → Hooks.shouldCall, `address(hook) !=
        // msg.sender`), so the dev-buy pays the pool's stored dynamic lpFee —
        // still 0 when it runs; launch() mirrors BASE_FEE into storage only
        // after it — and makes no observation. Fee-exempt by the pool manager's
        // own mechanism, pinned by test_dev_buy_is_unobserved_by_ema and the
        // golden fixture's fee_pips.
        uint24 fee = _poolFee(p);
        return (ICLHooks.beforeSwap.selector, _fill(p, poolId, key, params, fee), fee | OVERRIDE_FEE_FLAG);
    }

    /// @dev Fill eligible exact-input sells at spot, within the observed EMA band.
    /// Charge and allocate the lifecycle fee on absorbed tokens, then reserve
    /// 20% of net purchased principal and accumulate the remainder. Inventory and the pool's fixed window cap bound quote
    /// spending. Amounts fit int128 and never exceed the swap; invalid limits or
    /// insufficient fronted tokens decline to the AMM with ZERO_DELTA.
    /// Book before settlement. Quote transferability remains required (SC-4);
    /// a frozen or hostile quote can revert a fill, just as it can revert an AMM swap.
    function _fill(
        PoolData storage p,
        PoolId poolId,
        PoolKey calldata key,
        ICLPoolManager.SwapParams calldata params,
        uint24 fee
    ) internal returns (BeforeSwapDelta) {
        // Exact-output swaps specify the OUTPUT, so "how much of the input can
        // we absorb" is not the question being asked; leave them to the AMM.
        if (params.amountSpecified >= 0) return BeforeSwapDeltaLibrary.ZERO_DELTA;
        // Only a SELL: the flywheel is a bid, it never sells accumulated tokens.
        // Paying the token means zeroForOne exactly when the token is currency0.
        if (params.zeroForOne != p.tokenIs0) return BeforeSwapDeltaLibrary.ZERO_DELTA;
        // int128 is the wire type of the delta, and 2^127 is also the bound that
        // keeps every price conversion below inside uint256 at the curve's
        // ceiling (2^127 tokens x a sub-2^224 priceX96 / 2^96 < 2^255). The pool
        // itself takes a larger exact input — it casts only the CONSUMED amount
        // to int128 (CLPool.swap), and a swap through thin liquidity consumes less
        // than it specifies — so such a swap still reaches the AMM; the fill
        // just declines. Compared BEFORE negating: `-type(int256).min` is a
        // checked-arithmetic panic, and a panic here is a reverted swap (review
        // 2026-09-03, CR-2; pinned by test_fill_declines_oversized_and_int256_min_exact_inputs).
        if (params.amountSpecified < -int256(MAX_DELTA)) return BeforeSwapDeltaLibrary.ZERO_DELTA;
        uint256 sellSize = uint256(-params.amountSpecified);

        Bid storage b = _bid[poolId];
        uint256 inventory = b.inventory;
        if (inventory == 0) return BeforeSwapDeltaLibrary.ZERO_DELTA;

        // The rate limit, rolled forward lazily. A window that has aged out
        // starts fresh. The cap is fixed at launch: changing a quote's config
        // cannot stall an existing bid or increase its spending allowance.
        uint256 perWindow = b.maxClip;
        bool windowExpired = block.timestamp >= uint256(b.windowStart) + FILL_WINDOW;
        uint256 allowance = windowExpired
            ? perWindow
            : (b.filledInWindow >= perWindow ? 0 : perWindow - b.filledInWindow);
        if (allowance == 0) return BeforeSwapDeltaLibrary.ZERO_DELTA;

        // Fill at SPOT, and only while spot sits inside the stored EMA's band.
        // Two properties fall out of that one rule: the seller is never worse
        // off than the AMM (the AMM walks them down from spot; we pay spot flat
        // on the filled part), and we never pay for a pump the EMA has not
        // observed — outside the band we simply do not fill, which is the
        // recycler's "fail closed, fees wait" posture with the failure moved off
        // the user's swap entirely. Spot, not min(spot, EMA): a fill below spot
        // would pay the seller LESS than the AMM's first wei does, on a portion
        // they cannot opt out of — see DESIGN_v1-final §3.1.
        (uint160 spot,,,) = poolManager.getSlot0(poolId);
        if (spot == 0 || !_withinBand(spot, p.emaSqrtPriceX96)) return BeforeSwapDeltaLibrary.ZERO_DELTA;
        // A complete hook fill leaves amountSpecified == 0 for CLPool.swap,
        // which returns before checking the caller's price limit. Decline an
        // invalid limit here so the pool receives the original amount and raises
        // its usual error. Full and partial fills then honor the same constraint.
        if (
            params.zeroForOne
                ? params.sqrtPriceLimitX96 >= spot || params.sqrtPriceLimitX96 <= TickMath.MIN_SQRT_PRICE
                : params.sqrtPriceLimitX96 <= spot || params.sqrtPriceLimitX96 >= TickMath.MAX_SQRT_PRICE
        ) return BeforeSwapDeltaLibrary.ZERO_DELTA;
        // Spot as a price, derived once: every conversion below — up to three on
        // a capped fill — reads this instead of squaring the sqrt price again.
        uint256 priceX96 = _priceX96(spot);

        // The fee comes off the top of the input first, as the AMM takes it; the
        // seller is paid spot on what is left.
        uint256 tokensIn = sellSize;
        uint256 net = _lessFee(tokensIn, fee);
        uint256 quoteOut = _quoteFor(net, priceX96, p.tokenIs0);
        // Clamp by BOTH bounds, in quote terms, then convert back — so the
        // amount we owe can never exceed what we hold or what the window allows.
        uint256 cap = inventory < allowance ? inventory : allowance;
        if (cap > MAX_DELTA) cap = MAX_DELTA;
        if (quoteOut > cap) {
            // The NET tokens the cap buys, grossed back up by the fee to what the
            // seller hands over. Every conversion rounds DOWN, so the delta never
            // claims more of the swap than the quote pays for and the re-derived
            // quote can only land at or under the cap — a wei or two under it,
            // at most, which stays in the inventory for a later fill rather than
            // ever being over-spent. The two checks that follow are the doubt
            // rule stated in code, not a reachable path.
            net = _tokensFor(cap, priceX96, p.tokenIs0);
            tokensIn = FullMath.mulDiv(net, MAX_LP_FEE, MAX_LP_FEE - fee);
            if (tokensIn > sellSize) return BeforeSwapDeltaLibrary.ZERO_DELTA;
            net = _lessFee(tokensIn, fee);
            quoteOut = _quoteFor(net, priceX96, p.tokenIs0);
            if (quoteOut > cap) return BeforeSwapDeltaLibrary.ZERO_DELTA;
        }
        if (net == 0 || quoteOut == 0) return BeforeSwapDeltaLibrary.ZERO_DELTA;

        uint256 feeTokens = tokensIn - net;
        // Fee revenue uses collect()'s allocation. Purchased principal is
        // accounted separately, so it is never counted as newly earned fees.
        uint256 creatorT = (feeTokens * CREATOR_BPS) / 10_000;
        uint256 reserved = (net * STAKERS_BPS) / 10_000;
        uint256 accumulated = net - reserved;

        // The take below moves `tokensIn` out of the Vault BEFORE the seller
        // settles, so the Vault must already hold them. It does, out of the
        // curve's own reserves — short only within a token of the curve's
        // ceiling, ~1e8 quote away — but a take it cannot honour is a reverted
        // swap, so read the balance and decline rather than assume (review
        // 2026-09-03, CR-3; pinned by test_fill_declines_when_the_vault_cannot_front_the_tokens).
        if (p.token.balanceOf(address(vault)) < tokensIn) return BeforeSwapDeltaLibrary.ZERO_DELTA;

        // Book everything BEFORE the external moves below (DP-R6 posture): a
        // hostile ERC-20 quote gets control inside `pay`, so a reentrant collect
        // or claim must find a debited bid and a credited creator, never the
        // in-flight state.
        b.inventory = inventory - quoteOut;
        if (windowExpired) {
            b.windowStart = uint40(block.timestamp);
            b.filledInWindow = quoteOut;
        } else {
            b.filledInWindow += quoteOut;
        }
        creatorOwedToken[poolId] += creatorT;

        // Resolve our own side of the delta now, inside the open lock: take the
        // tokens the seller is handing over, route protocol fees, retain the
        // creator's fee, reserve/accumulate net purchased principal, and settle the
        // quote we owe. The pool manager books the returned delta against this
        // hook after the swap (CLPoolManager.swap → Vault.accountAppBalanceDelta
        // with the hook delta), so these calls and that booking net to zero.
        Currency tokenCurrency = p.tokenIs0 ? key.currency0 : key.currency1;
        Currency quoteCurrency = p.tokenIs0 ? key.currency1 : key.currency0;
        vault.take(tokenCurrency, address(this), tokensIn);
        _routeProtocolFees(poolId, address(p.token), feeTokens - creatorT);
        if (accumulated > 0) ERC20(address(p.token)).safeTransfer(address(inventoryTreasury), accumulated);
        if (reserved > 0) ERC20(address(p.token)).safeTransfer(address(cohortTreasury), reserved);
        emit TokensAccumulated(poolId, address(p.token), InventorySource.Purchase, accumulated);
        vault.pay(quoteCurrency, quoteOut);

        emit Filled(poolId, tokensIn, feeTokens, 0, quoteOut);
        return toBeforeSwapDelta(int128(uint128(tokensIn)), -int128(uint128(quoteOut)));
    }

    /// @dev Is `spot` within FILL_BAND_BPS of the stored EMA, in price terms?
    /// Compared in sqrt space with the same half-bps approximation the recycler
    /// used (sqrt(1±d) ≈ 1 ± d/2), so the two bands are the same band.
    function _withinBand(uint160 spot, uint160 ema) internal pure returns (bool) {
        if (ema == 0) return false;
        uint256 half = (uint256(ema) * FILL_BAND_BPS) / 20_000;
        return uint256(spot) >= uint256(ema) - half && uint256(spot) <= uint256(ema) + half;
    }

    /// @dev The pool price (currency1 per currency0, Q96) at `sqrtP`. It rounds
    /// to 0 below 2^48 in sqrt terms; both converters return 0 for that and the
    /// fill declines (`net == 0 || quoteOut == 0`) rather than divide by it.
    function _priceX96(uint160 sqrtP) internal pure returns (uint256) {
        return FullMath.mulDiv(uint256(sqrtP), uint256(sqrtP), FixedPoint96.Q96);
    }

    /// @dev Quote owed for `tokens` at `priceX96`. v4's price is currency1 per
    /// currency0, so the direction flips with the token's sort position.
    function _quoteFor(uint256 tokens, uint256 priceX96, bool tokenIs0) internal pure returns (uint256) {
        if (priceX96 == 0) return 0;
        return tokenIs0
            ? FullMath.mulDiv(tokens, priceX96, FixedPoint96.Q96)
            : FullMath.mulDiv(tokens, FixedPoint96.Q96, priceX96);
    }

    /// @dev The inverse of _quoteFor, rounding DOWN on the tokens we receive —
    /// never up, or the delta would claim more of the swap than the quote buys.
    function _tokensFor(uint256 quote, uint256 priceX96, bool tokenIs0) internal pure returns (uint256) {
        if (priceX96 == 0) return 0;
        return tokenIs0
            ? FullMath.mulDiv(quote, FixedPoint96.Q96, priceX96)
            : FullMath.mulDiv(quote, priceX96, FixedPoint96.Q96);
    }

    /// @dev `amount` net of the lifecycle fee, computed the way the pool's
    /// exact-input step computes it (SwapMath.computeSwapStep:
    /// `amountRemainingLessFee`), so the fill's fee is the AMM's fee to the wei
    /// and rounds UP as the AMM's does.
    /// `fee` is the raw pips _poolFee returns (<= START_FEE), never the
    /// override-flagged value, so the denominator below is never zero.
    function _lessFee(uint256 amount, uint24 fee) internal pure returns (uint256) {
        return FullMath.mulDiv(amount, MAX_LP_FEE - fee, MAX_LP_FEE);
    }

    /// @dev Observe the price that stood BEFORE this swap, clamped to the curve.
    /// Capped dt gives at most 50% weight per update; same-second swaps add none.
    /// A pump cannot observe itself. Sustained manipulation remains bounded by
    /// the bid's spending cap, not eliminated by this EMA (SC-3/SC-6/SC-16).
    function _observe(PoolData storage p, PoolId poolId) internal {
        uint256 dt = block.timestamp - p.emaUpdatedAt;
        if (dt == 0) return; // same second as the last observation: nothing new has stood
        if (dt > EMA_MAX_DT) dt = EMA_MAX_DT;
        (uint160 spot,,,) = poolManager.getSlot0(poolId);
        (uint160 lo, uint160 hi) = _curveBounds(p);
        if (spot < lo) spot = lo;
        else if (spot > hi) spot = hi;
        uint160 ema = p.emaSqrtPriceX96;
        if (spot >= ema) {
            ema = uint160(uint256(ema) + (uint256(spot - ema) * dt) / (dt + EMA_TAU));
        } else {
            ema = uint160(uint256(ema) - (uint256(ema - spot) * dt) / (dt + EMA_TAU));
        }
        p.emaSqrtPriceX96 = ema;
        p.emaUpdatedAt = uint40(block.timestamp);
    }

    /// @dev Pool-space bounds, from the initial price to the last band's far edge.
    /// Clamp observations because the pool can traverse empty liquidity to a distant
    /// router limit without spending tokens (SC-16). That traversal must not drag
    /// the EMA outside the actual launch curve.
    function _curveBounds(PoolData storage p) internal view returns (uint160 lo, uint160 hi) {
        if (p.tokenIs0) {
            lo = TickMath.getSqrtPriceAtTick(p.startTick - TICK_SPACING);
            hi = TickMath.getSqrtPriceAtTick(p.startTick + _curveTop);
        } else {
            lo = TickMath.getSqrtPriceAtTick(-(p.startTick + _curveTop));
            hi = TickMath.getSqrtPriceAtTick(-p.startTick + TICK_SPACING);
        }
    }

    /// @dev Shared by beforeSwap and currentFee: launch decay, then lifetime BASE_FEE.
    function _poolFee(PoolData storage p) internal view returns (uint24) {
        uint256 elapsed = block.timestamp - p.launchedAt;
        if (elapsed < FEE_DECAY_SECONDS) {
            return uint24(BASE_FEE + ((START_FEE - BASE_FEE) * (FEE_DECAY_SECONDS - elapsed)) / FEE_DECAY_SECONDS);
        }
        return BASE_FEE;
    }

    // ---------------------------------------------------------------- admin (the whole surface)

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setQuoteConfig(address quote, QuoteConfig calldata cfg) external onlyOwner {
        _setQuoteConfig(quote, cfg);
    }

    function _setQuoteConfig(address quote, QuoteConfig memory cfg) internal {
        if (quote == address(0) || quote.code.length == 0) revert BadQuoteConfig();
        // Refuse unusable currencies at registration; issuer policy remains curation.
        ERC20(quote).decimals();
        if (cfg.maxClip == 0) revert BadQuoteConfig();
        LaunchCurve.validateQuote(_curve, cfg.startTick, TICK_SPACING, TOTAL_SUPPLY);
        _quoteConfig[quote] = cfg;
        emit QuoteConfigSet(quote, cfg.allowed, cfg.startTick, cfg.maxClip);
    }

    // ---------------------------------------------------------------- views

    function quoteConfig(address quote) external view returns (QuoteConfig memory) {
        return _quoteConfig[quote];
    }

    /// @notice Quote spending cap per FILL_WINDOW, fixed at this pool's launch.
    /// Consumer: the token page's standing-bid disclosure. Zero for unknown pools.
    function poolMaxClip(PoolId poolId) external view returns (uint128) {
        return _bid[poolId].maxClip;
    }

    /// @notice Currency orientation for the token page's pending-fee calculation.
    /// Pool keys remain derivable from the pair and this hook's fixed parameters.
    function poolTokenIs0(PoolId poolId) external view returns (bool) {
        return _pools[poolId].tokenIs0;
    }

    /// @notice Current payout role. The creator alone can propose its handoff.
    /// Consumers: creator controls, metadata authority and external role checks.
    function poolCreator(PoolId poolId) external view returns (address) {
        return _pools[poolId].creator;
    }

    /// @notice Launch timestamp, or zero for an unknown pool.
    /// Consumers: token resolution, trade age, fixture and external age gates.
    function poolLaunchedAt(PoolId poolId) external view returns (uint40) {
        return _pools[poolId].launchedAt;
    }

    /// @notice Pool anchor snapshotted at launch, unaffected by quote re-anchoring.
    /// Consumers: pending-fee and on-chain curve readers. Zero is a valid tick;
    /// use poolLaunchedAt for existence.
    function poolStartTick(PoolId poolId) external view returns (int24) {
        return _pools[poolId].startTick;
    }

    function emaSqrtPrice(PoolId poolId) external view returns (uint160) {
        return _pools[poolId].emaSqrtPriceX96;
    }

    /// @notice Last observation timestamp; the EMA is not time-corrected on reads.
    /// The golden fixture checks the indexer's event-derived timestamp against it.
    /// Retained for on-chain freshness readers, including the planned omnipool;
    /// the current indexer does not call it over RPC.
    function emaUpdatedAt(PoolId poolId) external view returns (uint40) {
        return _pools[poolId].emaUpdatedAt;
    }

    /// @notice Quote reserved for this pool's sells, from collections and top-ups.
    /// Consumers: the token page's standing bid and the indexer's fixture anchor.
    function bidInventory(PoolId poolId) external view returns (uint256) {
        return _bid[poolId].inventory;
    }

    function curve() external view returns (CurveStep[] memory) {
        return _curve;
    }

    /// @notice Current swap fee for a pool (pips): sniper tax while decaying,
    /// then 1% for the life of the pool.
    function currentFee(PoolId poolId) external view returns (uint24) {
        return _poolFee(_pools[poolId]);
    }
}
