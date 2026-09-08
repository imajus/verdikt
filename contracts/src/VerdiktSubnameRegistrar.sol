// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DnsEncode} from "./DnsEncode.sol";
import {EnsNamehash} from "./EnsNamehash.sol";

interface ISubnameRegistry {
    function register(
        string calldata label,
        address owner,
        address registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256);
}

interface IAuthorizingResolver {
    function authorizeTextRoles(bytes calldata toName, string calldata key, address account, bool grant)
        external
        returns (bool);
    function setAddr(bytes32 node, address addr_) external;
}

/// @title VerdiktSubnameRegistrar
/// @notice Permissionless `<slug>.verdikt.eth` onboarding (Specification.md §4,
///         Tasks.md 5.3 stretch 1 — provider self-serve).
///
/// @dev **Why this contract can do what only the operator could do before.**
///      `scripts/onboard-service.mjs` mints a subname, grants `sla`/`url` to
///      the provider and `conformance`/`availability` to the score writer, and
///      sets the address record — four EAC-gated calls, run by a human holding
///      the `verdikt.eth` operator key. Verified against the live Sepolia
///      bytecode (Sourcify, chain 11155111): `PermissionedRegistry.register`
///      requires `ROLE_REGISTRAR` at `ROOT_RESOURCE` (`RegistryRolesLib.sol`),
///      and `PermissionedResolver.authorizeTextRoles`/`setAddr` resolve
///      through `EnhancedAccessControl`'s root-resource fallback — an account
///      holding a role at `ROOT_RESOURCE` holds it on every name. So a
///      contract granted those same two root roles (once, by the operator, via
///      `scripts/grant-registrar-roles.mjs`) can run the onboarding sequence
///      for any slug, for anyone, without holding a key of theirs and without
///      a human in the loop.
///
///      **The two ACL bypasses Spike A found stay closed.** Role bitmap `0` for
///      the claimant — never `ROLE_SET_RESOLVER`, which would let a provider
///      repoint its own subname at a resolver it controls and forge
///      `conformance`. Per-key `authorizeTextRoles`, never name-wide
///      `authorizeNameRoles`, which would grant the provider every text key at
///      once, ratios included.
///
///      **What this contract cannot do.** It cannot write `sla`, `url`,
///      `conformance` or `availability` itself — it only grants the *roles* to
///      write them, to the claimant and the score writer respectively. It never
///      touches Arc: registering the service there is a separate transaction
///      the claimant signs themselves against `VerdiktRegistry.register`, and
///      the proxy refuses to route a slug whose ENS owner and Arc provider
///      disagree (`proxy/src/challenge.js`'s `checkOwnership`) — a claim here
///      with no matching Arc registration is inert, not a working service.
contract VerdiktSubnameRegistrar {
    ISubnameRegistry public immutable SUBNAME_REGISTRY;
    IAuthorizingResolver public immutable RESOLVER;
    address public immutable SCORE_WRITER;
    bytes32 public immutable PARENT_NODE;
    uint64 public immutable DURATION_SECONDS;

    /// @dev Set once in the constructor from `parentName`. Not `immutable`:
    ///      Solidity immutables are value types only, and DNS wire format is
    ///      dynamic `bytes`. `claim` reads it once per call — not a hot path.
    bytes private _parentDnsSuffix;

    error EmptySlug();
    error InvalidSlug(string slug);
    error ZeroPayTo();

    /// @notice A slug was claimed: subname minted, `sla`/`url` granted to the
    ///         claimant, `conformance`/`availability` granted to the score
    ///         writer, and the address record set to `payTo`.
    event SubnameClaimed(string slug, bytes32 indexed node, address indexed claimant, address payTo);

    constructor(
        address subnameRegistry,
        address resolver,
        address scoreWriter,
        string memory parentName,
        uint64 durationSeconds
    ) {
        require(subnameRegistry != address(0), "subnameRegistry=0");
        require(resolver != address(0), "resolver=0");
        require(scoreWriter != address(0), "scoreWriter=0");
        require(durationSeconds > 0, "duration=0");
        SUBNAME_REGISTRY = ISubnameRegistry(subnameRegistry);
        RESOLVER = IAuthorizingResolver(resolver);
        SCORE_WRITER = scoreWriter;
        PARENT_NODE = EnsNamehash.namehash(parentName);
        DURATION_SECONDS = durationSeconds;
        _parentDnsSuffix = DnsEncode.dnsEncode(parentName);
    }

    /// @notice Claim `<slug>.verdikt.eth`: mint it to the caller with no
    ///         resolver control, grant per-key write access, and set the
    ///         payout address.
    /// @dev Reverts with the registry's own `LabelAlreadyRegistered` if the
    ///      slug is taken — nothing here needs to re-check that first.
    /// @param slug the label. Same charset `VerdiktRegistry._assertValidSlug`
    ///        enforces, since one slug is also the Arc serviceId.
    /// @param payTo the address a payer's x402 payment should reach. Usually
    ///        `msg.sender`, but kept separate so a claimant can route payment
    ///        to a different wallet without controlling the subname from it.
    /// @return node the subname's ENS namehash.
    function claim(string calldata slug, address payTo) external returns (bytes32 node) {
        _assertValidSlug(slug);
        if (payTo == address(0)) revert ZeroPayTo();

        bytes memory dnsName = _dnsNameFor(slug);
        node = keccak256(abi.encodePacked(PARENT_NODE, keccak256(bytes(slug))));

        // Role bitmap 0: the claimant gets the token and nothing else — never
        // ROLE_SET_RESOLVER (Spike A bypass #1).
        SUBNAME_REGISTRY.register(
            slug, msg.sender, address(0), address(RESOLVER), 0, uint64(block.timestamp) + DURATION_SECONDS
        );

        // Per key, never name-wide (Spike A bypass #2).
        RESOLVER.authorizeTextRoles(dnsName, "sla", msg.sender, true);
        RESOLVER.authorizeTextRoles(dnsName, "url", msg.sender, true);
        RESOLVER.authorizeTextRoles(dnsName, "conformance", SCORE_WRITER, true);
        RESOLVER.authorizeTextRoles(dnsName, "availability", SCORE_WRITER, true);
        RESOLVER.setAddr(node, payTo);

        emit SubnameClaimed(slug, node, msg.sender, payTo);
    }

    /// @notice The DNS wire-format name `authorizeTextRoles` takes for
    ///         `slug.<parentName>`. Exposed so a caller — or a test — can
    ///         recompute the exact bytes `claim` used, without re-deriving the
    ///         encoding itself.
    function dnsNameFor(string calldata slug) external view returns (bytes memory) {
        _assertValidSlug(slug);
        return _dnsNameFor(slug);
    }

    function _dnsNameFor(string calldata slug) private view returns (bytes memory) {
        bytes calldata raw = bytes(slug);
        return abi.encodePacked(bytes1(uint8(raw.length)), raw, _parentDnsSuffix);
    }

    /// @dev Mirrors `VerdiktRegistry._assertValidSlug` exactly: one slug is
    ///      also the Arc serviceId, so a slug this accepts must be exactly the
    ///      one Arc registration would accept too.
    function _assertValidSlug(string calldata slug) private pure {
        bytes calldata raw = bytes(slug);
        if (raw.length == 0) revert EmptySlug();
        if (raw.length > 63) revert InvalidSlug(slug);
        if (raw[0] == "-" || raw[raw.length - 1] == "-") revert InvalidSlug(slug);
        for (uint256 i = 0; i < raw.length; ++i) {
            bytes1 c = raw[i];
            bool ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-";
            if (!ok) revert InvalidSlug(slug);
        }
    }
}
