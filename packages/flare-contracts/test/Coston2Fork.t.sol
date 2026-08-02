// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {MinaAccount, MinaAccountFactory} from "../src/MinaAccount.sol";
import {MinaAuthRegistry} from "../src/MinaAuthRegistry.sol";
import {MinaSchnorr} from "../src/libraries/MinaSchnorr.sol";

/// @dev Runs the full flow against forked Coston2 state, so the numbers reflect
/// the real chain's gas schedule and block limit rather than Foundry's defaults.
///
/// Skipped automatically when `COSTON2_RPC_URL` is unset, so `forge test` stays
/// green offline. Run it with:
///
///   COSTON2_RPC_URL=https://coston2-api.flare.network/ext/C/rpc forge test \
///     --match-contract Coston2Fork -vv
contract Coston2ForkTest is Test {
    uint256 internal constant COSTON2_CHAIN_ID = 114;

    /// @notice Coston2's block gas limit, asserted against the live chain.
    uint256 internal constant EXPECTED_BLOCK_GAS_LIMIT = 28_000_000;

    MinaAuthRegistry internal registry;
    MinaAccountFactory internal factory;
    MinaAccount internal account;
    bytes32 internal minaKey;

    bool internal forked;

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
        string memory rpc = vm.envOr("COSTON2_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);
        forked = true;

        registry = new MinaAuthRegistry();
        factory = new MinaAccountFactory(address(registry));

        Signed memory bootstrap = _sign(address(0), address(0), 0, "", 0);
        minaKey = bootstrap.minaKey;
        account = MinaAccount(payable(factory.accountOf(minaKey)));
    }

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
        argv[7] = vm.toString(COSTON2_CHAIN_ID);

        return abi.decode(vm.parseJson(string(vm.ffi(argv))), (Signed));
    }

    /// @dev Confirms we are on the chain we think we are, and that a
    /// verification is a sane fraction of a block.
    function test_chainParameters() public view {
        if (!forked) return;

        assertEq(block.chainid, COSTON2_CHAIN_ID, "not Coston2");
        assertEq(block.gaslimit, EXPECTED_BLOCK_GAS_LIMIT, "block gas limit changed");

        console.log("chain id        :", block.chainid);
        console.log("block gas limit :", block.gaslimit);
        console.log("base fee (wei)  :", block.basefee);
    }

    /// @dev The whole point, executed against real chain state: a Mina key
    /// moves native value on Coston2 with no EVM key and no proof.
    function test_minaKeyControlsAccountOnCoston2() public {
        if (!forked) return;

        factory.deploy(minaKey);
        vm.deal(address(account), 1 ether);

        address recipient = address(0xBEEF);
        Signed memory s = _sign(address(account), recipient, 0.25 ether, "", 0);

        uint256 before = gasleft();
        account.execute(
            MinaSchnorr.PublicKey(uint256(s.pkX), s.isOdd, uint256(s.pkY)),
            MinaSchnorr.Signature(uint256(s.sigR), uint256(s.sigS)),
            0,
            type(uint64).max,
            recipient,
            0.25 ether,
            ""
        );
        uint256 used = before - gasleft();

        assertEq(recipient.balance, 0.25 ether);
        assertEq(registry.nextNonce(minaKey), 1);

        console.log("execute gas on Coston2 fork :", used);
        console.log("percent of a block          :", (used * 100) / block.gaslimit);
        console.log("cost in wei                 :", used * block.basefee);

        assertLt(used, block.gaslimit / 4, "must be well under a quarter of a block");
    }
}
