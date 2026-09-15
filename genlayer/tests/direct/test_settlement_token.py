"""The settlement token: minting, transfer, and the escrow that backs a bond."""

from tests.direct.conftest import to_hex


def test_mint_is_permissionless(direct_vm, token, direct_alice):
    direct_vm.sender = direct_alice
    token.mint(5000)
    assert token.balance_of(to_hex(direct_alice)) == 5000
    assert token.get_info()['total_supply'] == 5000


def test_mint_is_capped(direct_vm, token, direct_alice):
    """A faucet, not an economy: one call must not make every other balance meaningless."""
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert('exceeds'):
        token.mint(10**18)


def test_mint_refuses_nonpositive(direct_vm, token, direct_alice):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert('must be positive'):
        token.mint(0)


def test_transfer_moves_balance(direct_vm, token, direct_alice, direct_bob):
    direct_vm.sender = direct_alice
    token.mint(5000)
    token.transfer(to_hex(direct_bob), 2000)
    assert token.balance_of(to_hex(direct_alice)) == 3000
    assert token.balance_of(to_hex(direct_bob)) == 2000


def test_transfer_refuses_more_than_held(direct_vm, token, direct_alice, direct_bob):
    direct_vm.sender = direct_alice
    token.mint(100)
    with direct_vm.expect_revert('Insufficient'):
        token.transfer(to_hex(direct_bob), 101)


class TestEscrow:
    """Escrow hands a custodian the authority to move a balance, not the balance."""

    def test_escrowing_leaves_the_balance_where_it_is(self, direct_vm, token, direct_alice, direct_bob):
        direct_vm.sender = direct_alice
        token.mint(5000)
        token.escrow(to_hex(direct_bob), 1000)

        assert token.balance_of(to_hex(direct_alice)) == 5000
        assert token.escrow_of(to_hex(direct_alice), to_hex(direct_bob)) == 1000
        assert token.available_of(to_hex(direct_alice)) == 4000

    # The point of the whole mechanism: a bond that could be spent elsewhere
    # while a claim is open is not a bond.
    def test_escrowed_funds_cannot_be_transferred_away(self, direct_vm, token, direct_alice, direct_bob, direct_charlie):
        direct_vm.sender = direct_alice
        token.mint(5000)
        token.escrow(to_hex(direct_bob), 4000)

        token.transfer(to_hex(direct_charlie), 1000)
        with direct_vm.expect_revert('Insufficient'):
            token.transfer(to_hex(direct_charlie), 1)

    def test_escrowing_more_than_is_free_refuses(self, direct_vm, token, direct_alice, direct_bob):
        direct_vm.sender = direct_alice
        token.mint(1000)
        token.escrow(to_hex(direct_bob), 600)
        with direct_vm.expect_revert('Insufficient'):
            token.escrow(to_hex(direct_bob), 500)

    def test_the_custodian_can_release_to_anyone(self, direct_vm, token, direct_alice, direct_bob, direct_charlie):
        direct_vm.sender = direct_alice
        token.mint(5000)
        token.escrow(to_hex(direct_bob), 1000)

        direct_vm.sender = direct_bob
        token.release(to_hex(direct_alice), to_hex(direct_charlie), 400)

        assert token.balance_of(to_hex(direct_alice)) == 4600
        assert token.balance_of(to_hex(direct_charlie)) == 400
        assert token.escrow_of(to_hex(direct_alice), to_hex(direct_bob)) == 600

    def test_a_release_back_to_the_owner_is_how_funds_come_home(self, direct_vm, token, direct_alice, direct_bob):
        """There is no owner-side unescrow; the custodian returning it is the only way out."""
        direct_vm.sender = direct_alice
        token.mint(5000)
        token.escrow(to_hex(direct_bob), 1000)

        direct_vm.sender = direct_bob
        token.release(to_hex(direct_alice), to_hex(direct_alice), 1000)

        assert token.balance_of(to_hex(direct_alice)) == 5000
        assert token.available_of(to_hex(direct_alice)) == 5000

    def test_nobody_but_the_custodian_can_release(self, direct_vm, token, direct_alice, direct_bob, direct_charlie):
        direct_vm.sender = direct_alice
        token.mint(5000)
        token.escrow(to_hex(direct_bob), 1000)

        direct_vm.sender = direct_charlie
        with direct_vm.expect_revert('Escrow holds only 0'):
            token.release(to_hex(direct_alice), to_hex(direct_charlie), 1000)

    # Including the owner: if an owner could pull an escrow back unilaterally, a
    # consumer could withdraw its bond the moment a claim went against it.
    def test_the_owner_cannot_release_its_own_escrow(self, direct_vm, token, direct_alice, direct_bob):
        direct_vm.sender = direct_alice
        token.mint(5000)
        token.escrow(to_hex(direct_bob), 1000)

        with direct_vm.expect_revert('Escrow holds only 0'):
            token.release(to_hex(direct_alice), to_hex(direct_alice), 1000)

    def test_releasing_more_than_is_escrowed_refuses(self, direct_vm, token, direct_alice, direct_bob):
        direct_vm.sender = direct_alice
        token.mint(5000)
        token.escrow(to_hex(direct_bob), 1000)

        direct_vm.sender = direct_bob
        with direct_vm.expect_revert('Escrow holds only 1000'):
            token.release(to_hex(direct_alice), to_hex(direct_bob), 1001)

    def test_escrows_to_different_custodians_are_independent(self, direct_vm, token, direct_alice, direct_bob, direct_charlie):
        direct_vm.sender = direct_alice
        token.mint(5000)
        token.escrow(to_hex(direct_bob), 1000)
        token.escrow(to_hex(direct_charlie), 2000)

        assert token.escrow_of(to_hex(direct_alice), to_hex(direct_bob)) == 1000
        assert token.escrow_of(to_hex(direct_alice), to_hex(direct_charlie)) == 2000
        assert token.available_of(to_hex(direct_alice)) == 2000
