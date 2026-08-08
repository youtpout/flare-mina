// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AssetVault, IWNat} from "../src/AssetVault.sol";
import {BridgeWrapper} from "../src/BridgeWrapper.sol";
import {TransferChain} from "../src/TransferChain.sol";
import {MinaSchnorr} from "../src/libraries/MinaSchnorr.sol";
import {SignaturePurpose} from "../src/libraries/SignaturePurpose.sol";

/// @dev WNat as the vault uses it: an 18-decimal ERC-20 over the native token.
contract MockWNat is ERC20 {
    constructor() ERC20("Wrapped C2FLR", "WC2FLR") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "native transfer failed");
    }
}

contract ReleaseToken is ERC20 {
    constructor() ERC20("Release", "REL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev The return leg: a burn on Mina releases the locked asset on Flare.
///
/// A 2-of-2, exactly like the inbound rail. The holder's Schnorr signature names
/// the token, the recipient and the amount; the attestor asserts the burn
/// happened. These tests are mostly about what each half CANNOT do alone —
/// which is what makes an attested path acceptable at all.
contract MinaSignatureReleaseTest is Test {
    AssetVault internal vault;
    TransferChain internal chain;
    ReleaseToken internal token;

    uint256 internal constant CHAIN_ID = 114;
    uint256 internal attestorPk = 0xB0E5;
    address internal attestor;
    address internal owner = address(0xA11CE);
    address internal recipient = address(0xBEEF);
    address internal user = address(0xCAFE);

    uint256 internal constant LOCKED = 10_000_000;
    uint256 internal constant AMOUNT = 2_000_000;
    uint256 internal constant CAP = 5_000_000;

    bytes32 internal constant MINA_RECIPIENT =
        bytes32(uint256(14124943907817976952427102951112060621286297402986099085035387890279416817272));

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
        attestor = vm.addr(attestorPk);

        vault = AssetVault(
            payable(
                new TransparentUpgradeableProxy(
                    address(new AssetVault()),
                    owner,
                    abi.encodeCall(AssetVault.initialize, (owner))
                )
            )
        );
        chain = new TransferChain(owner);
        token = new ReleaseToken();
        token.mint(user, LOCKED);

        vm.startPrank(owner);
        vault.setTransferChain(chain);
        vault.setAccepted(address(token), true);
        chain.setAppender(address(vault), address(token), true);
        vault.setBurnAttestor(attestor);
        vault.setMaxAttestedRelease(address(token), CAP);
        vm.stopPrank();

        // Something to release: the asset has to be in the vault first.
        vm.startPrank(user);
        token.approve(address(vault), type(uint256).max);
        vault.lock(address(token), LOCKED, MINA_RECIPIENT);
        vm.stopPrank();
    }

    /// @dev A real Mina signature over the vault's own intent encoding.
    function _signRelease(address to, uint256 amount, uint64 nonce)
        internal
        returns (Signed memory)
    {
        bytes32 action =
            keccak256(abi.encode(vault.RELEASE_INTENT_DOMAIN(), address(token), to, amount));

        string[] memory a = new string[](8);
        a[0] = "node";
        a[1] = "../shared/tools/signAuthorization.mjs";
        a[2] = "--action";
        a[3] = vm.toString(SignaturePurpose.WITHDRAWAL_INTENT);
        a[4] = vm.toString(address(vault));
        a[5] = vm.toString(action);
        a[6] = vm.toString(uint256(nonce));
        a[7] = vm.toString(CHAIN_ID);

        return abi.decode(vm.parseJson(string(vm.ffi(a))), (Signed));
    }

    function _attest(bytes32 minaKey, address to, uint256 amount, uint64 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 intent = keccak256(
            abi.encode(
                vault.RELEASE_INTENT_DOMAIN(), CHAIN_ID, minaKey, address(token), to, amount, nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(attestorPk, MessageHashUtils.toEthSignedMessageHash(intent));
        return abi.encodePacked(r, s, v);
    }

    function _release(
        Signed memory sig,
        address to,
        uint256 amount,
        uint64 nonce,
        bytes memory att
    ) internal {
        vault.releaseWithMinaSignature(
            MinaSchnorr.PublicKey(uint256(sig.pkX), sig.isOdd, uint256(sig.pkY)),
            MinaSchnorr.Signature(uint256(sig.sigR), uint256(sig.sigS)),
            address(token),
            to,
            amount,
            nonce,
            type(uint64).max,
            att
        );
    }

    function test_releasesWhenBothHalvesAgree() public {
        Signed memory sig = _signRelease(recipient, AMOUNT, 0);
        bytes memory att = _attest(sig.minaKey, recipient, AMOUNT, 0);

        _release(sig, recipient, AMOUNT, 0, att);

        assertEq(token.balanceOf(recipient), AMOUNT);
        assertEq(vault.lockedOf(address(token)), LOCKED - AMOUNT, "the debit must match the payout");
        assertTrue(vault.isSolvent(address(token)));
    }

    /// @dev The property the trust assumption rests on: a compromised attestor
    /// can sign for a burn that never happened, but it cannot redirect one.
    function test_theAttestorCannotRedirectARelease() public {
        Signed memory sig = _signRelease(recipient, AMOUNT, 0);
        address thief = address(0xDEAD);
        bytes memory att = _attest(sig.minaKey, thief, AMOUNT, 0);

        vm.expectRevert(AssetVault.InvalidMinaSignature.selector);
        _release(sig, thief, AMOUNT, 0, att);
    }

    /// @dev Nor resize one: the amount is inside what the holder signed.
    function test_theAttestorCannotResizeARelease() public {
        Signed memory sig = _signRelease(recipient, AMOUNT, 0);
        bytes memory att = _attest(sig.minaKey, recipient, AMOUNT * 2, 0);

        vm.expectRevert(AssetVault.InvalidMinaSignature.selector);
        _release(sig, recipient, AMOUNT * 2, 0, att);
    }

    /// @dev And the holder cannot release without the attestor: a signature is
    /// intent, not evidence that anything was burned on Mina.
    function test_theHolderCannotReleaseAlone() public {
        Signed memory sig = _signRelease(recipient, AMOUNT, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, keccak256("nonsense"));

        vm.expectRevert(AssetVault.InvalidAttestation.selector);
        _release(sig, recipient, AMOUNT, 0, abi.encodePacked(r, s, v));
    }

    /// @dev Replay is what a nonce exists to stop — the same burn must not pay
    /// twice.
    function test_anIntentIsSpentOnce() public {
        Signed memory sig = _signRelease(recipient, AMOUNT, 0);
        bytes memory att = _attest(sig.minaKey, recipient, AMOUNT, 0);
        _release(sig, recipient, AMOUNT, 0, att);

        vm.expectRevert();
        _release(sig, recipient, AMOUNT, 0, att);
    }

    /// @dev The ceiling is what bounds a compromised attestor. It is per token
    /// and starts at zero, so a token is opted into this path deliberately.
    function test_refusesAboveTheCap() public {
        uint256 tooMuch = CAP + 1;
        Signed memory sig = _signRelease(recipient, tooMuch, 0);
        bytes memory att = _attest(sig.minaKey, recipient, tooMuch, 0);

        vm.expectRevert(
            abi.encodeWithSelector(AssetVault.ReleaseAboveCap.selector, address(token), tooMuch, CAP)
        );
        _release(sig, recipient, tooMuch, 0, att);
    }

    function test_aTokenIsOptedInDeliberately() public {
        vm.prank(owner);
        vault.setMaxAttestedRelease(address(token), 0);

        Signed memory sig = _signRelease(recipient, AMOUNT, 0);
        bytes memory att = _attest(sig.minaKey, recipient, AMOUNT, 0);

        vm.expectRevert(
            abi.encodeWithSelector(AssetVault.ReleaseAboveCap.selector, address(token), AMOUNT, 0)
        );
        _release(sig, recipient, AMOUNT, 0, att);
    }

    /// @dev The native asset goes home as itself. It only crossed as a
    /// 9-decimal wrapper because `UInt64` caps 18 decimals at ~18 whole tokens,
    /// and handing that wrapper back would leave the holder with an accounting
    /// artefact rather than the C2FLR they bridged.
    function test_theNativeAssetIsUnwrappedOnTheWayBack() public {
        MockWNat wnat = new MockWNat();
        BridgeWrapper wrapper = new BridgeWrapper(IERC20(address(wnat)));

        vm.prank(owner);
        vault.setNativeRoute(IWNat(address(wnat)), wrapper);
        vm.startPrank(owner);
        vault.setAccepted(address(wrapper), true);
        chain.setAppender(address(vault), address(wrapper), true);
        vault.setMaxAttestedRelease(address(wrapper), type(uint256).max);
        vm.stopPrank();

        vm.deal(user, 5 ether);
        vm.prank(user);
        vault.lockNative{value: 2 ether}(MINA_RECIPIENT);

        // 2e18 underlying is 2e9 wrapper units, which is what Mina held.
        uint256 wrapped = 2e9;
        bytes32 action =
            keccak256(abi.encode(vault.RELEASE_INTENT_DOMAIN(), address(wrapper), recipient, wrapped));

        string[] memory a = new string[](8);
        a[0] = "node";
        a[1] = "../shared/tools/signAuthorization.mjs";
        a[2] = "--action";
        a[3] = vm.toString(SignaturePurpose.WITHDRAWAL_INTENT);
        a[4] = vm.toString(address(vault));
        a[5] = vm.toString(action);
        a[6] = vm.toString(uint256(0));
        a[7] = vm.toString(CHAIN_ID);
        Signed memory sig = abi.decode(vm.parseJson(string(vm.ffi(a))), (Signed));

        bytes32 intent = keccak256(
            abi.encode(
                vault.RELEASE_INTENT_DOMAIN(),
                CHAIN_ID,
                sig.minaKey,
                address(wrapper),
                recipient,
                wrapped,
                uint64(0)
            )
        );
        (uint8 v, bytes32 r, bytes32 sSig) =
            vm.sign(attestorPk, MessageHashUtils.toEthSignedMessageHash(intent));

        vault.releaseWithMinaSignature(
            MinaSchnorr.PublicKey(uint256(sig.pkX), sig.isOdd, uint256(sig.pkY)),
            MinaSchnorr.Signature(uint256(sig.sigR), uint256(sig.sigS)),
            address(wrapper),
            recipient,
            wrapped,
            0,
            type(uint64).max,
            abi.encodePacked(r, sSig, v)
        );

        assertEq(recipient.balance, 2 ether, "the round trip must return native C2FLR");
        assertEq(wrapper.balanceOf(recipient), 0, "and not the wrapper");
        assertEq(vault.lockedOf(address(wrapper)), 0);
    }

    /// @dev A release can never exceed what is actually held for that token, so
    /// even both halves together cannot make the vault insolvent.
    function test_cannotReleaseMoreThanIsLocked() public {
        vm.prank(owner);
        vault.setMaxAttestedRelease(address(token), type(uint256).max);

        uint256 tooMuch = LOCKED + 1;
        Signed memory sig = _signRelease(recipient, tooMuch, 0);
        bytes memory att = _attest(sig.minaKey, recipient, tooMuch, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                AssetVault.InsufficientLocked.selector, address(token), LOCKED, tooMuch
            )
        );
        _release(sig, recipient, tooMuch, 0, att);
    }
}
