# marketplace-dev-public-authorization

The only way into the platform. Port **4028**, endpoint `/public-authorization`, and the one service that
turns an email and a password into a session. It is on the **public** tier because a caller who is not yet
logged in has no other tier to be on.

## Three logins, not one

| Mutation | Collection | Session tier |
|---|---|---|
| `login` | `shopOwner` | ShopOwner |
| `loginAdmin` | `admin` | Admin |
| `loginUser` | `user` | User |

⚠️ **This is the concrete shape of ADR-002.** There is no `role` field anywhere on this platform, and no
permission enum — a role *is* the collection you authenticate against. Three mutations exist here because
there are three collections, and each writes its own `tier` value into the Redis session
(`setRedisLoginSessionShopOwner` / `…Admin` / `…User`). Collapsing them into one mutation with a `role`
argument would mean taking the caller's word for which collection to check, which is the whole thing the
split exists to prevent.

The halves stay in the same three shapes per tier: `tryLogin*` looks the account up in its own collection,
a `check*Authorization` compares the hash and runs the account-state gate, `update*LoginStats` records the
attempt, `setRedisLoginSession*` writes the session. A fifth role is a fifth collection and a fifth set of
these — not a branch inside the existing ones.

Not every half is duplicated, and where it isn't, that is deliberate. `checkUserAuthorization` is shared by
the **ShopOwner and User** paths because it takes an `IAuthorizationDisDel` rather than a model, so it was
already tier-agnostic; only `checkAdminAuthorization` is separate. Both end in the same shared
`checkUserAuthorizationDisDel` from `marketplace-common`.

## Gate order is a disclosure decision, not style

⚠️ **Every account-state gate runs *after* the password compare, in all three paths.** `deleted`,
`disabled` and — for `User` only — `emailVerify.valid` are checked once the hash already matched. An
account-state answer handed out before a password was supplied tells an attacker the address exists.
Hoisting one of those checks "to fail fast" turns this endpoint into a registration oracle.

Even after the password matches, every failure throws the same `throwUnauthorizedError`. That is why
`userVerifyEmailResend` exists on 4027: an unconfirmed customer cannot be told "confirm your email" here
without telling everyone else who is registered, so the login screen offers the resend unconditionally.

⚠️ **`waitApprov` is not a login gate.** The field is on `shopOwner` and an operator sets it, but nothing on
this path reads it — a shop owner awaiting approval logs in and gets a session. The integration suite in
`marketplace-dev-authenticated-authorization` asserts exactly that, so "fixing" the apparent omission here
fails a test that exists to pin the behaviour. `User` has no such field at all: customers self-serve.

`authPublicHello` is a liveness probe and stays.

## Related files

| Topic | File |
|---|---|
| rules for agents working in this repo | [`CLAUDE.md`](./CLAUDE.md) |
| git hooks, gate order, node selection | [`REPO.md`](./REPO.md) |
| the whole platform — tiers, ports, terminology | parent [`CLAUDE.md`](./CLAUDE.md) |

## License

GPL-3.0-or-later — see [LICENSE](./LICENSE).
