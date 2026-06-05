// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AnalysisCreditVault
/// @notice Testnet-only demo vault for buying AI analysis credits with Mantle Sepolia test MNT.
contract AnalysisCreditVault {
    address public owner;
    bool public paused;
    uint256 public creditsPerMnt;

    mapping(address => uint256) private credits;

    event Deposited(address indexed user, uint256 amount, uint256 creditsAdded);
    event CreditConsumed(address indexed user, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event CreditRateChanged(uint256 creditsPerMnt);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "AnalysisCreditVault: caller is not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "AnalysisCreditVault: paused");
        _;
    }

    constructor(uint256 initialCreditsPerMnt) {
        require(initialCreditsPerMnt > 0, "AnalysisCreditVault: zero rate");
        owner = msg.sender;
        creditsPerMnt = initialCreditsPerMnt;
        emit OwnershipTransferred(address(0), msg.sender);
        emit CreditRateChanged(initialCreditsPerMnt);
    }

    function deposit() public payable whenNotPaused {
        require(msg.value > 0, "AnalysisCreditVault: zero deposit");

        uint256 creditsAdded = (msg.value * creditsPerMnt) / 1 ether;
        require(creditsAdded > 0, "AnalysisCreditVault: deposit too small");

        credits[msg.sender] += creditsAdded;
        emit Deposited(msg.sender, msg.value, creditsAdded);
    }

    receive() external payable {
        deposit();
    }

    function creditsOf(address user) external view returns (uint256) {
        return credits[user];
    }

    function consumeCredit(address user, uint256 amount) external onlyOwner {
        require(user != address(0), "AnalysisCreditVault: zero user");
        require(amount > 0, "AnalysisCreditVault: zero amount");
        require(credits[user] >= amount, "AnalysisCreditVault: insufficient credits");

        credits[user] -= amount;
        emit CreditConsumed(user, amount);
    }

    function setCreditRate(uint256 newCreditsPerMnt) external onlyOwner {
        require(newCreditsPerMnt > 0, "AnalysisCreditVault: zero rate");
        creditsPerMnt = newCreditsPerMnt;
        emit CreditRateChanged(newCreditsPerMnt);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "AnalysisCreditVault: zero recipient");
        require(amount <= address(this).balance, "AnalysisCreditVault: insufficient balance");

        (bool sent, ) = to.call{value: amount}("");
        require(sent, "AnalysisCreditVault: withdraw failed");
        emit Withdrawn(to, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "AnalysisCreditVault: zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
