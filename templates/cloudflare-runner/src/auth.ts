/** The shortest secret the runner starts with: anything less is a guess away. */
export const SECRET_MIN = 16

/** Whether a secret is one to check requests against. A Worker deployed without one has `undefined` here. */
export const usable = (secret: unknown): secret is string => typeof secret === 'string' && secret.length >= SECRET_MIN

/**
 * Whether a request carries the runner's secret. With no secret set nothing passes: comparing against a
 * string built from one that isn't there would accept the literal text "Bearer undefined" from anyone.
 * Both sides are hashed first, so the comparison takes the same time whatever was sent.
 */
export async function authorized(header: string | null, secret: unknown): Promise<boolean> {
  if (!usable(secret) || header === null) return false
  const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  const [given, wanted] = await Promise.all([digest(header), digest(`Bearer ${secret}`)])
  let differ = 0
  for (let i = 0; i < wanted.length; i++) differ |= given[i]! ^ wanted[i]!
  return differ === 0
}
