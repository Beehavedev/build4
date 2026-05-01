// Sources flattened with hardhat v2.28.6 https://hardhat.org

// SPDX-License-Identifier: MIT

// File @openzeppelin/contracts/utils/Context.sol@v5.4.0

// OpenZeppelin Contracts (last updated v5.0.1) (utils/Context.sol)

pragma solidity ^0.8.20;

/**
 * @dev Provides information about the current execution context, including the
 * sender of the transaction and its data. While these are generally available
 * via msg.sender and msg.data, they should not be accessed in such a direct
 * manner, since when dealing with meta-transactions the account sending and
 * paying for execution may not be the actual sender (as far as an application
 * is concerned).
 *
 * This contract is only required for intermediate, library-like contracts.
 */
abstract contract Context {
    function _msgSender() internal view virtual returns (address) {
        return msg.sender;
    }

    function _msgData() internal view virtual returns (bytes calldata) {
        return msg.data;
    }

    function _contextSuffixLength() internal view virtual returns (uint256) {
        return 0;
    }
}


// File @openzeppelin/contracts/access/Ownable.sol@v5.4.0

// OpenZeppelin Contracts (last updated v5.0.0) (access/Ownable.sol)

pragma solidity ^0.8.20;

/**
 * @dev Contract module which provides a basic access control mechanism, where
 * there is an account (an owner) that can be granted exclusive access to
 * specific functions.
 *
 * The initial owner is set to the address provided by the deployer. This can
 * later be changed with {transferOwnership}.
 *
 * This module is used through inheritance. It will make available the modifier
 * `onlyOwner`, which can be applied to your functions to restrict their use to
 * the owner.
 */
abstract contract Ownable is Context {
    address private _owner;

    /**
     * @dev The caller account is not authorized to perform an operation.
     */
    error OwnableUnauthorizedAccount(address account);

    /**
     * @dev The owner is not a valid owner account. (eg. `address(0)`)
     */
    error OwnableInvalidOwner(address owner);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /**
     * @dev Initializes the contract setting the address provided by the deployer as the initial owner.
     */
    constructor(address initialOwner) {
        if (initialOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(initialOwner);
    }

    /**
     * @dev Throws if called by any account other than the owner.
     */
    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    /**
     * @dev Returns the address of the current owner.
     */
    function owner() public view virtual returns (address) {
        return _owner;
    }

    /**
     * @dev Throws if the sender is not the owner.
     */
    function _checkOwner() internal view virtual {
        if (owner() != _msgSender()) {
            revert OwnableUnauthorizedAccount(_msgSender());
        }
    }

    /**
     * @dev Leaves the contract without owner. It will not be possible to call
     * `onlyOwner` functions. Can only be called by the current owner.
     *
     * NOTE: Renouncing ownership will leave the contract without an owner,
     * thereby disabling any functionality that is only available to the owner.
     */
    function renounceOwnership() public virtual onlyOwner {
        _transferOwnership(address(0));
    }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`).
     * Can only be called by the current owner.
     */
    function transferOwnership(address newOwner) public virtual onlyOwner {
        if (newOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(newOwner);
    }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`).
     * Internal function without access restriction.
     */
    function _transferOwnership(address newOwner) internal virtual {
        address oldOwner = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}


// File @openzeppelin/contracts/utils/ReentrancyGuard.sol@v5.4.0

// OpenZeppelin Contracts (last updated v5.1.0) (utils/ReentrancyGuard.sol)

pragma solidity ^0.8.20;

/**
 * @dev Contract module that helps prevent reentrant calls to a function.
 *
 * Inheriting from `ReentrancyGuard` will make the {nonReentrant} modifier
 * available, which can be applied to functions to make sure there are no nested
 * (reentrant) calls to them.
 *
 * Note that because there is a single `nonReentrant` guard, functions marked as
 * `nonReentrant` may not call one another. This can be worked around by making
 * those functions `private`, and then adding `external` `nonReentrant` entry
 * points to them.
 *
 * TIP: If EIP-1153 (transient storage) is available on the chain you're deploying at,
 * consider using {ReentrancyGuardTransient} instead.
 *
 * TIP: If you would like to learn more about reentrancy and alternative ways
 * to protect against it, check out our blog post
 * https://blog.openzeppelin.com/reentrancy-after-istanbul/[Reentrancy After Istanbul].
 */
abstract contract ReentrancyGuard {
    // Booleans are more expensive than uint256 or any type that takes up a full
    // word because each write operation emits an extra SLOAD to first read the
    // slot's contents, replace the bits taken up by the boolean, and then write
    // back. This is the compiler's defense against contract upgrades and
    // pointer aliasing, and it cannot be disabled.

    // The values being non-zero value makes deployment a bit more expensive,
    // but in exchange the refund on every call to nonReentrant will be lower in
    // amount. Since refunds are capped to a percentage of the total
    // transaction's gas, it is best to keep them low in cases like this one, to
    // increase the likelihood of the full refund coming into effect.
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    uint256 private _status;

    /**
     * @dev Unauthorized reentrant call.
     */
    error ReentrancyGuardReentrantCall();

    constructor() {
        _status = NOT_ENTERED;
    }

    /**
     * @dev Prevents a contract from calling itself, directly or indirectly.
     * Calling a `nonReentrant` function from another `nonReentrant`
     * function is not supported. It is possible to prevent this from happening
     * by making the `nonReentrant` function external, and making it call a
     * `private` function that does the actual work.
     */
    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    function _nonReentrantBefore() private {
        // On the first call to nonReentrant, _status will be NOT_ENTERED
        if (_status == ENTERED) {
            revert ReentrancyGuardReentrantCall();
        }

        // Any calls to nonReentrant after this point will fail
        _status = ENTERED;
    }

    function _nonReentrantAfter() private {
        // By storing the original value once again, a refund is triggered (see
        // https://eips.ethereum.org/EIPS/eip-2200)
        _status = NOT_ENTERED;
    }

    /**
     * @dev Returns true if the reentrancy guard is currently set to "entered", which indicates there is a
     * `nonReentrant` function in the call stack.
     */
    function _reentrancyGuardEntered() internal view returns (bool) {
        return _status == ENTERED;
    }
}


// File contracts/web4/BUILD4Staking.sol

pragma solidity ^0.8.24;


interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract BUILD4Staking is Ownable, ReentrancyGuard {

    IERC20 public stakingToken;

    uint256 public constant MIN_LOCK_PERIOD = 7 days;
    uint256 public constant MAX_LOCK_PERIOD = 365 days;

    uint256 public totalStaked;
    uint256 public totalRewardsDistributed;
    uint256 public rewardRate;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;

    struct StakeInfo {
        uint256 amount;
        uint256 lockEnd;
        uint256 lockDuration;
        uint256 rewardDebt;
        uint256 pendingRewards;
        uint256 stakedAt;
    }

    mapping(address => StakeInfo) public stakes;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    uint256 public totalStakers;

    uint256 public constant LOCK_7D_MULTIPLIER = 100;
    uint256 public constant LOCK_30D_MULTIPLIER = 125;
    uint256 public constant LOCK_90D_MULTIPLIER = 175;
    uint256 public constant LOCK_180D_MULTIPLIER = 250;
    uint256 public constant LOCK_365D_MULTIPLIER = 400;

    event Staked(address indexed user, uint256 amount, uint256 lockDuration);
    event Unstaked(address indexed user, uint256 amount);
    event RewardClaimed(address indexed user, uint256 reward);
    event RewardAdded(uint256 reward);
    event TokenSet(address indexed token);

    constructor() Ownable(msg.sender) {}

    function setStakingToken(address _token) external onlyOwner {
        require(address(stakingToken) == address(0), "Token already set");
        stakingToken = IERC20(_token);
        emit TokenSet(_token);
    }

    function getMultiplier(uint256 lockDuration) public pure returns (uint256) {
        if (lockDuration >= 365 days) return LOCK_365D_MULTIPLIER;
        if (lockDuration >= 180 days) return LOCK_180D_MULTIPLIER;
        if (lockDuration >= 90 days) return LOCK_90D_MULTIPLIER;
        if (lockDuration >= 30 days) return LOCK_30D_MULTIPLIER;
        return LOCK_7D_MULTIPLIER;
    }

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = block.timestamp;
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + (
            (block.timestamp - lastUpdateTime) * rewardRate * 1e18 / totalStaked
        );
    }

    function earned(address account) public view returns (uint256) {
        StakeInfo storage info = stakes[account];
        uint256 multiplier = getMultiplier(info.lockDuration);
        return (
            (info.amount * (rewardPerToken() - userRewardPerTokenPaid[account]) * multiplier / 100) / 1e18
        ) + rewards[account];
    }

    function stake(uint256 amount, uint256 lockDuration) external nonReentrant updateReward(msg.sender) {
        require(address(stakingToken) != address(0), "Token not set");
        require(amount > 0, "Cannot stake 0");
        require(lockDuration >= MIN_LOCK_PERIOD, "Lock too short");
        require(lockDuration <= MAX_LOCK_PERIOD, "Lock too long");
        require(stakes[msg.sender].amount == 0, "Already staking, unstake first");

        stakingToken.transferFrom(msg.sender, address(this), amount);

        if (stakes[msg.sender].amount == 0) {
            totalStakers++;
        }

        stakes[msg.sender] = StakeInfo({
            amount: amount,
            lockEnd: block.timestamp + lockDuration,
            lockDuration: lockDuration,
            rewardDebt: 0,
            pendingRewards: 0,
            stakedAt: block.timestamp
        });

        totalStaked += amount;
        emit Staked(msg.sender, amount, lockDuration);
    }

    function unstake() external nonReentrant updateReward(msg.sender) {
        StakeInfo storage info = stakes[msg.sender];
        require(info.amount > 0, "Nothing staked");
        require(block.timestamp >= info.lockEnd, "Still locked");

        uint256 amount = info.amount;
        totalStaked -= amount;
        totalStakers--;

        uint256 reward = rewards[msg.sender];
        rewards[msg.sender] = 0;
        info.amount = 0;

        stakingToken.transfer(msg.sender, amount);
        if (reward > 0) {
            stakingToken.transfer(msg.sender, reward);
            totalRewardsDistributed += reward;
            emit RewardClaimed(msg.sender, reward);
        }

        emit Unstaked(msg.sender, amount);
    }

    function claimRewards() external nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        require(reward > 0, "No rewards");
        rewards[msg.sender] = 0;
        stakingToken.transfer(msg.sender, reward);
        totalRewardsDistributed += reward;
        emit RewardClaimed(msg.sender, reward);
    }

    function addRewards(uint256 amount, uint256 duration) external onlyOwner updateReward(address(0)) {
        require(duration > 0, "Duration must be > 0");
        stakingToken.transferFrom(msg.sender, address(this), amount);
        rewardRate = amount / duration;
        lastUpdateTime = block.timestamp;
        emit RewardAdded(amount);
    }

    function getStakeInfo(address user) external view returns (
        uint256 stakedAmount,
        uint256 lockEnd,
        uint256 lockDuration,
        uint256 pendingReward,
        uint256 multiplier,
        uint256 stakedAt
    ) {
        StakeInfo storage info = stakes[user];
        return (
            info.amount,
            info.lockEnd,
            info.lockDuration,
            earned(user),
            getMultiplier(info.lockDuration),
            info.stakedAt
        );
    }

    function getGlobalStats() external view returns (
        uint256 _totalStaked,
        uint256 _totalStakers,
        uint256 _totalRewardsDistributed,
        uint256 _rewardRate
    ) {
        return (totalStaked, totalStakers, totalRewardsDistributed, rewardRate);
    }
}
