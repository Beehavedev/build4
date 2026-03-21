// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
