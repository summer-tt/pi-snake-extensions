/**
 * pi-magpie — constants shared across the extension.
 *
 * The provider is deliberately called `magpie`, the id magpie itself writes
 * into pi's models.json when one of its models is picked there. Sharing the id
 * means magpie's static block composes over this live catalog; the extension
 * warns about that at startup instead of fighting magpie over the file.
 */

/** The pi provider id, and the prefix of every model id this extension adds. */
export const PROVIDER_ID = "magpie";

/** Display name for the provider in pi's UI. */
export const PROVIDER_NAME = "Magpie";

/** Where magpie's gateway listens unless it was told otherwise. */
export const DEFAULT_ROOT = "http://127.0.0.1:3425";

/** The token magpie hands agents for a loopback gateway; any token is accepted there. */
export const DEFAULT_TOKEN = "magpie";

/** Credential env holding the gateway root, set by `/login magpie`. */
export const ROOT_ENV = "MAGPIE_GW_URL";

/** Footer status key. */
export const STATUS_KEY = "magpie";

/** Fallbacks for a catalog entry that reports no limits (pi requires both). */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

/**
 * How long a footer reading stands when two triggers arrive together (a model
 * switch and a run's end, say). The footer is otherwise re-read on demand:
 * `?kept=1` asks no vendor, so there is no reason to hold a reading longer.
 */
export const STATUS_TTL_MS = 3_000;

/**
 * How old magpie's own quota reading may get before the footer has magpie read
 * the vendors again. The footer otherwise reads what magpie already read
 * (`?kept=1`), which asks no vendor at all; only a reading this old is worth a
 * full read, and no more than one in this long.
 */
export const STALE_READING_MS = 900_000;
