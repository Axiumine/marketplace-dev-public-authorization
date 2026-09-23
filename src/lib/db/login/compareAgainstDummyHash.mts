import { compareHashAsync } from '@axiumine/koa-utils/lib/hash'

/**
 * A bcrypt hash of a fixed, never-issued password, generated once offline at the same cost factor
 * (`SALT_ROUNDS = 14`) every real `login.password` is stored at — so a compare against it costs the
 * same tens-of-milliseconds a real compare does. Nothing about it is secret: no caller-supplied
 * password is ever checked *for a match* against this value, only timed against it, so the plaintext
 * behind it and the salt bcrypt drew for it are both irrelevant. Swapping it for a different fixed
 * hash of the same cost changes nothing observable.
 */
const DUMMY_PASSWORD_HASH = '$2b$14$a/hyKqhGryzvbkfvT/5h3.UUO9aGXEmh3VlVVods6LdQXe6PJk/4q'

/**
 * Runs a bcrypt-14 compare that can never succeed, so the "no such account" branch of a `tryLogin*`
 * costs the same wall-clock time as the "wrong password" branch of the same function.
 *
 * ⚠️ **Closes a timing oracle the generic error message does not.** `throwUnauthorizedError()` already
 * answers "unknown email" and "wrong password" with the same message (RISK_REGISTER R20), but an
 * unknown email used to throw immediately while a known one always ran a real bcrypt compare first —
 * tens to hundreds of milliseconds apart, and measurable across the network. Calling this before
 * throwing on the unknown-email branch makes both branches pay the same bcrypt cost.
 *
 * @param password the caller-supplied plaintext; discarded once the (always-failing) compare returns
 */
export async function compareAgainstDummyHash(password: string): Promise<void> {
	await compareHashAsync(password, DUMMY_PASSWORD_HASH)
}
