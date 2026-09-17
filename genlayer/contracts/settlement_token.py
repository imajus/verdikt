# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }
"""
The currency a semantic claim settles in.

Settling in the USDC the original x402 call was paid in *looked* required and
was not. What a claimant needs is that a judgment has a consequence the provider
feels; insisting the consequence be denominated in the asset of the original
payment bought a cross-chain trust model, a relay to run and fund, and finality
coupling between two chains with unrelated appeal semantics — for nothing.

So: a plain token, native to GenLayer, with a permissionless `mint` standing in
for a faucet. It is pegged to nothing, and `SlaClaimJudge` sizes compensation to
numerically match the original `paidAmount` only so the settlement is legible
next to the payment that provoked it.

See docs/roadmap/genlayer.md, "Settlement is GenLayer-native".
"""

import genlayer as gl

ERROR_EXPECTED = '[EXPECTED]'

# A faucet, not an economy. The cap exists so one call cannot mint a number
# large enough to make every other balance meaningless.
MINT_LIMIT = 1_000_000_000_000


class SettlementToken(gl.contract.Contract):
    name: str
    symbol: str
    total_supply: gl.u256
    balances: gl.storage.TreeMap[gl.Address, gl.u256]
    # owner -> custodian -> amount. Escrow is a one-way handoff of *authority*,
    # not of ownership: the balance still belongs to the owner and is still
    # counted as theirs, but only the custodian contract can move it. There is
    # deliberately no `unescrow` — see `release`.
    escrows: gl.storage.TreeMap[gl.Address, gl.storage.TreeMap[gl.Address, gl.u256]]

    def __init__(self, name: str, symbol: str):
        self.name = name
        self.symbol = symbol
        self.total_supply = gl.u256(0)

    # ------------------------------------------------------------------ writes

    @gl.public.write
    def mint(self, amount: int) -> None:
        """Permissionless, because this is a testnet faucet wearing a token's clothes."""
        if amount <= 0:
            raise gl.vm.UserError(f'{ERROR_EXPECTED} Mint amount must be positive')
        if amount > MINT_LIMIT:
            raise gl.vm.UserError(f'{ERROR_EXPECTED} Mint amount exceeds {MINT_LIMIT}')
        sender = gl.message.sender_address
        self.balances[sender] = gl.u256(self.balances.get(sender, 0) + amount)
        self.total_supply = gl.u256(self.total_supply + amount)

    @gl.public.write
    def transfer(self, to: str, amount: int) -> None:
        sender = gl.message.sender_address
        self._debit_free(sender, amount)
        recipient = gl.Address(to)
        self.balances[recipient] = gl.u256(self.balances.get(recipient, 0) + amount)

    @gl.public.write
    def escrow(self, custodian: str, amount: int) -> None:
        """
        Hand a custodian contract the authority to move some of your balance.

        This is how a consumer posts a claim bond and how a provider posts a
        deposit: both are "this much of mine is answerable to that contract's
        judgment". The tokens do not move and stay counted in your balance
        until the custodian actually releases them.
        """
        if amount <= 0:
            raise gl.vm.UserError(f'{ERROR_EXPECTED} Escrow amount must be positive')
        sender = gl.message.sender_address
        if self.balances.get(sender, 0) < self._escrowed_total(sender) + amount:
            raise gl.vm.UserError(f'{ERROR_EXPECTED} Insufficient unescrowed balance')
        held = self.escrows.get_or_insert_default(sender)
        custodian_address = gl.Address(custodian)
        held[custodian_address] = gl.u256(held.get(custodian_address, 0) + amount)

    @gl.public.write
    def release(self, owner: str, to: str, amount: int) -> None:
        """
        Move escrowed funds. Callable only by the custodian they were escrowed to.

        There is no owner-side `unescrow`, and that absence is the whole
        mechanism: if an owner could pull an escrow back unilaterally, a
        consumer could withdraw its bond the moment a claim started going
        against it and a provider could withdraw its deposit the moment one was
        filed. Getting funds back out means asking the custodian, which is what
        `SlaClaimJudge.withdraw_deposit` and the bond release on a settled claim
        are for.
        """
        if amount <= 0:
            raise gl.vm.UserError(f'{ERROR_EXPECTED} Release amount must be positive')
        custodian = gl.message.sender_address
        owner_address = gl.Address(owner)
        held = self.escrows.get_or_insert_default(owner_address)
        available = held.get(custodian, 0)
        if available < amount:
            raise gl.vm.UserError(f'{ERROR_EXPECTED} Escrow holds only {available}')
        held[custodian] = gl.u256(available - amount)
        self.balances[owner_address] = gl.u256(self.balances.get(owner_address, 0) - amount)
        recipient = gl.Address(to)
        self.balances[recipient] = gl.u256(self.balances.get(recipient, 0) + amount)

    # ------------------------------------------------------------------- views

    @gl.public.view
    def balance_of(self, account: str) -> int:
        return self.balances.get(gl.Address(account), 0)

    @gl.public.view
    def escrow_of(self, owner: str, custodian: str) -> int:
        return self.escrows.get_or_insert_default(gl.Address(owner)).get(gl.Address(custodian), 0)

    @gl.public.view
    def available_of(self, account: str) -> int:
        """Balance minus everything already answerable to some custodian."""
        address = gl.Address(account)
        return self.balances.get(address, 0) - self._escrowed_total(address)

    @gl.public.view
    def get_info(self) -> dict:
        return {'name': self.name, 'symbol': self.symbol, 'total_supply': self.total_supply}

    # ---------------------------------------------------------------- internals

    def _escrowed_total(self, owner: gl.Address) -> int:
        return sum(amount for _, amount in self.escrows.get_or_insert_default(owner).items())

    def _debit_free(self, sender: gl.Address, amount: int) -> None:
        if amount <= 0:
            raise gl.vm.UserError(f'{ERROR_EXPECTED} Transfer amount must be positive')
        free = self.balances.get(sender, 0) - self._escrowed_total(sender)
        if free < amount:
            raise gl.vm.UserError(f'{ERROR_EXPECTED} Insufficient unescrowed balance')
        self.balances[sender] = gl.u256(self.balances.get(sender, 0) - amount)
