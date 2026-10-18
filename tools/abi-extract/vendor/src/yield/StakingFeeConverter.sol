// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TwoStepOwned} from "../base/TwoStepOwned.sol";
import {Treasury} from "../Treasury.sol";
import {AscendYieldVault} from "./AscendYieldVault.sol";

interface IStakingQuoteOracle {
    /// @notice HYPE wei for the exact input amount; oldest observation timestamp.
    function quoteHype(address asset, uint256 amount) external view returns (uint256, uint256);
}

interface IStakingSwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256);
}

interface IWrappedHype { function withdraw(uint256 amount) external; }
interface IKinetiqStaking { function stake() external payable; }

/// @notice Fixed routes and destinations for one protocol fee leg. The keeper
/// calls its StakingFeeTreasury, never a user deposit flow. Each execution has
/// an independent, fresh oracle floor, epoch budget and caller slippage floors.
/// Conversion failures revert atomically and leave fees in their treasury.
/// Consumer: the protocol conversion keeper; receipts feed CONVERSIONS.md.
contract StakingFeeConverter is TwoStepOwned, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Route { address asset; bytes path; uint256 maxEpochInput; }
    IStakingSwapRouter public immutable router;
    IStakingQuoteOracle public immutable oracle;
    AscendYieldVault public immutable vault;
    address public immutable wrappedHype;
    address public immutable stakingManager;
    address public immutable executor;
    bool public immutable extraYield;
    uint256 public immutable maxSlippageBps;
    uint256 public immutable maxPriceAge;
    /// @notice Executed purchases only; consumed by the public stats page.
    uint256 public totalHypeBought;
    uint256 public totalKHYPEReceived;
    mapping(address => bytes) public paths;
    mapping(address => uint256) public maxEpochInput;
    mapping(address => uint256) public spentInEpoch;
    mapping(address => uint256) private epochOf;

    error InvalidConversion();
    error StalePrice();
    error OutputTooLow();
    error BudgetExceeded();
    event Converted(address indexed source, address indexed asset, uint256 amountIn,
        uint256 hypeBought, uint256 khypeReceived, bool extraYield, uint256 principalShares);
    event ProtocolRedeemed(uint256 shares, uint256 khype, address indexed recipient);

    constructor(address owner_, address executor_, address router_, address oracle_,
        address vault_, address wrappedHype_, address stakingManager_, bool extraYield_,
        uint256 maxSlippageBps_, uint256 maxPriceAge_, Route[] memory routes) TwoStepOwned(owner_) {
        if (executor_ == address(0) || executor_ == owner_ || router_.code.length == 0
            || oracle_.code.length == 0 || vault_.code.length == 0 || wrappedHype_.code.length == 0
            || stakingManager_.code.length == 0 || maxSlippageBps_ > 500
            || maxPriceAge_ == 0 || maxPriceAge_ > 1 hours || routes.length == 0) revert InvalidConversion();
        executor = executor_;
        router = IStakingSwapRouter(router_);
        oracle = IStakingQuoteOracle(oracle_);
        vault = AscendYieldVault(vault_);
        wrappedHype = wrappedHype_;
        stakingManager = stakingManager_;
        extraYield = extraYield_;
        maxSlippageBps = maxSlippageBps_;
        maxPriceAge = maxPriceAge_;
        for (uint256 i; i < routes.length; ++i) {
            Route memory r = routes[i];
            bytes memory path = r.path;
            if (r.asset.code.length == 0 || r.maxEpochInput == 0 || paths[r.asset].length != 0
                || path.length < 43 || (path.length - 20) % 23 != 0) revert InvalidConversion();
            address first;
            address last;
            assembly ("memory-safe") {
                first := shr(96, mload(add(path, 32)))
                last := shr(96, mload(add(add(path, 32), sub(mload(path), 20))))
            }
            if (first != r.asset || last != wrappedHype_ || r.asset == wrappedHype_) revert InvalidConversion();
            paths[r.asset] = path;
            maxEpochInput[r.asset] = r.maxEpochInput;
        }
    }

    receive() external payable {
        if (msg.sender != wrappedHype) revert InvalidConversion();
    }

    /// @notice Keeper reads the remaining input budget before simulating.
    function remainingInput(address asset) external view returns (uint256) {
        return maxEpochInput[asset] - (epochOf[asset] == block.timestamp / 1 days ? spentInEpoch[asset] : 0);
    }

    function convert(address asset, uint256 amount, uint256 minHype, uint256 minKHYPE, uint256 deadline)
        external nonReentrant returns (uint256 received)
    {
        // Treasury is the source; it checks the executor. Direct donors may use
        // the same fixed destination, but cannot spend another account's assets.
        if (amount == 0 || paths[asset].length == 0 || deadline < block.timestamp
            || deadline > block.timestamp + 10 minutes || minHype == 0 || minKHYPE == 0) revert InvalidConversion();
        uint256 epoch = block.timestamp / 1 days;
        uint256 spent = epochOf[asset] == epoch ? spentInEpoch[asset] : 0;
        if (amount > maxEpochInput[asset] - spent) revert BudgetExceeded();
        (uint256 expected, uint256 observedAt) = oracle.quoteHype(asset, amount);
        if (expected == 0 || observedAt == 0 || observedAt > block.timestamp
            || block.timestamp - observedAt > maxPriceAge) revert StalePrice();
        uint256 floor = Math.mulDiv(expected, 10_000 - maxSlippageBps, 10_000);
        minHype = Math.max(minHype, floor);
        (uint256 rate, bool valid) = vault.currentRate();
        if (!valid || (extraYield && vault.state().totalPrincipalShares == 0)) revert InvalidConversion();
        epochOf[asset] = epoch;
        spentInEpoch[asset] = spent + amount;
        uint256 inputBefore = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(asset).balanceOf(address(this)) != inputBefore + amount) revert InvalidConversion();
        uint256 beforeWrapped = IERC20(wrappedHype).balanceOf(address(this));
        IERC20(asset).forceApprove(address(router), amount);
        router.exactInput(IStakingSwapRouter.ExactInputParams(paths[asset], address(this), deadline, amount, minHype));
        IERC20(asset).forceApprove(address(router), 0);
        if (IERC20(asset).balanceOf(address(this)) != inputBefore) revert InvalidConversion();
        uint256 bought = IERC20(wrappedHype).balanceOf(address(this)) - beforeWrapped;
        if (bought < minHype) revert OutputTooLow();
        uint256 nativeBefore = address(this).balance;
        IWrappedHype(wrappedHype).withdraw(bought);
        if (address(this).balance != nativeBefore + bought) revert InvalidConversion();
        IERC20 khype = vault.khype();
        uint256 beforeKHYPE = khype.balanceOf(address(this));
        IKinetiqStaking(stakingManager).stake{value: bought}();
        received = khype.balanceOf(address(this)) - beforeKHYPE;
        uint256 stakeFloor = Math.mulDiv(Math.mulDiv(bought, 1e18, rate), 10_000 - maxSlippageBps, 10_000);
        if (received < minKHYPE || received < stakeFloor || address(this).balance != nativeBefore) revert OutputTooLow();
        khype.forceApprove(address(vault), received);
        uint256 shares;
        if (extraYield) vault.donate(received);
        else shares = vault.deposit(received, 1);
        khype.forceApprove(address(vault), 0);
        if (khype.balanceOf(address(this)) != beforeKHYPE) revert InvalidConversion();
        totalHypeBought += bought;
        totalKHYPEReceived += received;
        emit Converted(msg.sender, asset, amount, bought, received, extraYield, shares);
    }

    /// @notice The owner redeems only the protocol's own shares, including for
    /// listing standby. User shares and the extra-yield leg cannot be withdrawn.
    function redeemProtocol(uint256 shares, uint256 minKHYPE) external onlyOwner nonReentrant {
        if (extraYield) revert InvalidConversion();
        uint256 amount = vault.redeem(shares, minKHYPE);
        vault.khype().safeTransfer(owner, amount);
        emit ProtocolRedeemed(shares, amount, owner);
    }
}

/// @notice One of the two automated fee custody legs. Owner sweeps retain the
/// existing Treasury boundary. The separate keeper can only use its fixed
/// converter; it cannot select a recipient, venue or route. No swap runs in a hook.
contract StakingFeeTreasury is Treasury {
    using SafeERC20 for IERC20;
    StakingFeeConverter public immutable converter;

    constructor(address owner_, StakingFeeConverter converter_) Treasury(owner_) {
        if (address(converter_).code.length == 0 || converter_.owner() != owner_) revert Unauthorized();
        converter = converter_;
    }

    function convert(address asset, uint256 amount, uint256 minHype, uint256 minKHYPE, uint256 deadline) external {
        if (msg.sender != converter.executor()) revert Unauthorized();
        IERC20(asset).forceApprove(address(converter), amount);
        converter.convert(asset, amount, minHype, minKHYPE, deadline);
        IERC20(asset).forceApprove(address(converter), 0);
        emit Swept(asset, address(converter), amount);
    }
}
