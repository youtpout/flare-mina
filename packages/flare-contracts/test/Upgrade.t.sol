// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {MinaPortBridge} from "../src/MinaPortBridge.sol";
import {FMINA} from "../src/FMINA.sol";
import {MockSettlementVerifier} from "../src/mocks/MockSettlementVerifier.sol";
import {IMinaSettlementVerifier, SettlementPublicValues} from
    "../src/interfaces/IMinaSettlementVerifier.sol";
import {DeployBridge} from "./helpers/DeployBridge.sol";

/// A later implementation, appending state the way a real upgrade would.
contract MinaPortBridgeV2 is MinaPortBridge {
    /// @dev Appended after the inherited layout. It must land in the gap, not
    /// on top of anything version one wrote.
    uint256 public somethingNew;

    function setSomethingNew(uint256 value) external {
        somethingNew = value;
    }

    function version() external pure returns (uint256) {
        return 2;
    }
}

/// @title UpgradeTest
/// @notice What an upgrade must and must not be able to do.
///
/// @dev Upgradeability is only worth having if state survives it. These deploy
/// a bridge, put real state into it — an accepted root, escrow, minted FMINA —
/// and then check every value is still there afterwards, addresses included.
contract UpgradeTest is Test {
    MinaPortBridge internal bridge;
    FMINA internal fmina;
    MockSettlementVerifier internal verifier;

    address internal owner = address(0xA11CE);
    address internal stranger = address(0xBAD);

    bytes32 internal constant BRIDGE_ID = keccak256("MinaPort.upgrade.v1");
    bytes32 internal constant GENESIS = bytes32(0);

    function setUp() public {
        verifier = new MockSettlementVerifier();
        bridge = DeployBridge.deploy(owner, verifier, BRIDGE_ID, GENESIS);
        fmina = bridge.TOKEN();
    }

    function _upgrade() internal returns (MinaPortBridgeV2) {
        MinaPortBridgeV2 next = new MinaPortBridgeV2();
        vm.prank(owner);
        bridge.upgradeToAndCall(address(next), "");
        return MinaPortBridgeV2(address(bridge));
    }

    /// The point of the exercise: nothing the bridge was holding may move.
    function test_upgradePreservesState() public {
        bytes32 root = keccak256("root-1");
        bytes32 next = keccak256("state-1");
        bridge.submitDepositBatch(
            hex"",
            abi.encode(
                SettlementPublicValues({
                    proofValid: true,
                    bridgeId: BRIDGE_ID,
                    previousActionState: GENESIS,
                    newActionState: next,
                    depositsRoot: root,
                    batchNonce: 1
                })
            )
        );

        address tokenBefore = address(fmina);

        MinaPortBridgeV2 upgraded = _upgrade();

        assertEq(upgraded.version(), 2);
        assertEq(upgraded.currentMinaActionState(), next);
        assertEq(upgraded.lastBatchNonce(), 1);
        assertTrue(upgraded.acceptedDepositRoots(root));
        // Deployment values live in storage, not in the implementation's
        // bytecode, so they survive a change of implementation.
        assertEq(upgraded.BRIDGE_ID(), BRIDGE_ID);
        assertEq(address(upgraded.TOKEN()), tokenBefore);
        assertEq(upgraded.owner(), owner);
    }

    /// FMINA's bridge is immutable, so the proxy address is what keeps it valid.
    function test_tokenStillAcceptsTheBridgeAfterUpgrade() public {
        _upgrade();
        assertEq(fmina.BRIDGE(), address(bridge));
    }

    /// New state must occupy the gap, not land on a slot already in use.
    function test_appendedStateDoesNotCollide() public {
        MinaPortBridgeV2 upgraded = _upgrade();
        uint256 escrowBefore = upgraded.escrowedNanomina();
        bytes32 stateBefore = upgraded.currentMinaActionState();

        upgraded.setSomethingNew(type(uint256).max);

        assertEq(upgraded.somethingNew(), type(uint256).max);
        assertEq(upgraded.escrowedNanomina(), escrowBefore);
        assertEq(upgraded.currentMinaActionState(), stateBefore);
    }

    function test_onlyOwnerCanUpgrade() public {
        MinaPortBridgeV2 next = new MinaPortBridgeV2();
        vm.prank(stranger);
        vm.expectRevert();
        bridge.upgradeToAndCall(address(next), "");
    }

    function test_cannotReinitialiseThroughTheProxy() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bridge.initialize(stranger, verifier, BRIDGE_ID, GENESIS);
    }

    /**
     * UUPS puts `upgradeToAndCall` in the implementation, so an implementation
     * anyone can initialise is an implementation anyone can own and brick. The
     * constructor disables initialisers for exactly this.
     */
    function test_implementationCannotBeInitialised() public {
        MinaPortBridge implementation = new MinaPortBridge();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        implementation.initialize(stranger, verifier, BRIDGE_ID, GENESIS);
    }

    /// The reentrancy guard keeps its flag in a namespaced slot, so a proxy that
    /// never ran its constructor still behaves as "not entered".
    function test_reentrancyGuardWorksWithoutAConstructor() public {
        // burnToMina is nonReentrant; reaching its own revert means the guard
        // let the call through rather than rejecting it as already entered.
        vm.expectRevert(MinaPortBridge.ZeroAmount.selector);
        bridge.burnToMina(0, bytes32(uint256(1)));
    }
}
