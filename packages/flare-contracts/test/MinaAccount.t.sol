// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {MinaAccount, MinaAccountFactory} from "../src/MinaAccount.sol";
import {MinaAuthRegistry} from "../src/MinaAuthRegistry.sol";
import {MinaSchnorr} from "../src/libraries/MinaSchnorr.sol";
import {SignaturePurpose} from "../src/libraries/SignaturePurpose.sol";

contract DemoToken {
    string public constant name = "Demo";
    mapping(address => uint256) public balanceOf;

    constructor(address to, uint256 amount) {
        balanceOf[to] = amount;
    }

    mapping(address => mapping(address => uint256)) public allowance;

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "not approved");
        require(balanceOf[from] >= amount, "insufficient");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function mintTo(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}

/// @dev A constant-product pool, standing in for whatever DEX the user picks.
/// The account has no idea what this is, which is the point.
contract MiniDex {
    DemoToken public immutable IN_TOKEN;
    DemoToken public immutable OUT_TOKEN;

    constructor(DemoToken tokenIn, DemoToken tokenOut) {
        IN_TOKEN = tokenIn;
        OUT_TOKEN = tokenOut;
    }

    /// @dev Fixed 1:2 rate; the arithmetic is irrelevant to what is being tested.
    function swap(uint256 amountIn) external returns (uint256 amountOut) {
        require(IN_TOKEN.transferFrom(msg.sender, address(this), amountIn), "pull failed");
        amountOut = amountIn * 2;
        require(OUT_TOKEN.transfer(msg.sender, amountOut), "pay failed");
    }
}

contract Reverter {
    error Nope();

    function boom() external pure {
        revert Nope();
    }
}

/// @dev The headline scenario: a Mina wallet moves ERC-20 tokens on Flare,
/// having never produced an ECDSA signature and never held an EVM key.
///
/// Signatures are produced at run time by `mina-signer` through FFI, so the
/// on-chain verifier is tested against the reference library rather than
/// against constants that could silently drift from it.
contract MinaAccountTest is Test {
    MinaAuthRegistry internal registry;
    MinaAccountFactory internal factory;
    MinaAccount internal account;
    DemoToken internal token;

    uint256 internal constant CHAIN_ID = 114; // Coston2
    address internal constant RECIPIENT = address(0xBEEF);
    uint256 internal constant BALANCE = 1_000_000_000_000;
    uint256 internal constant TRANSFER = 250_000_000_000;

    bytes32 internal minaKey;

    struct Signed {
        bytes32 actionHash;
        bool isOdd;
        bytes32 minaKey;
        bytes32 pkX;
        bytes32 pkY;
        bytes32 sigR;
        bytes32 sigS;
    }

    function setUp() public {
        vm.chainId(CHAIN_ID);
        registry = new MinaAuthRegistry();
        factory = new MinaAccountFactory(address(registry));

        // The Mina key is known before anything is deployed.
        Signed memory bootstrap = _sign(address(0), address(0), 0, "", 0);
        minaKey = bootstrap.minaKey;

        account = MinaAccount(payable(factory.accountOf(minaKey)));
        token = new DemoToken(address(account), BALANCE);
    }

    /// @dev Invoke `mina-signer` for a real signature over this exact action.
    function _sign(
        address forAccount,
        address target,
        uint256 value,
        bytes memory data,
        uint64 nonce
    ) internal returns (Signed memory) {
        string[] memory argv = new string[](9);
        argv[0] = "node";
        argv[1] = "../shared/tools/signAuthorization.mjs";
        argv[2] = vm.toString(SignaturePurpose.ACCOUNT_CALL);
        argv[3] = vm.toString(forAccount);
        argv[4] = vm.toString(target);
        argv[5] = vm.toString(value);
        argv[6] = vm.toString(data);
        argv[7] = vm.toString(uint256(nonce));
        argv[8] = vm.toString(CHAIN_ID);

        bytes memory out = vm.ffi(argv);
        return abi.decode(vm.parseJson(string(out)), (Signed));
    }

    function _key(Signed memory s) internal pure returns (MinaSchnorr.PublicKey memory) {
        return MinaSchnorr.PublicKey(uint256(s.pkX), s.isOdd, uint256(s.pkY));
    }

    function _sig(Signed memory s) internal pure returns (MinaSchnorr.Signature memory) {
        return MinaSchnorr.Signature(uint256(s.sigR), uint256(s.sigS));
    }

    function _transferCall() internal pure returns (bytes memory) {
        return abi.encodeCall(DemoToken.transfer, (RECIPIENT, TRANSFER));
    }

    // -------------------------------------------------------------------------
    // Address derivation
    // -------------------------------------------------------------------------

    /// @dev A Mina key has a Flare address before any transaction happens, so
    /// the frontend can show it and the bridge can mint to it immediately.
    function test_addressIsKnownBeforeDeployment() public view {
        address predicted = factory.accountOf(minaKey);
        assertTrue(predicted != address(0));
        assertFalse(factory.isDeployed(minaKey), "must not be deployed yet");
    }

    function test_deployLandsAtPredictedAddress() public {
        address predicted = factory.accountOf(minaKey);
        MinaAccount deployed = factory.deploy(minaKey);

        assertEq(address(deployed), predicted);
        assertTrue(factory.isDeployed(minaKey));
        assertEq(deployed.MINA_KEY(), minaKey);
    }

    /// @dev Deployment is permissionless: the key determines the address, so a
    /// third party front-running the deployment changes nothing.
    function test_deploymentIsPermissionless() public {
        vm.prank(address(0xDEAD));
        MinaAccount deployed = factory.deploy(minaKey);
        assertEq(deployed.MINA_KEY(), minaKey);
    }

    // -------------------------------------------------------------------------
    // Execution
    // -------------------------------------------------------------------------

    function test_minaKeyMovesTokensOnFlare() public {
        factory.deploy(minaKey);

        Signed memory s = _sign(address(account), address(token), 0, _transferCall(), 0);

        // Submitted by an unrelated account: the signature is the authorisation.
        vm.prank(address(0xDEAD));
        account.execute(
            _key(s), _sig(s), 0, type(uint64).max, address(token), 0, _transferCall()
        );

        assertEq(token.balanceOf(RECIPIENT), TRANSFER, "recipient must be paid");
        assertEq(token.balanceOf(address(account)), BALANCE - TRANSFER);
        assertEq(registry.nextNonce(minaKey), 1, "nonce must advance");
    }

    function test_rejectsReplay() public {
        factory.deploy(minaKey);
        Signed memory s = _sign(address(account), address(token), 0, _transferCall(), 0);

        account.execute(_key(s), _sig(s), 0, type(uint64).max, address(token), 0, _transferCall());

        vm.expectRevert(
            abi.encodeWithSelector(
                MinaAuthRegistry.UnexpectedNonce.selector, minaKey, uint64(1), uint64(0)
            )
        );
        account.execute(_key(s), _sig(s), 0, type(uint64).max, address(token), 0, _transferCall());
    }

    /// @dev The submitter cannot redirect the call: target, value and calldata
    /// are all committed to by `actionHash` inside the signed message.
    function test_rejectsSwappedCalldata() public {
        factory.deploy(minaKey);
        Signed memory s = _sign(address(account), address(token), 0, _transferCall(), 0);

        bytes memory stolen = abi.encodeCall(DemoToken.transfer, (address(0xDEAD), BALANCE));

        vm.expectRevert(MinaAuthRegistry.InvalidSignature.selector);
        account.execute(_key(s), _sig(s), 0, type(uint64).max, address(token), 0, stolen);
    }

    function test_rejectsSwappedTarget() public {
        factory.deploy(minaKey);
        Signed memory s = _sign(address(account), address(token), 0, _transferCall(), 0);

        DemoToken other = new DemoToken(address(account), BALANCE);

        vm.expectRevert(MinaAuthRegistry.InvalidSignature.selector);
        account.execute(_key(s), _sig(s), 0, type(uint64).max, address(other), 0, _transferCall());
    }

    /// @dev An authorization signed for one account must not drive another,
    /// even though the signature itself is valid.
    function test_rejectsAuthorizationForAnotherAccount() public {
        factory.deploy(minaKey);
        Signed memory s = _sign(address(0xABCD), address(token), 0, _transferCall(), 0);

        vm.expectRevert(MinaAuthRegistry.InvalidSignature.selector);
        account.execute(_key(s), _sig(s), 0, type(uint64).max, address(token), 0, _transferCall());
    }

    function test_bubblesUpCallFailure() public {
        factory.deploy(minaKey);
        Reverter reverter = new Reverter();
        bytes memory data = abi.encodeCall(Reverter.boom, ());
        Signed memory s = _sign(address(account), address(reverter), 0, data, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                MinaAccount.CallFailed.selector, abi.encodeWithSelector(Reverter.Nope.selector)
            )
        );
        account.execute(_key(s), _sig(s), 0, type(uint64).max, address(reverter), 0, data);
    }

    function test_canSendNativeValue() public {
        factory.deploy(minaKey);
        vm.deal(address(account), 5 ether);

        Signed memory s = _sign(address(account), RECIPIENT, 1 ether, "", 0);

        account.execute(_key(s), _sig(s), 0, type(uint64).max, RECIPIENT, 1 ether, "");

        assertEq(RECIPIENT.balance, 1 ether);
        assertEq(address(account).balance, 4 ether);
    }

    function test_gas_execute() public {
        factory.deploy(minaKey);
        Signed memory s = _sign(address(account), address(token), 0, _transferCall(), 0);

        uint256 before = gasleft();
        account.execute(_key(s), _sig(s), 0, type(uint64).max, address(token), 0, _transferCall());
        uint256 used = before - gasleft();
        console.log("MinaAccount.execute, ERC-20 transfer, total gas:", used);
        assertGt(used, 0);
    }

    // -------------------------------------------------------------------------
    // Batched execution: the swap path
    // -------------------------------------------------------------------------

    /// @dev Sign an ordered batch of calls with the real Mina key.
    function _signBatch(address forAccount, uint64 nonce, MinaAccount.Call[] memory calls)
        internal
        returns (Signed memory)
    {
        string[] memory full = new string[](7 + calls.length * 3);
        full[0] = "node";
        full[1] = "../shared/tools/signAuthorization.mjs";
        full[2] = "--batch";
        full[3] = vm.toString(SignaturePurpose.ACCOUNT_BATCH);
        full[4] = vm.toString(forAccount);
        full[5] = vm.toString(uint256(nonce));
        full[6] = vm.toString(CHAIN_ID);
        for (uint256 i; i < calls.length; ++i) {
            full[7 + i * 3] = vm.toString(calls[i].target);
            full[8 + i * 3] = vm.toString(calls[i].value);
            full[9 + i * 3] = vm.toString(calls[i].data);
        }

        return abi.decode(vm.parseJson(string(vm.ffi(full))), (Signed));
    }

    /// @dev The headline swap scenario: approve and swap under ONE Mina
    /// signature. Without batching this is two signatures, two nonces, two
    /// transactions, and a live approval sitting between them.
    function test_approveAndSwapUnderOneSignature() public {
        factory.deploy(minaKey);

        DemoToken tokenOut = new DemoToken(address(0), 0);
        MiniDex dex = new MiniDex(token, tokenOut);
        tokenOut.mintTo(address(dex), BALANCE);

        uint256 amountIn = 100_000_000_000;

        MinaAccount.Call[] memory calls = new MinaAccount.Call[](2);
        calls[0] = MinaAccount.Call({
            target: address(token),
            value: 0,
            data: abi.encodeCall(DemoToken.approve, (address(dex), amountIn))
        });
        calls[1] = MinaAccount.Call({
            target: address(dex),
            value: 0,
            data: abi.encodeCall(MiniDex.swap, (amountIn))
        });

        Signed memory s = _signBatch(address(account), 0, calls);

        // Submitted by an unrelated account.
        vm.prank(address(0xDEAD));
        account.executeBatch(_key(s), _sig(s), 0, type(uint64).max, calls);

        assertEq(tokenOut.balanceOf(address(account)), amountIn * 2, "swap output");
        assertEq(token.balanceOf(address(account)), BALANCE - amountIn);
        assertEq(registry.nextNonce(minaKey), 1, "one nonce for the whole batch");
    }

    /// @dev Order is part of the commitment: swapping before approving is a
    /// different authorisation, and the signature must not cover it.
    function test_rejectsReorderedBatch() public {
        factory.deploy(minaKey);

        DemoToken tokenOut = new DemoToken(address(0), 0);
        MiniDex dex = new MiniDex(token, tokenOut);
        tokenOut.mintTo(address(dex), BALANCE);

        MinaAccount.Call[] memory calls = new MinaAccount.Call[](2);
        calls[0] = MinaAccount.Call({
            target: address(token),
            value: 0,
            data: abi.encodeCall(DemoToken.approve, (address(dex), 1))
        });
        calls[1] = MinaAccount.Call({
            target: address(dex),
            value: 0,
            data: abi.encodeCall(MiniDex.swap, (1))
        });

        Signed memory s = _signBatch(address(account), 0, calls);

        MinaAccount.Call[] memory reordered = new MinaAccount.Call[](2);
        reordered[0] = calls[1];
        reordered[1] = calls[0];

        vm.expectRevert(MinaAuthRegistry.InvalidSignature.selector);
        account.executeBatch(_key(s), _sig(s), 0, type(uint64).max, reordered);
    }

    /// @dev A failure anywhere reverts the whole batch, so a granted approval
    /// cannot survive a failed swap.
    function test_batchIsAtomic() public {
        factory.deploy(minaKey);
        Reverter reverter = new Reverter();

        MinaAccount.Call[] memory calls = new MinaAccount.Call[](2);
        calls[0] = MinaAccount.Call({
            target: address(token),
            value: 0,
            data: abi.encodeCall(DemoToken.approve, (address(0xDEAD), type(uint256).max))
        });
        calls[1] = MinaAccount.Call({
            target: address(reverter),
            value: 0,
            data: abi.encodeCall(Reverter.boom, ())
        });

        Signed memory s = _signBatch(address(account), 0, calls);

        vm.expectRevert();
        account.executeBatch(_key(s), _sig(s), 0, type(uint64).max, calls);

        assertEq(token.allowance(address(account), address(0xDEAD)), 0, "approval must not survive");
    }

    /// @dev A single-call batch and a lone call are different statements; a
    /// signature for one must not authorise the other.
    function test_batchIsDomainSeparatedFromSingleCall() public {
        factory.deploy(minaKey);

        MinaAccount.Call[] memory calls = new MinaAccount.Call[](1);
        calls[0] = MinaAccount.Call({
            target: address(token),
            value: 0,
            data: _transferCall()
        });

        Signed memory s = _signBatch(address(account), 0, calls);

        vm.expectRevert(MinaAuthRegistry.InvalidSignature.selector);
        account.execute(_key(s), _sig(s), 0, type(uint64).max, address(token), 0, _transferCall());
    }

    function test_rejectsEmptyBatch() public {
        factory.deploy(minaKey);
        MinaAccount.Call[] memory empty = new MinaAccount.Call[](0);
        Signed memory s = _sign(address(account), address(token), 0, _transferCall(), 0);

        vm.expectRevert(MinaAccount.EmptyBatch.selector);
        account.executeBatch(_key(s), _sig(s), 0, type(uint64).max, empty);
    }

    function test_gas_approveAndSwapBatch() public {
        factory.deploy(minaKey);

        DemoToken tokenOut = new DemoToken(address(0), 0);
        MiniDex dex = new MiniDex(token, tokenOut);
        tokenOut.mintTo(address(dex), BALANCE);

        MinaAccount.Call[] memory calls = new MinaAccount.Call[](2);
        calls[0] = MinaAccount.Call({
            target: address(token),
            value: 0,
            data: abi.encodeCall(DemoToken.approve, (address(dex), 1_000_000))
        });
        calls[1] = MinaAccount.Call({
            target: address(dex),
            value: 0,
            data: abi.encodeCall(MiniDex.swap, (1_000_000))
        });

        Signed memory s = _signBatch(address(account), 0, calls);

        uint256 before = gasleft();
        account.executeBatch(_key(s), _sig(s), 0, type(uint64).max, calls);
        uint256 used = before - gasleft();
        console.log("approve + swap under one Mina signature, total gas:", used);
        assertGt(used, 0);
    }
}
