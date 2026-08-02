// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {MinaAccount, MinaAccountFactory} from "../src/MinaAccount.sol";
import {MinaAuthRegistry} from "../src/MinaAuthRegistry.sol";
import {MinaSchnorr} from "../src/libraries/MinaSchnorr.sol";

contract DemoToken {
    string public constant name = "Demo";
    mapping(address => uint256) public balanceOf;

    constructor(address to, uint256 amount) {
        balanceOf[to] = amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
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
        string[] memory argv = new string[](8);
        argv[0] = "node";
        argv[1] = "../shared/tools/signAuthorization.mjs";
        argv[2] = vm.toString(forAccount);
        argv[3] = vm.toString(target);
        argv[4] = vm.toString(value);
        argv[5] = vm.toString(data);
        argv[6] = vm.toString(uint256(nonce));
        argv[7] = vm.toString(CHAIN_ID);

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
}
