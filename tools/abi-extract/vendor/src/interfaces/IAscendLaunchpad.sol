// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PoolId} from "infinity-core/src/types/PoolId.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";

/// @notice The immutable launchpad's public reads and actions used by the
/// indexer, web, ceremony and satellite contracts. Consumers are named below.
interface IAscendLaunchpad {
    /// @notice Bindings read by the CTO registry, ceremony checks and settlement tests.
    function poolManager() external view returns (ICLPoolManager);
    function vault() external view returns (IVault);
    enum InventorySource { Seed, Purchase, Contribution }

    /// @notice Explicit original-token contribution; no user claim is created.
    function accumulate(PoolId poolId, uint256 amount) external;

    /// @notice Original tokens retained for protocol-directed listing,
    /// distribution or liquidity. Consumer: source-separated indexer inventory.
    event TokensAccumulated(PoolId indexed poolId, address indexed token, InventorySource indexed source, uint256 amount);

    struct QuoteConfig {
        bool allowed; // gates NEW launches only; existing pools are forever
        int24 startTick; // canonical launch tick (price of token in quote), multiple of tickSpacing
        uint128 maxClip; // per-pool fill cap per FILL_WINDOW, in quote wei — snapshotted at launch
    }

    /// @notice One band of the launchpad-wide launch curve, in canonical space
    /// (token priced in quote); `_mapBand` mirrors it when the token sorts as
    /// currency1. Declared here rather than on the implementation so `curve()`
    /// below is readable without importing it; the ceremony and the suites name
    /// it `IAscendLaunchpad.CurveStep` (a struct on a base is not reachable
    /// through the derived contract's name).
    struct CurveStep {
        int24 offsetLower; // ticks above startTick, canonical
        int24 offsetUpper;
        uint16 bps; // share of TOTAL_SUPPLY seeded in this band
    }

    /// @notice What `launch` takes. The creator is a ROLE, not the caller (CG-1,
    /// 2026-09-03): who claim() pays for the life of the pool and who the
    /// dev-buy tokens land with. A bot or a frontend launching on a user's
    /// behalf names the user here and custodies nothing; the app defaults it to
    /// the wallet that signs, so the one-transaction launch is unchanged. Last
    /// in the struct so the tuple's earlier fields keep their positions. Never
    /// address(0). Declared here for the same reason as CurveStep.
    struct LaunchParams {
        string name;
        string symbol;
        address quote;
        uint256 devBuyQuote; // quote amount the PAYER (msg.sender) funds the atomic dev-buy with (no size limit — the curve's end is the bound)
        uint256 minDevOut; // slippage floor for the dev-buy
        bytes32 salt; // caller-chosen; token address = CREATE2(launchpad, keccak(sender,salt), initcode)
        address creator;
    }

    // ------------------------------------------------------------- the writes
    // Consumers: the web's launch form and creator panel; a contract launching
    // on a user's behalf (CG-1) and a contract creator — a fee splitter, CG-6 —
    // which must claim and hand the role on against this file alone. The
    // implementation documents each; nothing is re-explained here.

    function launch(LaunchParams calldata p) external returns (address tokenAddr, PoolId poolId);
    /// @notice Add `amount` of `poolId`'s ERC-20 quote through allowance. Consumers: the
    /// distributor, funding selected ecosystem pools, or any community wallet.
    /// Budget receipts and bid deposits are separate operations.
    function fundBid(PoolId poolId, uint256 amount) external;
    function claim(PoolId poolId) external;
    /// @notice Per-side claims: when one leg's transfer reverts (a quote that
    /// froze transfers, THREAT_MODEL SC-4) the other leg is still payable.
    function claimToken(PoolId poolId) external;
    function claimQuote(PoolId poolId) external;
    function transferCreator(PoolId poolId, address next) external;
    function acceptCreator(PoolId poolId) external;
    function creatorOwedToken(PoolId poolId) external view returns (uint256);
    function creatorOwedQuote(PoolId poolId) external view returns (uint256);
    /// @notice The Core-listing election and the unspent quote held for the listing desk (`AscendLaunchpad.listingDesk`). The election is
    /// packed: enrolling creator role (low 160 bits) | carry (8) | cap left (88).
    /// Consumers: the listing desk, the creator panel's set-aside line.
    function listingElection(PoolId poolId) external view returns (uint256);
    function listingOwed(PoolId poolId) external view returns (uint256);

    // ---------------------------------------------- the crank and the pool facts
    // Consumers: collect — the creator's claim flow (web) and the operator's
    // crank for idle pools (OPEN_ITEMS E19), neither paid since 2026-09-08;
    // emaSqrtPrice — the indexer's EMA mirror, anchored on it through the golden
    // fixture; poolTokenIs0 — the token page's pending-fee mirror, and any
    // contract handed a pool id (the token side is not a getter, so the
    // orientation is not derivable from the id alone); quoteConfig —
    // the ceremony's read-back (Verify.s.sol, QuoteRow.s.sol). A pool's key,
    // token and quote are not getters (removed 2026-09-04): the key is a pure
    // function of the pair, and every reader holds the pair from `Launched`.

    /// @notice USDC base quote identity used by Verify, StackChecks and the web.
    function baseQuote() external view returns (address);
    function collect(PoolId poolId) external returns (uint256 flywheelQuote);
    function emaSqrtPrice(PoolId poolId) external view returns (uint160);
    function poolTokenIs0(PoolId poolId) external view returns (bool);
    function quoteConfig(address quote) external view returns (QuoteConfig memory);

    // -------------------------------------------------------- the alarm surface
    // Consumers: the token page's standing-bid line (bidInventory, read live —
    // failure-archetypes #4: an inventory that stops converting is the
    // flywheel's alarm) and the indexer's per-pool bid mirror, anchored on this
    // read through the golden fixture. Fee budgets are separate treasury custody.

    function bidInventory(PoolId poolId) external view returns (uint256);

    /// @dev A quoted sell that includes a fill (the quoter simulates beforeSwap)
    /// is a claim about the window it ran in: the fill's size follows the
    /// inventory above, the cap below, what earlier sells already filled this
    /// window and the standing price's band — all of which other sellers'
    /// transactions move. The AMM-only output is the floor; a minimum-out taken
    /// from a filled quote can fail `SlippageExceeded` on a contested pool, and
    /// the right response is a fresh quote, not a wider tolerance.

    /// @notice Spending cap fixed at launch, in quote wei per FILL_WINDOW.
    /// Consumer: the token page. Zero for unknown pools.
    function poolMaxClip(PoolId poolId) external view returns (uint128);

    // ------------------------------------------------------- external readers

    /// @notice When `poolId` launched; 0 for a pool this launchpad never
    /// launched (the `UnknownPool` sentinel every money path checks).
    /// Consumers: the omnipool's `AGE_MIN` entry gate (DESIGN_omnipool §2.2) and
    /// the indexer's `pools.launched_at` anchor (OPEN_ITEMS F10).
    function poolLaunchedAt(PoolId poolId) external view returns (uint40);

    /// @notice The canonical launch tick `poolId` was seeded at — the anchor of
    /// every curve band. The quote's config binds FUTURE launches only, so after
    /// an admin re-anchor (OPEN_ITEMS E4) this is the only on-chain source of a
    /// live pool's curve. 0 is a valid tick, not a sentinel — use
    /// `poolLaunchedAt` for the unknown-pool check. Consumers: the token page's
    /// pending-fee mirror (web/src/lib/pending.ts anchors the bands on it) and
    /// a phase-2 LP manager placing relative to the curve floor
    /// (DESIGN_omnipool §2.3).
    function poolStartTick(PoolId poolId) external view returns (int24);

    /// @notice When `emaSqrtPrice(poolId)` last moved. The EMA is stored as of
    /// that moment, not time-corrected (THREAT_MODEL SC-10), so a reader valuing
    /// anything at it needs this to know how long spot has stood unobserved.
    /// Consumers: the indexer's folded `pool_stats.ema_updated_at`, anchored
    /// on it through the golden fixture, and the omnipool's NAV and divergence
    /// gate (DESIGN_omnipool §2.1–2.2).
    function emaUpdatedAt(PoolId poolId) external view returns (uint40);

    /// @notice Who `claim()` pays for `poolId`: the creator role named at launch
    /// (CG-1 — a parameter, not the caller) until the creator hands it to a
    /// wallet that accepts (CG-2; THREAT_MODEL SC-11). The chain-side source of
    /// creator identity for any surface that must not trust the read model (a
    /// claim button, a phase-2 creator gate).
    function poolCreator(PoolId poolId) external view returns (address);

    /// @notice The wallet a pending creator handoff names, address(0) when none.
    /// Consumers: the web's creator panel (the accept button lands with the
    /// right wallet, and a handoff is visible before it lands), the indexer's
    /// `pool_stats.pending_creator`.
    function pendingCreator(PoolId poolId) external view returns (address);

    /// @notice Current swap fee for a pool, in pips: the sniper tax while it
    /// decays, then BASE_FEE for the life of the pool. The pool's *stored*
    /// dynamic lpFee mirrors BASE_FEE from the end of `launch()` (0 before
    /// that, for the fee-exempt dev-buy), but `beforeSwap` returns an override
    /// on every swap — so inside the decay window the stored value is NOT the
    /// fee charged, and this is the only correct fee source for a caller that
    /// is not simulating the swap. Consumers: the token page's trade panel, and
    /// any quoting integrator that reads state instead of simulating.
    function currentFee(PoolId poolId) external view returns (uint24);

    /// @notice The launchpad-wide launch curve, in canonical space. Consumers:
    /// the token page's pending-fee mirror (web/src/lib/pending.ts places the
    /// bands from this, never from a copy), the ceremony's read-back
    /// (Verify.s.sol) and a phase-2 LP manager placing relative to the bands.
    function curve() external view returns (CurveStep[] memory);

    // ------------------------------------------------------- events and errors
    // A contract integrating against this file decodes every log the launchpad
    // emits and expects every revert it raises without importing the
    // implementation. The two ownership events and `Unauthorized` are
    // TwoStepOwned's. Consumers per event below; every error is named in the
    // web's revert decoder (web/src/lib/revert.ts) from the compiled ABI.
    //
    // Four reverts an integrator meets that are not declared here, because they
    // are not the launchpad's own: (1) `launch` with a (sender, salt) already
    // used for the same name and symbol collides on the token's CREATE2 and
    // reverts with EMPTY data — the token address is a function of all four,
    // so a salt is single-use per name/symbol; (2) an ERC-20 dev-buy without
    // an allowance to the launchpad reverts with solmate's `TRANSFER_FROM_FAILED`
    // string; (3) the hook callbacks refuse a caller that is not the PoolManager
    // with BaseHook's `NotPoolManager`; (4) inside a swap the PoolManager wraps
    // every hook revert (`OnlyLaunchpadPools`, `OnlyLaunchpadLiquidity`) in
    // `CustomRevert.WrappedError(hook, selector, reason, HookCallFailed)` (ERC-7751,
    // the envelope v4 used too).

    /// @notice One launch: the pool, its token, the creator ROLE, the quote,
    /// what the curve still holds AFTER the dev-buy and what the dev-buy took:
    /// `supplySeeded` is TOTAL_SUPPLY − the seed residual (to inventory) −
    /// `devBuyTokens`, never the pre-dev-buy seed (review 2026-09-21).
    /// Consumers: the indexer (`pools`, the same-transaction Initialize is its
    /// witness), the web's launch flow (the pool id for the new token page).
    event Launched(
        PoolId indexed poolId,
        address indexed token,
        address indexed creator,
        address quote,
        uint256 supplySeeded,
        uint256 devBuyTokens
    );
    /// @notice One collect: the fees pulled off the curve and how they split.
    /// `flywheelQuote` is the protocol's half of the quote fees, and the five
    /// legs share all of it — nothing is paid to the caller (the crank tip went
    /// 2026-09-08). The indexer mirrors the arithmetic — packages/shared
    /// `splitCollected`.
    event Collected(
        PoolId indexed poolId,
        uint256 tokenFees,
        uint256 quoteFees,
        uint256 tokensBurned,
        uint256 flywheelQuote
    );
    /// @notice Per-asset protocol fee allocation. Consumer: the indexer's raw
    /// allocation ledger and custody reconciliation. Amounts describe receipts,
    /// not completed buybacks or permission to spend another leg's balance.
    event ProtocolFeesAllocated(
        PoolId indexed poolId,
        address indexed asset,
        uint256 stakerYield,
        uint256 treasury,
        uint256 ecosystem,
        uint256 opex,
        uint256 kntq
    );
    /// @notice Quote carved in a collect for the pool's Core listing: 20% of the
    /// creator's quote fees while the enrolling creator role still holds the
    /// pool, until its cap is spent. The creator's quote credit in that collect
    /// is its half of `quoteFees` minus `amount`, and the flywheel is unchanged.
    /// Consumers: the indexer's creator ledger (emitted before `Collected`),
    /// listing payments and creator refunds.
    event ListingSetAside(PoolId indexed poolId, uint256 amount);
    /// @notice A creator payout, both legs. Consumers: the indexer (`claims`,
    /// the owed/claimed columns), the creator panel.
    event CreatorClaimed(PoolId indexed poolId, address indexed creator, uint256 tokenAmount, uint256 quoteAmount);
    /// @notice The creator proposed handing `poolId`'s role to `to` (address(0)
    /// cancels a pending handoff). Nothing moves until `to` accepts. The
    /// proposer is the pool's creator, which every reader already holds, so the
    /// event names only the counterparty. Consumers: the indexer
    /// (`pool_stats.pending_creator`, the admin transparency log), the creator
    /// page's "handoff pending" badge.
    event CreatorTransferStarted(PoolId indexed poolId, address indexed to);
    /// @notice `to` accepted: from this block claim() pays `to`, and the owed
    /// balances — per pool, never per address — moved with the role untouched.
    /// Consumers: the indexer (`pool_stats.creator`), the art claim's authority
    /// in the api (pools.creator is the current creator).
    event CreatorTransferred(PoolId indexed poolId, address indexed to);
    /// @notice A quote row written by the owner. Consumers: the indexer
    /// (`quotes`, the allowlist the board filters on), the ceremony's read-back.
    event QuoteConfigSet(address indexed quote, bool allowed, int24 startTick, uint128 maxClip);
    /// @notice The launch pause flipped. Consumers: the indexer
    /// (`state.launchpad.paused`), the launch form's notice.
    event PausedSet(bool paused);
    /// @notice One internal fill: the flywheel was the counterparty to part of a
    /// sell, at spot, without touching the AMM. `tokensIn` is what the seller
    /// handed the bid; `feeTokens` is the lifecycle fee charged on it — the same
    /// rate, on the same input, the AMM would have charged (DESIGN_v1-final
    /// §3.5: a fill is fee-neutral, so who fills a sell is invisible to the fee
    /// books). CREATOR_BPS of the fee is the creator's (`creatorOwedToken`); the
    /// protocol fee half follows ProtocolFeesAllocated. Only the net purchased
    /// principal is reserved or accumulated. `tokensBurned` is always zero in
    /// this version; TokensAccumulated records the inventory receipt separately.
    /// `quotePaid` went to the seller. No seller field: inside a
    /// hook callback `msg.sender` is the PoolManager and the swap's `sender` is
    /// a router. The indexer's `senders` map attributes the transaction's
    /// submitter, which can differ from the trader or recipient for contract
    /// wallets, relayers and bundles. It is not an authorization identity.
    /// Consumers: the indexer (the eco read model and the creator's token
    /// accrual, and the same transaction's Swap row, whose logged amounts are
    /// the AMM's share alone) and the dashboard's buyback rail, which this
    /// replaces `Recycled` for on the eco leg.
    event Filled(PoolId indexed poolId, uint256 tokensIn, uint256 feeTokens, uint256 tokensBurned, uint256 quotePaid);
    /// @notice Quote landing in a pool's bid — the one inventory the fill spends.
    /// `funder` identifies the distributor or community wallet that explicitly
    /// funded this pool. Collection never funds a bid. The indexer preserves
    /// the funder and reconciles deposits against bid inventory and fills.
    event BidFunded(PoolId indexed poolId, address indexed funder, uint256 amount);

    error LaunchesArePaused();
    error QuoteNotAllowed();
    error ZeroCreator();
    error UnknownPool();
    error UnknownLockOp(uint8 op);
    /// @dev A lock callback from anything but the Vault (the launchpad's own
    /// `lockAcquired`; the hook callbacks refuse under AscendLaunchpad.NotPoolManager).
    error NotVault();
    error OnlyLaunchpadPools();
    error OnlyLaunchpadLiquidity();
    error BadQuoteConfig();
    error BadCurve();
    error DevBuySlippage();
}
